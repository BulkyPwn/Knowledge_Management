"""
Query 重写节点
==============
将用户原始查询重写为多角度查询：
- HyDE 假设文档 → 用于 Vector 语义检索
- 关键词抽取 → 用于 Keyword Index
- 实体查询 → 用于 GraphRAG
- 原始查询 → 用于 HiDesk / Web
"""

import json
import logging
import re
import time
import requests
from typing import Dict, Any

from ..state import FusionSearchState

_logger = logging.getLogger("langgraph_fusion.query_rewriter")

HYDE_SYSTEM_PROMPT = """你是一个检索增强专家。根据用户的问题，生成一个假设性的文档片段，
该文档片段应该包含可能回答该问题的信息。假设文档应该是一段通顺的文字（3-5 句话），
包含可能的答案细节。

注意：
- 不要直接回答问题
- 生成的是"假设文档"，描述如果存在这样一个文档，它会包含什么信息
- 使用与问题相同的语言
- 保持简洁，控制在 200 字以内"""

KEYWORD_EXTRACT_PROMPT = """从以下查询中提取核心关键词，每个关键词用逗号分隔：

查询：{query}

关键词："""


def _call_llm(prompt: str, llm_config: dict, system_prompt: str = "") -> str:
    """调用 LLM 获取文本响应"""
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
        "temperature": 0.3,
        "max_tokens": 500,
    }

    resp = requests.post(chat_url, json=body, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _generate_hyde(query: str, llm_config: dict) -> str:
    """生成 HyDE 假设文档"""
    if not llm_config.get("llm_url"):
        return query  # 回退到原始 query

    try:
        hyde_text = _call_llm(
            f"问题：{query}",
            llm_config,
            system_prompt=HYDE_SYSTEM_PROMPT,
        )
        _logger.info(f"HyDE generated: {hyde_text[:100]}...")
        return hyde_text.strip()
    except Exception as e:
        _logger.warning(f"HyDE generation failed: {e}")
        return query


def _extract_keywords(query: str, llm_config: dict) -> list:
    """提取关键词"""
    if not llm_config.get("llm_url"):
        # 简单分词
        import re
        words = re.findall(r'[\u4e00-\u9fff]{2,}|[a-zA-Z]{2,}', query)
        return list(set(words))[:5]

    try:
        prompt = KEYWORD_EXTRACT_PROMPT.format(query=query)
        raw = _call_llm(prompt, llm_config)
        keywords = [k.strip() for k in raw.replace("\n", ",").split(",") if k.strip()]
        return keywords[:8]
    except Exception as e:
        _logger.warning(f"Keyword extraction failed: {e}")
        return []


def query_rewriter(state: FusionSearchState) -> dict:
    """
    Query 重写节点入口。
    """
    t_start = time.time()
    query = state.get("user_query", "")
    intent = state.get("parsed_intent", {}) or {}
    llm_config = state.get("config", {}).get("llm_config", {})
    retry_count = state.get("retry_count", 0)

    if not query:
        _logger.warning("query_rewriter: empty query")
        return {"rewritten_queries": {}, "error": "user_query is empty"}

    _logger.info(f"Rewriting query (retry={retry_count}): {query[:100]!r}")

    # HyDE 假设文档生成
    hyde_query = _generate_hyde(query, llm_config)

    # 关键词抽取
    keywords = _extract_keywords(query, llm_config)
    if not keywords:
        keywords = intent.get("keywords", [])
        _logger.debug(f"Using keywords from intent: {keywords}")

    # 实体抽取（从 intent）
    entities = intent.get("entities", [])

    queries = {
        "hyde": hyde_query,
        "keyword": " ".join(keywords) if keywords else query,
        "entity": entities,
        "original": query,
    }

    elapsed = time.time() - t_start
    _logger.info(
        f"Query rewritten: hyde_len={len(hyde_query)}, "
        f"keywords={keywords}, entities={entities}, "
        f"retry={retry_count}, elapsed={elapsed:.2f}s"
    )
    return {"rewritten_queries": queries}
