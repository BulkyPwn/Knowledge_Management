"""
HiDesk 检索节点
===============
通过 HiDesk API 检索企业服务台/工单知识。
"""

import logging
from typing import Dict, Any, Optional

from ..state import FusionSearchState
from ..adapters.hidesk_adapter import HiDeskAdapter

_logger = logging.getLogger("langgraph_fusion.hidesk_retriever")

# 全局 HiDesk 适配器（由外部注入）
_hidesk_adapter: Optional[HiDeskAdapter] = None


def set_hidesk_adapter(adapter: HiDeskAdapter):
    """注入 HiDesk 适配器"""
    global _hidesk_adapter
    _hidesk_adapter = adapter


def hidesk_retriever(state: FusionSearchState) -> dict:
    """
    HiDesk 检索节点入口。

    输入: state["user_query"], state["config"]
    输出: {"hidesk_hits": [...]}
    """
    query = state.get("user_query", "")
    config = state.get("config", {})

    if not query:
        return {"hidesk_hits": []}

    if _hidesk_adapter is None:
        _logger.warning("HiDesk adapter not initialized")
        return {
            "hidesk_hits": [],
            "error": "HiDesk adapter not initialized",
        }

    if not _hidesk_adapter.is_configured():
        _logger.debug("HiDesk not configured, skipping")
        return {"hidesk_hits": []}

    try:
        result = _hidesk_adapter.search(query, top_k=5)
        hits = _hidesk_adapter.format_hits(result)
        _logger.info(f"HiDesk retrieval: {len(hits)} hits")
        return {"hidesk_hits": hits}
    except Exception as e:
        _logger.error(f"HiDesk retrieval failed: {e}")
        return {"hidesk_hits": [], "error": str(e)}
