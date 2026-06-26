"""
HiDesk 搜索适配器
=================
封装对 HiDesk API 的调用，提供统一接口。

当前 HiDesk 接口在 app.py 中为预留状态（返回空结果），
本适配器封装相同逻辑，当 HiDesk API 正式接入后无需修改调用方。
"""

import json
import logging
from typing import List, Optional, Dict, Any

_logger = logging.getLogger("langgraph_fusion.hidesk")


class HiDeskAdapter:
    """
    HiDesk 搜索适配器。

    用法:
        adapter = HiDeskAdapter(base_url="http://7.212.122.246:port", kb_sn="xxx")
        results = adapter.search("如何配置网络", top_k=5)
    """

    def __init__(self, base_url: str = "", kb_sn: str = "", timeout: int = 10):
        """
        Args:
            base_url: HiDesk API 地址（如 http://host:port）
            kb_sn: 知识库序列号（从 HiDesk 配置中选择的视图 kb_sn）
            timeout: 请求超时秒数
        """
        self.base_url = base_url.rstrip("/")
        self.kb_sn = kb_sn
        self.timeout = timeout

    def is_configured(self) -> bool:
        """检查是否已配置"""
        return bool(self.base_url)

    def search(self, query: str, top_k: int = 5, domains: List[str] = None) -> Dict[str, Any]:
        """
        执行 HiDesk 搜索。

        当前为预留实现：HiDesk API 尚未正式接入。
        当 API 正式接入后，替换本方法中的请求逻辑即可。

        Args:
            query: 搜索查询
            top_k: 返回结果数
            domains: 领域过滤（可选）

        Returns:
            {
                "results": [{"title", "content", "url", "score"}, ...],
                "total": int,
                "error": str or None
            }
        """
        if not self.is_configured():
            return {
                "results": [],
                "total": 0,
                "error": "HiDesk 未配置：base_url 为空",
                "platform": "hidesk",
            }

        # TODO: HiDesk API 正式接入时，替换为实际请求逻辑
        # 当前为预留接口，返回空结果
        _logger.info(f"HiDesk search (stub): query={query!r}, kb_sn={self.kb_sn}")
        return {
            "results": [],
            "total": 0,
            "error": "HiDesk 搜索接口尚未正式接入",
            "platform": "hidesk",
        }

    def format_hits(self, search_result: Dict[str, Any]) -> List[dict]:
        """
        将 HiDesk 搜索结果格式化为统一 hits 格式。

        Args:
            search_result: self.search() 的返回值

        Returns:
            [{text, title, url, score, source}, ...]
        """
        hits = []
        for item in search_result.get("results", []):
            hits.append({
                "text": item.get("content", item.get("snippet", "")),
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "score": item.get("score", 0.0),
                "source": "hidesk",
            })
        return hits
