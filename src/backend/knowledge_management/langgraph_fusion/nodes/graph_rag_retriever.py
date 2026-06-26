"""
知识图谱检索节点
=================
通过 Neo4j 执行图检索：
1. 实体名匹配
2. 子图遍历
3. 多跳路径查询（关系类问题）
"""

import logging
from typing import List, Dict, Any, Optional

from ..state import FusionSearchState
from ..adapters.neo4j_adapter import Neo4jAdapter

_logger = logging.getLogger("langgraph_fusion.graph_rag_retriever")

# 全局 Neo4j 适配器（由外部注入）
_neo4j_adapter: Optional[Neo4jAdapter] = None


def set_neo4j_adapter(adapter: Neo4jAdapter):
    """注入 Neo4j 适配器"""
    global _neo4j_adapter
    _neo4j_adapter = adapter


def _format_graph_hits(subgraph: dict, paths: List[dict],
                       subgraph_context: str) -> List[dict]:
    """
    将图检索结果格式化为统一 hits。

    Returns:
        [{text, metadata, source, entity_count, relation_count}, ...]
    """
    hits = []

    # 子图作为上下文
    entities = subgraph.get("entities", [])
    relations = subgraph.get("relations", [])

    if entities:
        # 构建子图文本描述
        entity_descs = []
        for e in entities:
            name = e.get("name", e.get("id", ""))
            etype = e.get("type", "")
            desc = e.get("description", "")
            entity_descs.append(f"- {name} ({etype}): {desc}")

        text = f"知识图谱子图（{len(entities)} 实体, {len(relations)} 关系）:\n" + "\n".join(entity_descs)
        hits.append({
            "text": text,
            "score": 0.85,
            "metadata": {
                "entity_count": len(entities),
                "relation_count": len(relations),
                "source": "graph_rag_subgraph",
            },
            "source": "graph_rag",
        })

    # 多跳路径
    for i, path in enumerate(paths):
        nodes = path.get("nodes", [])
        path_rels = path.get("relations", [])
        node_names = [n.get("name", n.get("id", "")) for n in nodes]
        text = f"关联路径 {i + 1}: {' → '.join(node_names)}"
        hits.append({
            "text": text,
            "score": 0.75,
            "metadata": {
                "path_nodes": node_names,
                "path_length": len(path_rels),
                "source": "graph_rag_path",
            },
            "source": "graph_rag",
        })

    return hits


def graph_rag_retriever(state: FusionSearchState) -> dict:
    """
    知识图谱检索节点入口。

    输入: state["rewritten_queries"], state["parsed_intent"], state["config"]
    输出: {"graph_rag_hits": [...]}
    """
    rewritten = state.get("rewritten_queries", {})
    intent = state.get("parsed_intent", {}) or {}

    entities = rewritten.get("entity", [])
    if not entities:
        # 从 intent 中获取实体
        entities = intent.get("entities", [])

    if not entities:
        _logger.debug("No entities to search in graph")
        return {"graph_rag_hits": []}

    if _neo4j_adapter is None:
        _logger.warning("Neo4j adapter not initialized")
        return {"graph_rag_hits": []}

    try:
        # Step 1: 实体名匹配
        matched = _neo4j_adapter.match_entities(entities)
        if not matched:
            _logger.debug(f"No entities matched for: {entities}")
            return {"graph_rag_hits": []}

        matched_ids = [e["id"] for e in matched]

        # Step 2: 子图检索
        subgraph = _neo4j_adapter.search_subgraph(matched_ids, depth=2)

        # Step 3: 多跳路径（如果是关系类问题）
        paths = []
        search_type = intent.get("search_type", "general")
        if search_type in ("relational", "comparative") and len(matched_ids) >= 2:
            for i in range(len(matched_ids)):
                for j in range(i + 1, len(matched_ids)):
                    try:
                        path_result = _neo4j_adapter.multi_hop_query(
                            matched[i].get("name", ""),
                            matched[j].get("name", ""),
                            max_hops=3,
                        )
                        paths.extend(path_result)
                    except Exception as e:
                        _logger.debug(f"Path query failed: {e}")

        # 格式化为统一 hits
        subgraph_context = ""
        hits = _format_graph_hits(subgraph, paths, subgraph_context)

        _logger.info(f"GraphRAG retrieved: {len(matched)} entities matched, "
                     f"{len(hits)} hits")
        return {"graph_rag_hits": hits}

    except Exception as e:
        _logger.error(f"GraphRAG retrieval failed: {e}")
        return {"graph_rag_hits": [], "error": str(e)}
