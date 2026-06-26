"""
融合排序节点
============
二阶段融合：
阶段 1: 加权 RRF (Reciprocal Rank Fusion) 粗排
阶段 2: LLM Reranker 精排（listwise）
"""

import logging
import json
import re
import time
import requests
from typing import List, Dict, Any

from ..state import FusionSearchState

_logger = logging.getLogger("langgraph_fusion.fusion_ranker")

# 各源权重
SOURCE_WEIGHTS = {
    "llama_index": 1.2,    # Wiki 页面质量最高
    "raw_document": 0.9,   # 原始文档
    "wiki_entity": 1.0,    # 实体页面
    "wiki_concept": 1.0,   # 概念页面
    "graph_rag": 0.8,      # 知识图谱
    "hidesk": 1.0,         # HiDesk
    "web": 0.7,            # Web
}

RRF_K = 60


def _collect_all_hits(state: FusionSearchState) -> tuple:
    """收集所有源的结果，统一格式。返回 (all_hits, source_counts)"""
    all_hits = []
    source_counts = {}

    for source_key, hits in [
        ("llama_index", state.get("llama_index_hits", [])),
        ("graph_rag", state.get("graph_rag_hits", [])),
        ("hidesk", state.get("hidesk_hits", [])),
        ("web", state.get("web_hits", [])),
    ]:
        count = 0
        for hit in (hits or []):
            if "source" not in hit:
                hit["source"] = source_key
            all_hits.append(hit)
            count += 1
        source_counts[source_key] = count

    return all_hits, source_counts


def _weighted_rrf(all_hits: List[dict], k: int = 60) -> List[dict]:
    """
    加权 Reciprocal Rank Fusion。

    公式: score(d) = Σ( w_source / (k + rank_in_source) )

    Args:
        all_hits: 所有源的结果
        k: RRF 常数

    Returns:
        按 RRF score 降序排列的结果
    """
    # 按 source 分组
    source_groups: Dict[str, List[dict]] = {}
    for hit in all_hits:
        source = hit.get("source", "unknown")
        if source not in source_groups:
            source_groups[source] = []
        source_groups[source].append(hit)

    # 计算 RRF 分数
    scores: Dict[int, float] = {}  # 用 index in all_hits 做 key
    hit_index_map: Dict[int, dict] = {}

    for source, hits in source_groups.items():
        # 按原始分数降序排列
        hits.sort(key=lambda x: x.get("score", 0), reverse=True)
        weight = SOURCE_WEIGHTS.get(source, 1.0)

        for rank, hit in enumerate(hits):
            hit_id = id(hit)
            hit_index_map[hit_id] = hit
            scores[hit_id] = scores.get(hit_id, 0) + weight / (k + rank + 1)

    # 按 RRF 分数降序排序
    sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
    result = []
    for hit_id in sorted_ids:
        hit = hit_index_map[hit_id]
        hit["rrf_score"] = scores[hit_id]
        result.append(hit)

    return result


