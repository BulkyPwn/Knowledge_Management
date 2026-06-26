"""
LangGraph 检索图构建器
======================
构建多源融合检索图：
  intent_parser → query_rewriter → [并行检索] → fusion_ranker → quality_evaluator
    → score < threshold AND retry < max → query_rewriter (重试)
    → else → answer_generator → END

支持 SqliteSaver 断点续传。
"""

import logging
import os
import time
from typing import Optional, Generator, Dict, Any

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver

from .state import FusionSearchState, FusionSearchConfig
from .nodes.intent_parser import intent_parser
from .nodes.query_rewriter import query_rewriter
from .nodes.llama_index_retriever import llama_index_retriever
from .nodes.graph_rag_retriever import graph_rag_retriever
from .nodes.hidesk_retriever import hidesk_retriever
from .nodes.web_retriever import web_retriever
from .nodes.fusion_ranker import fusion_ranker
from .nodes.quality_evaluator import quality_evaluator
from .nodes.answer_generator import answer_generator

_logger = logging.getLogger("langgraph_fusion.graph")

# 可选的外部日志回调（与 app.py write_log 一致）
_write_log = None


def set_write_log(fn):
    """注入结构化日志回调，签名: write_log(action: str, details: dict, level: str = "info")"""
    global _write_log
    _write_log = fn


def _log_action(action: str, details: dict, level: str = "info"):
    """统一日志出口：优先用外部 write_log，否则用 logging"""
    if _write_log:
        try:
            _write_log(action, details, level=level)
        except Exception:
            pass
    log_fn = {"info": _logger.info, "warning": _logger.warning, "error": _logger.error}.get(level, _logger.info)
    log_fn(f"[{action}] {str(details)[:500]}")


def _should_retry(state: FusionSearchState) -> str:
    """
    条件边决策：是否需要重试？
    """
    score = state.get("quality_score", 0)
    retry_count = state.get("retry_count", 0)
    config = state.get("config", {})
    threshold = config.get("quality_threshold", 0.6)
    max_retries = config.get("max_retries", 2)

    _log_action("fusion_should_retry", {
        "quality_score": score, "threshold": threshold,
        "retry_count": retry_count, "max_retries": max_retries,
    })

    if score >= threshold:
        _logger.info(f"Quality score {score:.2f} >= {threshold}, proceeding to answer")
        return "answer_generator"

    if retry_count < max_retries:
        _logger.info(f"Quality score {score:.2f} < {threshold}, retrying ({retry_count + 1}/{max_retries})")
        state["retry_count"] = retry_count + 1
        _log_action("fusion_retry", {
            "retry": retry_count + 1, "max_retries": max_retries,
            "quality_score": score,
        }, level="warning")
        return "query_rewriter"

    _logger.info(f"Quality score {score:.2f} < {threshold}, but max retries ({max_retries}) reached")
    _log_action("fusion_max_retries_reached", {
        "quality_score": score, "retries": retry_count, "max_retries": max_retries,
    }, level="warning")
    return "answer_generator"


def _route_retrieval(state: FusionSearchState) -> list:
    """
    根据意图和平台开关决定激活哪些检索源。
    """
    intent = state.get("parsed_intent", {}) or {}
    config = state.get("config", {})
    enabled = config.get("enabled_sources", {})

    sources = []
    skip_reasons = []

    if enabled.get("llama_index", True):
        sources.append("llama_index_retriever")
    else:
        skip_reasons.append("llama_index: disabled")

    search_type = intent.get("search_type", "general")
    if enabled.get("graph_rag"):
        if search_type in ("relational", "comparative", "multi_hop"):
            sources.append("graph_rag_retriever")
        elif intent.get("entities"):
            sources.append("graph_rag_retriever")
        else:
            skip_reasons.append(f"graph_rag: search_type={search_type}, no entities")
    else:
        skip_reasons.append("graph_rag: disabled")

    if enabled.get("hidesk"):
        sources.append("hidesk_retriever")
    else:
        skip_reasons.append("hidesk: disabled")

    if enabled.get("web"):
        sources.append("web_retriever")
    else:
        skip_reasons.append("web: disabled")

    if not sources:
        sources.append("llama_index_retriever")

    _log_action("fusion_route_retrieval", {
        "search_type": search_type,
        "enabled_sources": list(enabled.keys()),
        "activated_sources": sources,
        "skipped": skip_reasons,
    })
    _logger.info(f"Routing retrieval: {len(sources)} sources activated -> {sources}")
    return sources


