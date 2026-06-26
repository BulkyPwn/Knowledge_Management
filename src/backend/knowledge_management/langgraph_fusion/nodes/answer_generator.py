"""
回答生成节点
============
基于融合排序后的 top-5 上下文生成最终回答。
"""

import logging
import json
import os
import time
import requests
from typing import List, Dict, Any

from ..state import FusionSearchState

_logger = logging.getLogger("langgraph_fusion.answer_generator")

ANSWER_GENERATION_SYSTEM_PROMPT = """你是一个知识问答专家。基于提供的检索上下文回答用户的问题。

回答要求:
1. 直接回答用户的问题，语言与用户问题一致
2. 如果上下文中有相关信息，请引用并综合
3. 如果上下文信息不足，请诚实说明并给出建议
4. 引用来源时使用格式: 【来源类型:文件名或标题】
5. 回答结构清晰，可使用分点列举

请输出纯文本回答，不要用 JSON 格式。"""


def _format_context(reranked_results: List[dict]) -> str:
    """
    将精排结果格式化为 LLM 上下文。

    Args:
        reranked_results: 精排结果列表

    Returns:
        格式化的上下文字符串
    """
    if not reranked_results:
        return "（无可用上下文）"

    parts = []
    for i, r in enumerate(reranked_results):
        text = r.get("text", "")
        source = r.get("source", "unknown")
        metadata = r.get("metadata", {})

        # 获取来源标识
        source_label = _get_source_label(source, metadata)

        parts.append(f"--- 文档 {i + 1} [{source_label}] ---\n{text}")

    return "\n\n".join(parts)


def _get_source_label(source: str, metadata: dict) -> str:
    """获取易读的来源标签"""
    file_path = metadata.get("file_path", "")
    title = metadata.get("title", "")

    if title:
        return title
    if file_path:
        # 取文件名
        import os
        return os.path.basename(file_path)

    source_labels = {
        "llama_index": "本地 Wiki",
        "raw_document": "原始文档",
        "wiki_entity": "Wiki 实体",
        "wiki_concept": "Wiki 概念",
        "graph_rag": "知识图谱",
        "hidesk": "HiDesk",
        "web": "Web 搜索",
    }
    return source_labels.get(source, source)


def _build_sources(reranked_results: List[dict]) -> List[dict]:
    """构建引用来源列表"""
    sources = []
    for r in reranked_results:
        metadata = r.get("metadata", {})
        sources.append({
            "text": r.get("text", "")[:200],
            "source": _get_source_label(r.get("source", "unknown"), metadata),
            "file_path": metadata.get("file_path", ""),
            "url": r.get("url", ""),
            "score": r.get("rerank_score", r.get("rrf_score", 0)),
            "reason": r.get("rerank_reason", ""),
        })
    return sources


def _call_llm_answer(prompt: str, llm_config: dict) -> str:
    """调用 LLM 生成回答"""
    llm_url = llm_config.get("llm_url", "")
    llm_api_key = llm_config.get("llm_api_key", "")
    llm_model = llm_config.get("llm_model", "")

    if not llm_url:
        raise RuntimeError("LLM 未配置")

    chat_url = llm_url.rstrip("/")
    if not chat_url.endswith("/chat/completions"):
        chat_url += "/chat/completions"

    messages = [
        {"role": "system", "content": ANSWER_GENERATION_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    headers = {"Content-Type": "application/json"}
    if llm_api_key:
        headers["Authorization"] = f"Bearer {llm_api_key}"

    body = {
        "model": llm_model,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 2000,
    }

    resp = requests.post(chat_url, json=body, headers=headers, timeout=120)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def answer_generator(state: FusionSearchState) -> dict:
    """
    回答生成节点入口。
    """
    t_start = time.time()
    query = state.get("user_query", "")
    reranked = state.get("reranked_results", [])
    llm_config = state.get("config", {}).get("llm_config", {})

    sources = _build_sources(reranked)

    if not reranked:
        _logger.warning("answer_generator: no results, returning empty answer")
        answer = "未找到与您查询相关的信息。请尝试更换关键词或检查知识库是否已索引。"
        return {"final_answer": answer, "final_sources": sources}

    context = _format_context(reranked)
    context_len = len(context)

    if not llm_config.get("llm_url"):
        _logger.warning("LLM not configured, returning raw results")
        summaries = []
        for i, r in enumerate(reranked[:3]):
            text = r.get("text", "")[:300]
            source = _get_source_label(r.get("source", "unknown"), r.get("metadata", {}))
            summaries.append(f"【{source}】{text}")
        answer = "根据检索结果，找到以下相关信息：\n\n" + "\n\n".join(summaries)
        elapsed = time.time() - t_start
        _logger.info(f"Answer (raw): {len(answer)} chars, {len(sources)} sources, elapsed={elapsed:.2f}s")
        return {"final_answer": answer, "final_sources": sources}

    prompt = f"用户问题: {query}\n\n检索上下文:\n{context}\n\n请基于以上上下文回答问题。"
    try:
        answer = _call_llm_answer(prompt, llm_config)
        elapsed = time.time() - t_start
        _logger.info(
            f"Answer generated: {len(answer)} chars, "
            f"context={context_len} chars, "
            f"{len(sources)} sources, "
            f"elapsed={elapsed:.2f}s"
        )
        return {"final_answer": answer, "final_sources": sources}
    except Exception as e:
        _logger.error(f"Answer generation failed: {e}")
        fallback = "\n\n".join([
            f"【{_get_source_label(r.get('source', 'unknown'), r.get('metadata', {}))}】{r.get('text', '')[:300]}"
            for r in reranked[:3]
        ])
        return {
            "final_answer": f"回答生成失败（{str(e)}），以下是原始检索结果：\n\n{fallback}",
            "final_sources": sources,
        }