def _llm_rerank(query: str, candidates: List[dict], llm_config: dict,
                top_k: int = 5) -> List[dict]:
    """
    LLM Reranker：基于 LLM 做 listwise 精排。

    Args:
        query: 用户原始查询
        candidates: RRF 粗排结果（最多 20 条）
        llm_config: LLM 配置
        top_k: 最终保留数量

    Returns:
        精排后的 top_k 结果
    """
    if not candidates:
        return []

    if not llm_config.get("llm_url"):
        _logger.warning("LLM not configured, using RRF-only ranking")
        # 不经过 LLM Reranker，直接返回 RRF top_k
        for i, c in enumerate(candidates[:top_k]):
            c["rerank_score"] = c.get("rrf_score", 0)
            c["rerank_reason"] = "RRF ranked"
        return candidates[:top_k]

    # 构建 candidate 文本列表
    candidate_texts = []
    for i, c in enumerate(candidates[:20]):
        text = c.get("text", "")
        source = c.get("source", "unknown")
        # 截断过长文本
        truncated = text[:300] + ("..." if len(text) > 300 else "")
        candidate_texts.append(f"[{i + 1}] [source:{source}] {truncated}")

    candidate_list = "\n\n".join(candidate_texts)

    system_prompt = """你是一个搜索排序专家。根据用户查询，对候选文档进行相关性排序。

请输出严格的 JSON 格式（不要额外文字）:
{
    "rankings": [
        {"index": 1, "reason": "简要说明为什么这条最相关"},
        {"index": 3, "reason": "...更少相关但仍有价值..."},
        ...
    ],
    "explanation": "整体排序说明"
}

排序规则:
- 最相关的排在前面
- 考虑内容相关性、信息完整性、来源权威性
- 来源可靠性: llama_index/wiki > graph_rag > hidesk > web
- 至少输出 top-5 的排序"""

    prompt = f"用户查询: {query}\n\n候选文档:\n{candidate_list}\n\n请对以上候选文档按相关性排序。"

    try:
        chat_url = llm_config["llm_url"].rstrip("/")
        if not chat_url.endswith("/chat/completions"):
            chat_url += "/chat/completions"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]

        headers = {"Content-Type": "application/json"}
        if llm_config.get("llm_api_key"):
            headers["Authorization"] = f"Bearer {llm_config['llm_api_key']}"

        body = {
            "model": llm_config.get("llm_model", ""),
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 1500,
        }

        resp = requests.post(chat_url, json=body, headers=headers, timeout=120)
        resp.raise_for_status()
        raw_text = resp.json()["choices"][0]["message"]["content"]

        # 解析排名
        ranking_data = _parse_rerank_json(raw_text)
        rankings = ranking_data.get("rankings", [])

        # 构建精排结果
        reranked = []
        for rank_item in rankings[:top_k]:
            idx = rank_item.get("index", 0) - 1  # 0-indexed
            if 0 <= idx < len(candidates):
                c = candidates[idx]
                c["rerank_score"] = 1.0 - (len(reranked) / top_k) * 0.5
                c["rerank_reason"] = rank_item.get("reason", "")
                reranked.append(c)

        # 如果 LLM Reranker 结果不足 top_k，补充 RRF 结果
        if len(reranked) < top_k:
            existing_indices = {candidates.index(r) for r in reranked if r in candidates}
            for c in candidates:
                if len(reranked) >= top_k:
                    break
                if candidates.index(c) not in existing_indices:
                    c["rerank_score"] = c.get("rrf_score", 0) * 0.5
                    c["rerank_reason"] = "RRF fallback"
                    reranked.append(c)

        _logger.info(f"LLM Reranker: {len(reranked)} results")
        return reranked

    except Exception as e:
        _logger.warning(f"LLM Reranker failed: {e}, using RRF-only")
        for i, c in enumerate(candidates[:top_k]):
            c["rerank_score"] = c.get("rrf_score", 0)
            c["rerank_reason"] = "RRF ranked (reranker fallback)"
        return candidates[:top_k]


def _parse_rerank_json(raw_text: str) -> dict:
    """解析 Reranker 返回的 JSON"""
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
        return {"rankings": [], "explanation": ""}


def fusion_ranker(state: FusionSearchState) -> dict:
    """
    融合排序节点入口。
    """
    t_start = time.time()

    # 阶段 1: 收集所有 hits
    all_hits, source_counts = _collect_all_hits(state)

    if not all_hits:
        _logger.warning("No hits from any source")
        return {"fused_candidates": [], "reranked_results": []}

    # 阶段 1: 加权 RRF 粗排
    fused = _weighted_rrf(all_hits, k=RRF_K)
    top_20 = fused[:20]
    t_rrf = time.time()
    rrf_elapsed = t_rrf - t_start

    # 阶段 2: LLM Reranker 精排
    query = state.get("user_query", "")
    llm_config = state.get("config", {}).get("llm_config", {})
    reranked = _llm_rerank(query, top_20, llm_config, top_k=5)
    t_rerank = time.time()
    rerank_elapsed = t_rerank - t_rrf
    total_elapsed = t_rerank - t_start

    top_sources = set(r.get("source", "?") for r in reranked[:5])

    _logger.info(
        f"Fusion: total={len(all_hits)} hits, "
        f"llama={source_counts.get('llama_index', 0)}, "
        f"graphrag={source_counts.get('graph_rag', 0)}, "
        f"hidesk={source_counts.get('hidesk', 0)}, "
        f"web={source_counts.get('web', 0)} "
        f"-> RRF{len(fused)} -> LLMRerank{len(reranked)} "
        f"top_sources={top_sources} "
        f"rrf={rrf_elapsed:.2f}s rerank={rerank_elapsed:.2f}s total={total_elapsed:.2f}s"
    )
    return {
        "fused_candidates": top_20,
        "reranked_results": reranked,
    }