def build_fusion_search_graph(
    checkpointer: Optional[SqliteSaver] = None,
) -> StateGraph:
    """
    构建融合检索图。

    Args:
        checkpointer: SqliteSaver 实例，用于断点续传

    Returns:
        编译后的 StateGraph
    """
    workflow = StateGraph(FusionSearchState)

    # ── 注册节点 ──
    workflow.add_node("intent_parser", intent_parser)
    workflow.add_node("query_rewriter", query_rewriter)
    workflow.add_node("llama_index_retriever", llama_index_retriever)
    workflow.add_node("graph_rag_retriever", graph_rag_retriever)
    workflow.add_node("hidesk_retriever", hidesk_retriever)
    workflow.add_node("web_retriever", web_retriever)
    workflow.add_node("fusion_ranker", fusion_ranker)
    workflow.add_node("quality_evaluator", quality_evaluator)
    workflow.add_node("answer_generator", answer_generator)

    # ── 设置边 ──

    # 入口
    workflow.set_entry_point("intent_parser")

    # intent → query_rewrite
    workflow.add_edge("intent_parser", "query_rewriter")

    # query_rewrite → 并行检索（条件路由）
    workflow.add_conditional_edges(
        "query_rewriter",
        _route_retrieval,
        {
            "llama_index_retriever": "llama_index_retriever",
            "graph_rag_retriever": "graph_rag_retriever",
            "hidesk_retriever": "hidesk_retriever",
            "web_retriever": "web_retriever",
        },
    )

    # 所有检索节点 → fusion_ranker
    workflow.add_edge("llama_index_retriever", "fusion_ranker")
    workflow.add_edge("graph_rag_retriever", "fusion_ranker")
    workflow.add_edge("hidesk_retriever", "fusion_ranker")
    workflow.add_edge("web_retriever", "fusion_ranker")

    # fusion → quality_eval
    workflow.add_edge("fusion_ranker", "quality_evaluator")

    # quality_eval → 条件跳转
    workflow.add_conditional_edges(
        "quality_evaluator",
        _should_retry,
        {
            "query_rewriter": "query_rewriter",
            "answer_generator": "answer_generator",
        },
    )

    # answer → END
    workflow.add_edge("answer_generator", END)

    # ── 编译 ──
    if checkpointer:
        _logger.info("Compiling graph with SqliteSaver checkpointer")
        _log_action("fusion_build_graph", {"checkpointer": "SqliteSaver"})
        return workflow.compile(checkpointer=checkpointer)

    _logger.info("Compiling graph without checkpointer")
    _log_action("fusion_build_graph", {"checkpointer": "none"})
    return workflow.compile()


def create_sqlite_checkpointer(db_path: str) -> SqliteSaver:
    """
    创建 SqliteSaver 实例。
    """
    parent_dir = os.path.dirname(db_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)
    _logger.info(f"Creating SqliteSaver at: {db_path}")
    _log_action("fusion_create_checkpointer", {"db_path": db_path})
    return SqliteSaver.from_conn_string(db_path)


def run_fusion_search(
    graph: StateGraph,
    initial_state: FusionSearchState,
    thread_id: str = None,
) -> Dict[str, Any]:
    """
    执行融合检索。
    """
    import uuid

    if thread_id is None:
        thread_id = str(uuid.uuid4())

    query = initial_state.get("user_query", "")
    config_dict = initial_state.get("config", {})
    _log_action("fusion_search_start", {
        "query": query[:200],
        "thread_id": thread_id,
        "enabled_sources": config_dict.get("enabled_sources", {}),
        "max_retries": config_dict.get("max_retries", 2),
        "quality_threshold": config_dict.get("quality_threshold", 0.6),
    })
    _logger.info(f"Starting fusion search: query={query[:100]!r}, thread_id={thread_id}")

    langgraph_config = {
        "configurable": {
            "thread_id": thread_id,
        },
    }

    t_start = time.time()
    node_timings = {}
    final_state = None
    node_visited = []

    for event in graph.stream(initial_state, langgraph_config):
        for node_name in event:
            if node_name not in node_visited:
                node_visited.append(node_name)
                elapsed = time.time() - t_start
                node_timings[node_name] = elapsed
                _log_action("fusion_node_visited", {
                    "node": node_name,
                    "elapsed": f"{elapsed:.2f}s",
                    "order": len(node_visited),
                })
                _logger.debug(f"Node completed: {node_name} @ {elapsed:.2f}s")
        final_state = event

    total_time = time.time() - t_start

    if final_state is None:
        _log_action("fusion_search_error", {
            "error": "No events from graph",
            "elapsed": f"{total_time:.2f}s",
        }, level="error")
        return {
            "final_answer": "检索执行失败",
            "final_sources": [],
            "error": "No events from graph",
        }

    answer_event = final_state.get("answer_generator", {})
    if not answer_event:
        for node_name, node_output in final_state.items():
            if "final_answer" in node_output:
                answer_event = node_output
                break

    result = answer_event or final_state

    _log_action("fusion_search_done", {
        "query": query[:200],
        "thread_id": thread_id,
        "total_time": f"{total_time:.2f}s",
        "node_visited": node_visited,
        "node_timings": {k: f"{v:.2f}s" for k, v in node_timings.items()},
        "answer_length": len(result.get("final_answer", "")),
        "sources_count": len(result.get("final_sources", [])),
        "quality_score": result.get("quality_score", 0),
    })
    _logger.info(
        f"Fusion search done: {total_time:.2f}s, "
        f"{len(node_visited)} nodes visited, "
        f"answer_len={len(result.get('final_answer', ''))}, "
        f"sources={len(result.get('final_sources', []))}"
    )
    return result


