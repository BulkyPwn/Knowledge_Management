"""
Web 检索节点
============
通过 Web 搜索引擎检索公开信息。
当前为预留节点，复用现有的 _search_platform_web 或对接外部 API。
"""

import logging
from typing import List, Dict, Any, Optional, Callable

from ..state import FusionSearchState

_logger = logging.getLogger("langgraph_fusion.web_retriever")

# 全局 Web 搜索函数（由外部注入，复用 app.py 中的 _search_platform_web）
_web_search_fn: Optional[Callable] = None


def set_web_search_fn(fn: Callable):
    """注入 Web 搜索函数"""
    global _web_search_fn
    _web_search_fn = fn


def web_retriever(state: FusionSearchState) -> dict:
    """
    Web 检索节点入口。

    输入: state["user_query"], state["config"]
    输出: {"web_hits": [...]}
    """
    query = state.get("user_query", "")

    if not query:
        return {"web_hits": []}

    if _web_search_fn is None:
        _logger.warning("Web search function not injected")
        return {"web_hits": []}

    try:
        result = _web_search_fn(query)
        hits = _format_web_result(result)
        _logger.info(f"Web retrieval: {len(hits)} hits")
        return {"web_hits": hits}
    except Exception as e:
        _logger.error(f"Web retrieval failed: {e}")
        return {"web_hits": [], "error": str(e)}


def _format_web_result(result: dict) -> List[dict]:
    """
    将 Web 搜索结果格式化为统一 hits。

    Args:
        result: 来自 _search_platform_web 的结果

    Returns:
        [{text, title, url, score, source}, ...]
    """
    hits = []
    for item in result.get("results", []):
        hits.append({
            "text": item.get("content", item.get("snippet", "")),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "score": item.get("score", 0.0),
            "source": "web",
        })
    return hits
