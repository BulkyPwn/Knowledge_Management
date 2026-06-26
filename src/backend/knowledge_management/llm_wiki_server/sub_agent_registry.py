"""
SubAgent 注册表
===============
管理所有 SubAgent 定义，支持：
  - 按名称注册/查询
  - 从字典配置动态创建 SubAgent
  - 内置通用 SubAgent（意图分析、信息收集等）

使用方式：
    registry = SubAgentRegistry()
    registry.register(SubAgent(SubAgentConfig(name="analyzer", ...)))

    # 或从字典创建
    agent = registry.create_from_config({
        "name": "analyzer",
        "system_prompt": "你是...",
        "tools_allowed": ["knowledge_query"],
    })

    # 内置注册表（含通用 SubAgent）
    registry = build_default_sub_agent_registry()
"""

import json
from typing import Dict, List, Optional

from sub_agent import SubAgent, SubAgentConfig


# ── SubAgentRegistry 主类 ──────────────────────────────────────

class SubAgentRegistry:
    """SubAgent 注册表：注册、查询、动态创建 SubAgent。"""

    def __init__(self):
        self._agents: Dict[str, SubAgent] = {}
        self._configs: Dict[str, dict] = {}   # 原始配置（用于重新实例化）

    def register(self, agent: SubAgent) -> None:
        """注册一个 SubAgent 实例"""
        self._agents[agent.name] = agent
        self._configs[agent.name] = {
            "name": agent.config.name,
            "description": agent.config.description,
            "system_prompt": agent.config.system_prompt,
            "tools_allowed": agent.config.tools_allowed,
            "skill_ids": agent.config.skill_ids,
            "max_iterations": agent.config.max_iterations,
            "on_error": agent.config.on_error,
            "timeout": agent.config.timeout,
            "custom_instructions": agent.config.custom_instructions,
        }

    def register_config(self, config: dict) -> SubAgent:
        """从字典配置创建并注册 SubAgent，返回实例"""
        agent = self.create_from_config(config)
        self._agents[agent.name] = agent
        self._configs[agent.name] = config
        return agent

    def get(self, name: str) -> Optional[SubAgent]:
        """按名称获取 SubAgent（返回新实例，避免共享 last_result 状态）"""
        config = self._configs.get(name)
        if not config:
            return None
        return self.create_from_config(config)

    def get_or_raise(self, name: str) -> SubAgent:
        """按名称获取 SubAgent，不存在时抛出 ValueError"""
        agent = self.get(name)
        if not agent:
            available = list(self._agents.keys())
            raise ValueError(f"SubAgent '{name}' not found. Available: {available}")
        return agent

    def has(self, name: str) -> bool:
        return name in self._agents

    def list_agents(self) -> List[dict]:
        """列出所有 SubAgent 信息（API 展示用）"""
        result = []
        for name, agent in self._agents.items():
            result.append({
                "name": agent.name,
                "description": agent.description,
                "system_prompt_preview": agent.system_prompt[:200] if agent.system_prompt else "",
                "tools_allowed": agent.tools_allowed or "all",
                "skill_ids": agent.skill_ids,
                "max_iterations": agent.max_iterations,
                "on_error": agent.config.on_error,
                "timeout": agent.config.timeout,
            })
        return result

    def list_names(self) -> List[str]:
        """返回所有已注册 SubAgent 的名称列表"""
        return list(self._agents.keys())

    @staticmethod
    def create_from_config(config: dict) -> SubAgent:
        """从字典配置创建 SubAgent 实例（不自动注册）

        支持的字段：
          name, description, system_prompt, tools_allowed, skill_ids,
          max_iterations, llm_config_override, input_schema, output_schema,
          on_error, max_retries, timeout, custom_instructions, temperature
        """
        sub_config = SubAgentConfig(
            name=config.get("name", "unnamed"),
            description=config.get("description", ""),
            system_prompt=config.get("system_prompt", ""),
            tools_allowed=config.get("tools_allowed", []),
            skill_ids=config.get("skill_ids", []),
            max_iterations=config.get("max_iterations", 8),
            llm_config_override=config.get("llm_config_override"),
            input_schema=config.get("input_schema"),
            output_schema=config.get("output_schema"),
            on_error=config.get("on_error", "stop"),
            max_retries=config.get("max_retries", 1),
            timeout=config.get("timeout", 0),
            custom_instructions=config.get("custom_instructions", ""),
            temperature=config.get("temperature"),
        )
        return SubAgent(sub_config)

    def remove(self, name: str) -> bool:
        """移除一个 SubAgent，返回是否成功"""
        removed = self._agents.pop(name, None) is not None
        self._configs.pop(name, None)
        return removed

    def clear(self) -> None:
        """清空所有注册"""
        self._agents.clear()
        self._configs.clear()


