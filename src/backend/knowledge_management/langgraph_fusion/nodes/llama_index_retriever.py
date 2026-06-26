"""
LlamaIndex 检索节点
===================
从 Wiki 页面、原始文档、实体/概念索引中检索相关内容。

使用 LlamaIndex 的 VectorStoreIndex.as_retriever() 进行语义检索。
"""

import logging
from typing import List, Dict, Any, Optional

from ..state import FusionSearchState

_logger = logging.getLogger("langgraph_fusion.llama_index_retriever")

# 全局索引注册表（由外部注入）
_index_registry: Optional[Any] = None


def set_index_registry(registry):
    """注入索引注册表"""
    global _index_registry
    _index_registry = registry


def _retrieve_from_index(index_name: str, query: str, top_k: int = 10) -> List[dict]:
    """
    从指定的 LlamaIndex 索引中检索。

    Args:
        index_name: 索引名称（如 "wiki_pages", "raw_sources", "wiki_entities", "wiki_concepts"）
        query: 检索查询
        top_k: 返回结果数

    Returns:
        [{text, score, metadata, node_id}, ...]
    """
    if _index_registry is None:
        _logger.warning("Index registry not initialized")
        return []

    index = _index_registry.get(index_name)
    if index is None:
        _logger.warning(f"Index '{index_name}' not found in registry")
        return []

    try:
        retriever = index.as_retriever(similarity_top_k=top_k)
        nodes = retriever.retrieve(query)
        hits = []
        for node in nodes:
            hits.append({
                "text": node.text,
                "score": float(node.score) if node.score else 0.0,
                "metadata": node.metadata,
                "node_id": node.node_id,
                "source": "llama_index",
                "index_name": index_name,
            })
        return hits
    except Exception as e:
        _logger.error(f"Retrieval from '{index_name}' failed: {e}")
        return []


def llama_index_retriever(state: FusionSearchState) -> dict:
    """
    LlamaIndex 检索节点入口。

    并行检索 Wiki 页面、原始文档、实体、概念四个索引，
    合并结果。

    输入: state["rewritten_queries"], state["config"]
    输出: {"llama_index_hits": [...]}
    """
    rewritten = state.get("rewritten_queries", {})
    if not rewritten:
        return {"llama_index_hits": []}

    query = rewritten.get("hyde", rewritten.get("original", ""))
    keyword_query = rewritten.get("keyword", query)

    all_hits = []

    # 1. Wiki 页面索引（HyDE query）
    wiki_hits = _retrieve_from_index("wiki_pages", query, top_k=10)
    all_hits.extend(wiki_hits)

    # 2. 原始文档索引
    raw_hits = _retrieve_from_index("raw_sources", query, top_k=5)
    for h in raw_hits:
        h["source"] = "raw_document"
    all_hits.extend(raw_hits)

    # 3. 实体索引
    entity_hits = _retrieve_from_index("wiki_entities", keyword_query, top_k=5)
    for h in entity_hits:
        h["source"] = "wiki_entity"
    all_hits.extend(entity_hits)

    # 4. 概念索引
    concept_hits = _retrieve_from_index("wiki_concepts", keyword_query, top_k=5)
    for h in concept_hits:
        h["source"] = "wiki_concept"
    all_hits.extend(concept_hits)

    # 去重（按 text 内容相似度 > 0.9 去重）
    unique_hits = _deduplicate_by_text(all_hits)

    _logger.info(f"LlamaIndex retrieval: {len(all_hits)} total hits → {len(unique_hits)} unique")
    return {"llama_index_hits": unique_hits}


def _deduplicate_by_text(hits: List[dict], threshold: float = 0.9) -> List[dict]:
    """
    基于文本内容去重。

    Args:
        hits: 检索结果列表
        threshold: 文本相似度阈值（Jaccard）

    Returns:
        去重后的结果
    """
    if not hits:
        return []

    result = [hits[0]]
    for hit in hits[1:]:
        text = hit.get("text", "")
        is_dup = False
        for existing in result:
            et = existing.get("text", "")
            if _jaccard_similarity(text[:500], et[:500]) > threshold:
                is_dup = True
                break
        if not is_dup:
            result.append(hit)

    return result


def _jaccard_similarity(a: str, b: str) -> float:
    """计算两个文本的 Jaccard 相似度"""
    if not a or not b:
        return 0.0
    set_a = set(a)
    set_b = set(b)
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0
