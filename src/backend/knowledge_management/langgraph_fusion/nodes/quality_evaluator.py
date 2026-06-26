"""
检索质量评估节点
================
LLM 评估检索结果质量：coverage / relevance / specificity / missing_topics
质量不足时触发 query 重写重试。

支持 DeepEval 精确率 (Precision) / 召回率 (Recall) 评估（可选开启）。
"""

import logging
import json
import re
import time
import requests
from typing import Dict, Any

from ..state import FusionSearchState
from ..evaluation.deepeval_evaluator import evaluate_from_state, is_available

_logger = logging.getLogger("langgraph_fusion.quality_evaluator")

QUALITY_EVAL_SYSTEM_PROMPT = """你是一个检索质量评估专家。评估检索结果是否能够充分回答用户的问题。

输出严格的 JSON 格式（不要额外文字）:
{
    "coverage": 0.0-1.0,       # 覆盖面：检索结果覆盖了多少问题要点
    "relevance": 0.0-1.0,      # 相关性：结果与问题的相关程度
    "specificity": 0.0-1.0,    # 具体性：结果提供的信息是否足够具体
    "total_score": 0.0-1.0,    # 综合得分（推荐 = 0.4*coverage + 0.35*relevance + 0.25*specificity）
    "missing_topics": [],       # 缺失的主题列表
    "rewrite_suggestions": ""   # 如果需要重试，提供 query 改进建议
}

如果 total_score < 0.6，说明检索结果不足，需要在 rewrite_suggestions 中提供改进建议。"""


def _call_llm(prompt: str, llm_config: dict, system_prompt: str = "") -> str:
    """调用 LLM"""
    llm_url = llm_config.get("llm_url", "")
    llm_api_key = llm_config.get("llm_api_key", "")
    llm_model = llm_config.get("llm_model", "")

    if not llm_url:
        raise RuntimeError("LLM 未配置")

    chat_url = llm_url.rstrip("/")
    if not chat_url.endswith("/chat/completions"):
        chat_url += "/chat/completions"

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    headers = {"Content-Type": "application/json"}
    if llm_api_key:
        headers["Authorization"] = f"Bearer {llm_api_key}"

    body = {
        "model": llm_model,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 800,
    }

    resp = requests.post(chat_url, json=body, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _parse_eval_json(raw_text: str) -> dict:
    """解析评估 JSON"""
    text = raw_text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines)

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "coverage": 0.5,
            "relevance": 0.5,
            "specificity": 0.5,
            "total_score": 0.5,
            "missing_topics": [],
            "rewrite_suggestions": "",
        }


def _rule_based_eval(reranked: list, query: str) -> dict:
    """
    基于规则的快速评估（回退方案，LLM 不可用时使用）。
    """
    if not reranked:
        return {
            "coverage": 0.0,
            "relevance": 0.0,
            "specificity": 0.0,
            "total_score": 0.0,
            "missing_topics": ["no results"],
            "rewrite_suggestions": "no results found, try different keywords",
        }

    # 简单启发式
    avg_score = sum(r.get("rerank_score", r.get("rrf_score", 0.5)) for r in reranked) / len(reranked)
    result_count = len(reranked)

    coverage = min(result_count / 10.0, 1.0)  # 数量越多覆盖面越好
    relevance = avg_score
    specificity = min(sum(len(r.get("text", "")) for r in reranked) / len(reranked) / 500.0, 1.0)
    total = 0.4 * coverage + 0.35 * relevance + 0.25 * specificity

    return {
        "coverage": round(coverage, 2),
        "relevance": round(relevance, 2),
        "specificity": round(specificity, 2),
        "total_score": round(total, 2),
        "missing_topics": [] if total >= 0.6 else ["insufficient results"],
        "rewrite_suggestions": "" if total >= 0.6 else "Try rephrasing with different keywords",
    }


def quality_evaluator(state: FusionSearchState) -> dict:
    """
    质量评估节点入口。
    """
    t_start = time.time()
    query = state.get("user_query", "")
    reranked = state.get("reranked_results", [])
    llm_config = state.get("config", {}).get("llm_config", {})

    if not reranked:
        _logger.warning("quality_evaluator: no reranked results to evaluate")
        return {
            "quality_score": 0.0,
            "quality_assessment": {
                "total_score": 0.0,
                "missing_topics": ["no results"],
                "note": "empty results",
            },
        }

    # 构建候选摘要
    candidate_summaries = []
    for i, r in enumerate(reranked[:5]):
        text = r.get("text", "")[:200]
        source = r.get("source", "unknown")
        candidate_summaries.append(f"[{i + 1}] [source:{source}] {text}")

    candidate_text = "\n\n".join(candidate_summaries)
    eval_method = "rule"

    if llm_config.get("llm_url"):
        try:
            prompt = f"用户查询: {query}\n\n检索结果摘要:\n{candidate_text}"
            raw = _call_llm(prompt, llm_config, system_prompt=QUALITY_EVAL_SYSTEM_PROMPT)
            assessment = _parse_eval_json(raw)
            eval_method = "llm"
        except Exception as e:
            _logger.warning(f"LLM quality eval failed: {e}, using rule-based")
            assessment = _rule_based_eval(reranked, query)
    else:
        assessment = _rule_based_eval(reranked, query)

    total_score = assessment.get("total_score", 0.5)
    elapsed = time.time() - t_start
    _logger.info(
        f"Quality eval: score={total_score:.2f}, "
        f"coverage={assessment.get('coverage', 0):.2f}, "
        f"relevance={assessment.get('relevance', 0):.2f}, "
        f"missing={assessment.get('missing_topics', [])}, "
        f"method={eval_method}, elapsed={elapsed:.2f}s"
    )

    # ── DeepEval 精确率 / 召回率评估（可选） ──
    deepeval_result = None
    config = state.get("config", {})
    if config.get("use_deepeval") and is_available():
        _logger.info("Running DeepEval precision/recall evaluation...")
        try:
            deepeval_result = evaluate_from_state(
                state=state,
                ground_truth_contexts=config.get("ground_truth_contexts"),
                ground_truth_answer=config.get("ground_truth_answer"),
            )
            if deepeval_result.get("success"):
                metrics = deepeval_result.get("metrics", {})
                _logger.info(
                    f"DeepEval: precision={metrics.get('precision', {}).get('score', 'N/A')}, "
                    f"recall={metrics.get('recall', {}).get('score', 'N/A')}, "
                    f"relevancy={metrics.get('relevancy', {}).get('score', 'N/A')}, "
                    f"overall_passed={deepeval_result.get('overall_passed')}"
                )
            else:
                _logger.warning(f"DeepEval evaluation failed: {deepeval_result.get('error')}")
        except Exception as e:
            _logger.error(f"DeepEval evaluation error: {e}", exc_info=True)
            deepeval_result = {"success": False, "error": str(e)}
    elif config.get("use_deepeval") and not is_available():
        _logger.warning("DeepEval is enabled but package is not installed")

    return {
        "quality_score": total_score,
        "quality_assessment": assessment,
        "deepeval_result": deepeval_result,
    }