# ── 内置通用 SubAgent 定义 ─────────────────────────────────────

# 通用意图分析 SubAgent
_INTENT_ANALYZER_CONFIG = {
    "name": "intent_analyzer",
    "description": "分析用户意图，提取主题、受众、场景、复杂度等关键信息",
    "system_prompt": (
        "你是一个专业的意图分析助手。你的任务是深入分析用户的请求，提取以下关键信息：\n"
        "1. **主题(topic)** — 用户想做什么（核心主题）\n"
        "2. **受众(audience)** — 内容面向谁（如技术决策者、工程师、客户）\n"
        "3. **场景(scenario)** — 用途/场合（如汇报、技术分享、发布会）\n"
        "4. **复杂度(complexity)** — 简单/中等/复杂\n"
        "5. **重点领域(focus_areas)** — 用户关注的核心内容\n"
        "6. **预计规模(estimated_slides)** — 预估的页数/章节数\n"
        "7. **风格(style)** — 正式/轻松/学术\n\n"
        "请以 JSON 格式输出分析结果，包含上述所有字段。\n"
        "如果用户没有明确指定某项，请根据上下文合理推断，并标注 inferred: true。\n"
        "输出格式示例：\n"
        '```json\n{"topic": "...", "audience": "...", "scenario": "...", "complexity": "medium", '
        '"focus_areas": [...], "estimated_slides": 10}\n```'
    ),
    "tools_allowed": ["knowledge_query", "web_search"],
    "skill_ids": [],
    "max_iterations": 3,
    "on_error": "retry",
    "max_retries": 2,
    "timeout": 120,
}

# 通用信息收集 SubAgent
_INFO_COLLECTOR_CONFIG = {
    "name": "info_collector",
    "description": "多轮搜索收集信息，支持知识库查询和联网搜索，自动评估信息质量",
    "system_prompt": (
        "你是一个专业的信息收集助手。你的任务是根据给定主题，系统性地收集相关信息。\n\n"
        "工作原则：\n"
        "1. 先用 knowledge_query 查询本地知识库，再用 web_search 补充外部信息\n"
        "2. 每轮搜索使用不同的查询角度，避免重复\n"
        "3. 对重要来源使用 fetch_url 获取完整内容\n"
        "4. 记录所有来源（URL、知识库路径）\n"
        "5. 评估每条信息的质量和相关性\n\n"
        "输出格式（JSON）：\n"
        "```json\n"
        "{\n"
        '  "collected_info": "收集到的完整信息（markdown 格式）",\n'
        '  "sources": [{"type": "kb/web", "url": "...", "title": "...", "relevance": 0-10}],\n'
        '  "quality_score": 0-100,\n'
        '  "rounds_used": N,\n'
        '  "gaps": ["尚未覆盖的主题"]\n'
        "}\n"
        "```"
    ),
    "tools_allowed": ["knowledge_query", "web_search", "fetch_url", "list_projects"],
    "skill_ids": [],
    "max_iterations": 10,
    "on_error": "continue",
    "timeout": 600,
}

# 通用内容规划 SubAgent
_CONTENT_PLANNER_CONFIG = {
    "name": "content_planner",
    "description": "根据收集的信息规划内容结构（章节、页面、大纲）",
    "system_prompt": (
        "你是一个专业的内容规划助手。你的任务是根据已收集的信息和用户意图，规划完整的内容结构。\n\n"
        "工作原则：\n"
        "1. 内容必须有清晰的逻辑主线\n"
        "2. 每个章节/页面包含：标题、核心要点（3-5条）、预期内容摘要\n"
        "3. 考虑受众的知识背景，适当安排从浅到深\n"
        "4. 确保重点内容有足够篇幅\n"
        "5. 为数据来源标注引用标记\n\n"
        "输出完整的结构化大纲（markdown 格式），每个章节用 --- 分隔。"
    ),
    "tools_allowed": [],
    "skill_ids": [],
    "max_iterations": 3,
    "on_error": "retry",
    "max_retries": 2,
    "timeout": 180,
}

# 通用质量审核 SubAgent
_QUALITY_REVIEWER_CONFIG = {
    "name": "quality_reviewer",
    "description": "审核内容质量，检查完整性、准确性、逻辑性，给出评分和改进建议",
    "system_prompt": (
        "你是一个严格的内容质量审核专家。你的任务是对给定的内容进行全面审核。\n\n"
        "审核维度：\n"
        "1. **完整性(completeness)** — 是否覆盖了主题的所有重要方面（0-100分）\n"
        "2. **准确性(accuracy)** — 数据和事实是否准确，有无明显错误（0-100分）\n"
        "3. **逻辑性(logic)** — 论述是否清晰，章节之间是否有逻辑衔接（0-100分）\n"
        "4. **深度(depth)** — 分析是否有深度，不是泛泛而谈（0-100分）\n"
        "5. **可读性(readability)** — 表达是否清晰易懂（0-100分）\n\n"
        "输出格式（JSON）：\n"
        "```json\n"
        "{\n"
        '  "overall_score": 0-100,\n'
        '  "scores": {"completeness": N, "accuracy": N, "logic": N, "depth": N, "readability": N},\n'
        '  "issues": ["问题1", "问题2"],\n'
        '  "suggestions": ["改进建议1", "改进建议2"],\n'
        '  "verdict": "pass/revise/reject"\n'
        "}\n"
        "```"
    ),
    "tools_allowed": ["web_search", "fetch_url"],
    "skill_ids": [],
    "max_iterations": 3,
    "on_error": "continue",
    "timeout": 180,
}