# ── 可视化辅助 ──────────────────────────────────────────────

def export_graph_mermaid(output_path: str = None) -> str:
    """
    导出 LangGraph 图的 Mermaid 源码。

    用法:
        mermaid_src = export_graph_mermaid()
        # 复制到 https://mermaid.live 查看，或存为 .mmd 文件在 VS Code 中预览

        export_graph_mermaid("fusion_graph.mmd")
        # 生成文件后用 VS Code + Mermaid 插件打开即可看到流程图

    Returns:
        Mermaid 格式的图源码字符串
    """
    workflow = StateGraph(FusionSearchState)
    workflow.add_node("intent_parser", intent_parser)
    workflow.add_node("query_rewriter", query_rewriter)
    workflow.add_node("llama_index_retriever", llama_index_retriever)
    workflow.add_node("graph_rag_retriever", graph_rag_retriever)
    workflow.add_node("hidesk_retriever", hidesk_retriever)
    workflow.add_node("web_retriever", web_retriever)
    workflow.add_node("fusion_ranker", fusion_ranker)
    workflow.add_node("quality_evaluator", quality_evaluator)
    workflow.add_node("answer_generator", answer_generator)

    workflow.set_entry_point("intent_parser")
    workflow.add_edge("intent_parser", "query_rewriter")
    workflow.add_conditional_edges("query_rewriter", _route_retrieval, {
        "llama_index_retriever": "llama_index_retriever",
        "graph_rag_retriever": "graph_rag_retriever",
        "hidesk_retriever": "hidesk_retriever",
        "web_retriever": "web_retriever",
    })
    workflow.add_edge("llama_index_retriever", "fusion_ranker")
    workflow.add_edge("graph_rag_retriever", "fusion_ranker")
    workflow.add_edge("hidesk_retriever", "fusion_ranker")
    workflow.add_edge("web_retriever", "fusion_ranker")
    workflow.add_edge("fusion_ranker", "quality_evaluator")
    workflow.add_conditional_edges("quality_evaluator", _should_retry, {
        "query_rewriter": "query_rewriter",
        "answer_generator": "answer_generator",
    })
    workflow.add_edge("answer_generator", END)

    graph = workflow.compile()
    mermaid_src = graph.get_graph().draw_mermaid()

    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(mermaid_src)
        _logger.info(f"Graph Mermaid exported to: {output_path}")

    return mermaid_src


def export_graph_png(output_path: str = "fusion_graph.png"):
    """
    导出 LangGraph 图为 PNG 图片（需要安装 pygraphviz 或 pillow）。

    如果 graphviz 不可用则回退到 Mermaid 文本导出。
    """
    workflow = StateGraph(FusionSearchState)
    workflow.add_node("intent_parser", intent_parser)
    workflow.add_node("query_rewriter", query_rewriter)
    workflow.add_node("llama_index_retriever", llama_index_retriever)
    workflow.add_node("graph_rag_retriever", graph_rag_retriever)
    workflow.add_node("hidesk_retriever", hidesk_retriever)
    workflow.add_node("web_retriever", web_retriever)
    workflow.add_node("fusion_ranker", fusion_ranker)
    workflow.add_node("quality_evaluator", quality_evaluator)
    workflow.add_node("answer_generator", answer_generator)

    workflow.set_entry_point("intent_parser")
    workflow.add_edge("intent_parser", "query_rewriter")
    workflow.add_conditional_edges("query_rewriter", _route_retrieval, {
        "llama_index_retriever": "llama_index_retriever",
        "graph_rag_retriever": "graph_rag_retriever",
        "hidesk_retriever": "hidesk_retriever",
        "web_retriever": "web_retriever",
    })
    workflow.add_edge("llama_index_retriever", "fusion_ranker")
    workflow.add_edge("graph_rag_retriever", "fusion_ranker")
    workflow.add_edge("hidesk_retriever", "fusion_ranker")
    workflow.add_edge("web_retriever", "fusion_ranker")
    workflow.add_edge("fusion_ranker", "quality_evaluator")
    workflow.add_conditional_edges("quality_evaluator", _should_retry, {
        "query_rewriter": "query_rewriter",
        "answer_generator": "answer_generator",
    })
    workflow.add_edge("answer_generator", END)

    graph = workflow.compile()
    try:
        png_data = graph.get_graph().draw_mermaid_png()
        with open(output_path, "wb") as f:
            f.write(png_data)
        _logger.info(f"Graph PNG exported to: {output_path}")
        return output_path
    except Exception as e:
        _logger.warning(f"PNG export failed ({e}), falling back to Mermaid text")
        mermaid_path = output_path.replace(".png", ".mmd")
        return export_graph_mermaid(mermaid_path)
