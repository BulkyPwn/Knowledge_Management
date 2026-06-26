"""
意图解析节点
============
用 LLM 解析用户查询意图，生成结构化 intent 对象。

输出:
    parsed_intent: {
        "topic": str,           # 核心主题
        "focus_areas": [str],   # 关注方面
        "search_type": str,     # "factual" | "relational" | "procedural" | "comparative" | "general"
        "domain": str,          # 领域分类
        "timeliness": str,      # "realtime" | "recent" | "stable"
        "entities": [str],      # 抽取的实体名
        "keywords": [str],      # 抽取的关键词
    }
"""

import json
import logging
import re
import time
import requests
from typing import Dict, Any

from ..state import FusionSearchState

_logger = logging.getLogger("langgraph_fusion.intent_parser")

INTENT_PARSE_SYSTEM_PROMPT = """你是一个查询意图解析专家。分析用户的查询，提取结构化意图信息。

输出严格的 JSON 格式（不要额外文字）:
{
    "topic": "核心主题（中文简短描述）",
    "focus_areas": ["关注方面1", "关注方面2"],
    "search_type": "factual|relational|procedural|comparative|general",
    "domain": "技术文档|企业服务|知识管理|通用",
    "timeliness": "realtime|recent|stable",
    "entities": ["实体1", "实体2"],
    "keywords": ["关键词1", "关键词2"]
}

search_type 判断规则:
- factual: 事实型查询（是什么、定义、属性）
- relational: 关系型查询（对比、关联、影响、依赖）
- procedural: 过程型查询（怎么做、步骤、流程）
- comparative: 比较型查询（A vs B、区别）
- general: 通用查询

timeliness 判断规则:
- realtime: 需要最新信息（今天、实时数据）
- recent: 近期的（本周、本月）
- stable: 不敏感（概念、原理、固定知识）

entities: 从 query 中提取的具体实体名称（人名、技术名、产品名、公司名等）
keywords: 核心查询关键词"""


def _call_llm(prompt: str, llm_config: dict, system_prompt: str = "") -> str:
    """
    调用 LLM 获取文本响应。

    Args:
        prompt: 用户提示
        llm_config: LLM 配置
        system_prompt: 系统提示

    Returns:
        LLM 返回的文本内容
    """
    llm_url = llm_config.get("llm_url", "")
    llm_api_key = llm_config.get("llm_api_key", "")
    llm_model = llm_config.get("llm_model", "")

    if not llm_url:
        raise RuntimeError("LLM 未配置：llm_url 为空")

    # 构建 chat completions URL
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
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _parse_intent_json(raw_text: str) -> dict:
    """
    从 LLM 响应中提取 JSON。

    容错：去除 markdown 代码块包裹、提取首个 JSON。
    """
    text = raw_text.strip()

    # 去除 ```json ... ``` 包裹
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines)

    # 尝试找到 JSON 边界
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        _logger.warning(f"Failed to parse intent JSON from: {raw_text[:200]}")
        return {
            "topic": "",
            "focus_areas": [],
            "search_type": "general",
            "domain": "通用",
            "timeliness": "stable",
            "entities": [],
            "keywords": [],
        }


def intent_parser(state: FusionSearchState) -> dict:
    """
    意图解析节点入口。
    """
    t_start = time.time()
    query = state.get("user_query", "")
    llm_config = state.get("config", {}).get("llm_config", {})

    if not query:
        _logger.warning("intent_parser: empty query")
        return {"parsed_intent": None, "error": "user_query is empty"}

    _logger.info(f"Parsing intent for query: {query[:100]!r}")

    if not llm_config.get("llm_url"):
        _logger.warning("LLM not configured, using rule-based intent parser")
        intent = _rule_based_intent(query)
        elapsed = time.time() - t_start
        _logger.info(
            f"Intent parsed (rule-based): type={intent.get('search_type')}, "
            f"entities={len(intent.get('entities', []))}, "
            f"elapsed={elapsed:.2f}s"
        )
        return {"parsed_intent": intent}

    try:
        prompt = f"请解析以下用户查询的意图：\n\n{query}"
        raw_response = _call_llm(prompt, llm_config, system_prompt=INTENT_PARSE_SYSTEM_PROMPT)
        intent = _parse_intent_json(raw_response)
        elapsed = time.time() - t_start
        _logger.info(
            f"Intent parsed (LLM): topic={intent.get('topic')}, "
            f"type={intent.get('search_type')}, "
            f"entities={len(intent.get('entities', []))}, "
            f"elapsed={elapsed:.2f}s"
        )
        return {"parsed_intent": intent}
    except Exception as e:
        _logger.warning(f"LLM intent parsing failed: {e}, falling back to rule-based")
        intent = _rule_based_intent(query)
        elapsed = time.time() - t_start
        _logger.info(f"Intent parsed (fallback): type={intent.get('search_type')}, elapsed={elapsed:.2f}s")
        return {"parsed_intent": intent}


def _rule_based_intent(query: str) -> dict:
    """
    基于规则的意图解析（回退方案）。
    当 LLM 不可用时使用。
    """
    from typing import List

    # 关系型关键词
    relational_kw = ["关系", "关联", "影响", "依赖", "对比", "区别", "联系", "比较", "vs"]
    # 过程型关键词
    procedural_kw = ["怎么", "如何", "步骤", "流程", "方法", "操作", "配置", "安装"]
    # 事实型关键词
    factual_kw = ["是什么", "定义", "含义", "概念", "谁", "哪个", "哪些"]

    search_type = "general"
    if any(kw in query for kw in factual_kw):
        search_type = "factual"
    if any(kw in query for kw in relational_kw):
        search_type = "relational"
    if any(kw in query for kw in procedural_kw):
        search_type = "procedural"

    # 简单实体抽取：2-6 字的中文/英文专有名词
    import re
    entities = re.findall(r'\b[A-Z][a-zA-Z]+|\b[A-Z][a-z]+ [A-Z][a-z]+\b', query)
    # 中文词简单切分
    chinese_words = re.findall(r'[\u4e00-\u9fff]{2,6}', query)
    entities.extend(chinese_words[:5])

    keywords = [w for w in query.replace("？", " ").replace("的", " ").split() if len(w) >= 2][:5]

    return {
        "topic": query[:40],
        "focus_areas": [],
        "search_type": search_type,
        "domain": "通用",
        "timeliness": "stable",
        "entities": list(set(entities))[:5],
        "keywords": keywords,
    }