# 通用摘要精炼 SubAgent
_SUMMARIZER_CONFIG = {
    "name": "summarizer",
    "description": "对长文本进行摘要、去重、精炼，保留核心信息",
    "system_prompt": (
        "你是一个专业的文本精炼助手。你的任务是对给定的长文本进行摘要和整理。\n\n"
        "工作原则：\n"
        "1. 删除重复和冗余信息\n"
        "2. 保留关键数据和结论\n"
        "3. 合并相似观点\n"
        "4. 保持原文的逻辑结构\n"
        "5. 标注信息来源\n\n"
        "输出精炼后的文本（markdown 格式），并在末尾附上：\n"
        "- 压缩比（精炼后字数 / 原文字数）\n"
        "- 保留的关键信息条数"
    ),
    "tools_allowed": [],
    "skill_ids": [],
    "max_iterations": 2,
    "on_error": "continue",
    "timeout": 300,
}

# 通用网络研究 SubAgent
_WEB_RESEARCHER_CONFIG = {
    "name": "web_researcher",
    "description": "深度网络研究，通过多轮搜索和页面抓取，系统性收集某一主题的外部资料",
    "system_prompt": (
        "你是一个专业的网络研究助手。你的任务是对给定主题进行深度研究。\n\n"
        "工作原则：\n"
        "1. 使用 web_search 搜索多个角度的关键词\n"
        "2. 对重要结果使用 fetch_url 获取完整页面内容\n"
        "3. 交叉验证重要数据（多来源比对）\n"
        "4. 区分事实和观点\n"
        "5. 记录所有引用来源\n\n"
        "输出结构化的研究报告（markdown 格式），包含：\n"
        "- 核心发现（3-5条）\n"
        "- 详细分析（按子主题分节）\n"
        "- 来源列表（URL + 可信度评分）\n"
        "- 研究局限性说明"
    ),
    "tools_allowed": ["web_search", "fetch_url"],
    "skill_ids": [],
    "max_iterations": 8,
    "on_error": "continue",
    "timeout": 300,
}

# 通用内容生成 SubAgent
_CONTENT_GENERATOR_CONFIG = {
    "name": "content_generator",
    "description": "根据大纲和参考资料，生成完整的正文内容",
    "system_prompt": (
        "你是一个专业的内容生成助手。你的任务是根据给定的大纲和参考资料，生成高质量的正文内容。\n\n"
        "工作原则：\n"
        "1. 严格按照大纲结构生成内容\n"
        "2. 每个章节内容充实，有具体数据和案例支撑\n"
        "3. 保持专业但易懂的语言风格\n"
        "4. 为关键数据标注来源\n"
        "5. 适当使用图表/列表提升可读性\n\n"
        "输出完整的正文内容（markdown 格式）。"
    ),
    "tools_allowed": ["web_search", "fetch_url"],
    "skill_ids": [],
    "max_iterations": 5,
    "on_error": "retry",
    "max_retries": 2,
    "timeout": 300,
}


# ── 构建内置注册表 ─────────────────────────────────────────────

def build_default_sub_agent_registry() -> SubAgentRegistry:
    """构建包含所有内置通用 SubAgent 的注册表。

    内置 SubAgent 均为通用能力，不限于特定工作流：
      - intent_analyzer   — 意图分析
      - info_collector    — 信息收集
      - content_planner   — 内容规划
      - quality_reviewer  — 质量审核
      - summarizer        — 摘要精炼
      - web_researcher    — 网络研究
      - content_generator — 内容生成
    """
    registry = SubAgentRegistry()

    builtin_configs = [
        _INTENT_ANALYZER_CONFIG,
        _INFO_COLLECTOR_CONFIG,
        _CONTENT_PLANNER_CONFIG,
        _QUALITY_REVIEWER_CONFIG,
        _SUMMARIZER_CONFIG,
        _WEB_RESEARCHER_CONFIG,
        _CONTENT_GENERATOR_CONFIG,
    ]

    for config in builtin_configs:
        registry.register_config(config)

    return registry
