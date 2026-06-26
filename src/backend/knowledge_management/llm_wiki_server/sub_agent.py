"""
SubAgent 通用子智能体
=====================
每个 SubAgent 拥有独立的：
  - system prompt（角色定义 + 任务指令）
  - 工具白名单（只暴露声明的工具）
  - Skill 绑定（加载并注入 skill prompt）
  - LLM 配置（可选独立配置，允许不同步骤用不同模型）
  - 对话上下文（不复用父 Agent 的历史）

SubAgent 内部调用 agent_loop.run_agent_stream()，
复用 KV Cache 优化和上下文压缩能力。

SSE 事件（与 agent_loop 兼容，前端无需改动）：
  subagent_start  → {agent, description, tools_allowed, max_iterations}
  agent_status    → 透传（thinking/compressed）
  tool_call       → 透传
  tool_result     → 透传
  message         → 透传（流式文字 delta/complete）
  error           → 透传
  done            → 透传（agent_loop 的 done）
  subagent_done   → {agent, status, elapsed_seconds, iterations, tools_used, output_preview}
"""

import json
import time
import traceback
from dataclasses import dataclass, field
from typing import Dict, List, Any, Generator, Optional


# ── SSE 工具函数 ───────────────────────────────────────────────

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _parse_sse_event(event_str: str) -> Optional[tuple]:
    """解析 'event: X\ndata: {...}\n\n' → (event_name, data_dict)，失败返回 None"""
    event_name = None
    data_str = None
    for line in event_str.strip().split("\n"):
        if line.startswith("event: "):
            event_name = line[7:].strip()
        elif line.startswith("data: "):
            data_str = line[6:]
    if event_name and data_str:
        try:
            return event_name, json.loads(data_str)
        except json.JSONDecodeError:
            return event_name, {}
    return None


# ── 配置与结果数据类 ──────────────────────────────────────────

@dataclass
class SubAgentConfig:
    """SubAgent 配置定义。

    字段说明：
      name               — 唯一标识（也用作显示名称）
      description        — 简短描述（API 展示用）
      system_prompt      — 独立 system prompt，替换 agent_loop 默认 base prompt
      tools_allowed      — 工具白名单（空列表 = 全部工具）
      skill_ids          — 绑定的 skill ID（从 skills_manager 加载）
      max_iterations     — 最大工具调用轮次
      llm_config_override — 可选独立 LLM 配置（允许不同步骤用不同模型/端点）
      input_schema       — 输入数据 JSON Schema（用于上游输出校验）
      output_schema      — 输出数据 JSON Schema（用于下游输入校验）
      on_error           — 错误处理策略: "stop" | "continue" | "retry"
      max_retries        — on_error="retry" 时的最大重试次数
      timeout            — 超时秒数（0 = 无限制）
      custom_instructions — 附加指令（追加到 system_prompt 之后）
      temperature        — LLM 温度（覆盖 agent_loop 默认 0.3）
    """
    name: str
    description: str = ""
    system_prompt: str = ""
    tools_allowed: List[str] = field(default_factory=list)
    skill_ids: List[str] = field(default_factory=list)
    max_iterations: int = 8
    llm_config_override: Optional[Dict] = None
    input_schema: Optional[Dict] = None
    output_schema: Optional[Dict] = None
    on_error: str = "stop"
    max_retries: int = 1
    timeout: int = 0
    custom_instructions: str = ""
    temperature: Optional[float] = None


@dataclass
class SubAgentResult:
    """SubAgent 执行结果。

    字段说明：
      output    — 输出数据（content 为 LLM 最终回答文本）
      messages  — SubAgent 的完整对话历史（可选传递给下一个 SubAgent）
      metadata  — 运行元数据（耗时、迭代次数、使用的工具等）
      status    — "success" | "error" | "timeout"
      error     — 错误信息（仅 status != "success" 时有值）
    """
    output: Dict = field(default_factory=dict)
    messages: List[Dict] = field(default_factory=list)
    metadata: Dict = field(default_factory=dict)
    status: str = "success"
    error: Optional[str] = None


# ── SubAgent 主类 ──────────────────────────────────────────────

class SubAgent:
    """通用子智能体。

    使用方式：
        config  = SubAgentConfig(name="analyzer", system_prompt="你是...")
        agent   = SubAgent(config)
        for event in agent.run(input_data, shared_state, tool_registry, llm_config):
            yield event          # SSE 事件（直接透传给前端）
        result = agent.last_result   # SubAgentResult
    """

    def __init__(self, config: SubAgentConfig):
        self.config = config
        self.name: str = config.name
        self.description: str = config.description
        self.system_prompt: str = config.system_prompt
        self.tools_allowed: List[str] = config.tools_allowed
        self.skill_ids: List[str] = config.skill_ids
        self.max_iterations: int = config.max_iterations
        self.llm_config_override: Optional[Dict] = config.llm_config_override
        self.last_result: Optional[SubAgentResult] = None

    # ── 工具过滤 ─────────────────────────────────────────────

    def get_filtered_tools(self, tool_registry) -> List[dict]:
        """从 ToolRegistry 中过滤出允许的工具（OpenAI function calling 格式）。
        tools_allowed 为空时返回全部工具。
        """
        if not self.tools_allowed:
            return tool_registry.list_tools()
        allowed = set(self.tools_allowed)
        return [t for t in tool_registry.list_tools()
                if t["function"]["name"] in allowed]

    def get_allowed_tool_names(self) -> List[str]:
        """返回允许的工具名列表（用于 API 展示）"""
        return list(self.tools_allowed) if self.tools_allowed else []

    # ── 输入构建 ─────────────────────────────────────────────

    @staticmethod
    def _truncate(value: str, max_chars: int = 8000) -> str:
        if len(value) <= max_chars:
            return value
        return value[:max_chars] + f"\n...[truncated {len(value) - max_chars} chars]"

    def _build_input_message(self, input_data: dict, shared_state: dict) -> str:
        """将 input_data + shared_state 构建为用户消息文本。

        策略：
          - shared_state.step_results → 前序步骤结果摘要（截断防撑爆上下文）
          - input_data               → 当前任务的具体输入字段
          - shared_state.user_input  → 原始用户请求
        """
        parts = []

        # 原始用户请求（如果有）
        user_input = shared_state.get("user_input", "")
        if user_input:
            parts.append(f"## 用户原始请求\n{user_input}")

        # 前序步骤结果摘要
        step_results = shared_state.get("step_results", {})
        if step_results:
            parts.append("\n## 前序步骤结果")
            for step_name, result in step_results.items():
                result_str = json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result
                parts.append(f"### {step_name}\n{self._truncate(result_str, 4000)}")

        # 当前输入字段
        if input_data:
            parts.append("\n## 当前任务输入")
            for key, value in input_data.items():
                if isinstance(value, str):
                    parts.append(f"**{key}**: {self._truncate(value, 6000)}")
                else:
                    parts.append(f"**{key}**: {json.dumps(value, ensure_ascii=False)}")

        return "\n\n".join(parts) if parts else "请执行任务。"

    # ── Skill 加载 ───────────────────────────────────────────

    def _load_skills_prompt(self, skills_manager) -> str:
        """加载绑定的 skill 并构建 prompt 片段"""
        if not self.skill_ids or not skills_manager:
            return ""
        active_skills = []
        for sid in self.skill_ids:
            skill = skills_manager.get_skill_by_id(sid)
            if skill:
                active_skills.append(skill)
        return skills_manager.build_skills_prompt(active_skills) if active_skills else ""

    # ── 主执行入口 ───────────────────────────────────────────

    def run(
        self,
        input_data: dict,
        shared_state: dict,
        tool_registry,
        llm_config: dict,
        skills_manager=None,
        context: dict = None,
    ) -> Generator[str, None, None]:
        """执行 SubAgent，yield SSE 事件字符串。

        执行结束后，结果保存在 self.last_result（SubAgentResult）。

        参数：
          input_data     — 上游传入的输入（含用户原始请求 + 前序步骤结果）
          shared_state   — 工作流共享状态（跨 SubAgent 数据传递）
          tool_registry  — ToolRegistry 实例（从中过滤 tools_allowed）
          llm_config     — 默认 LLM 配置（可被 llm_config_override 覆盖）
          skills_manager — skills_manager 模块（可选，用于加载 skill prompt）
          context        — 运行上下文（request_id, project_id 等）
        """
        from agent_loop import run_agent_stream

        if context is None:
            context = {}

        start_time = time.time()
        timeout = self.config.timeout

        # ── 发送 subagent_start ──
        yield _sse("subagent_start", {
            "agent": self.name,
            "description": self.description,
            "tools_allowed": self.tools_allowed or "all",
            "max_iterations": self.max_iterations,
        })

        # ── 确定 LLM 配置 ──
        effective_llm_config = dict(llm_config)
        if self.llm_config_override:
            effective_llm_config.update(self.llm_config_override)

        # ── 构建 messages ──
        user_message = self._build_input_message(input_data, shared_state)
        messages = [{"role": "user", "content": user_message}]

        # ── 过滤工具 ──
        tools = self.get_filtered_tools(tool_registry)

        # ── 加载 skill prompt ──
        skills_prompt = self._load_skills_prompt(skills_manager)

        # ── 构建 custom_instructions（仅附加指令；system_prompt 作为独立 base）──
        custom_instructions = self.config.custom_instructions or ""

        # ── 跟踪状态 ──
        final_content = ""
        iterations = 0
        tools_used: List[str] = []
        error_msg = None
        attempt = 0
        max_attempts = max(1, self.config.max_retries if self.config.on_error == "retry" else 1)

        while attempt < max_attempts:
            attempt += 1
            final_content = ""
            iterations = 0
            tools_used = []
            error_msg = None

            try:
                for event_str in run_agent_stream(
                    messages=messages,
                    tools=tools,
                    registry=tool_registry,
                    llm_config=effective_llm_config,
                    skills_prompt=skills_prompt,
                    custom_instructions=custom_instructions,
                    max_iterations=self.max_iterations,
                    context=context,
                    system_prompt=self.system_prompt,
                ):
                    # 超时检查
                    if timeout and (time.time() - start_time) > timeout:
                        error_msg = f"SubAgent '{self.name}' timed out after {timeout}s"
                        yield _sse("error", {"message": error_msg})
                        break

                    # 透传所有事件给调用方
                    yield event_str

                    # 解析事件以跟踪状态
                    parsed = _parse_sse_event(event_str)
                    if not parsed:
                        continue
                    event_name, data = parsed
                    if event_name == "message" and data.get("type") == "complete":
                        final_content = data.get("content", "")
                    elif event_name == "done":
                        iterations = data.get("iterations", 0)
                    elif event_name == "tool_call":
                        tool_name = data.get("tool", "")
                        if tool_name and tool_name not in tools_used:
                            tools_used.append(tool_name)
                    elif event_name == "error":
                        error_msg = data.get("message", "")

            except Exception as e:
                error_msg = f"SubAgent '{self.name}' execution error: {str(e)}"
                yield _sse("error", {"message": error_msg, "traceback": traceback.format_exc()[-300:]})

            # 决定是否重试
            if error_msg and self.config.on_error == "retry" and attempt < max_attempts:
                yield _sse("agent_status", {
                    "status": "subagent_retry",
                    "agent": self.name,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "reason": error_msg,
                })
                continue
            break  # 成功或不再重试

        elapsed = time.time() - start_time

        # ── 构建 SubAgentResult ──
        status = "success" if not error_msg else ("timeout" if "timed out" in (error_msg or "") else "error")
        self.last_result = SubAgentResult(
            output={"content": final_content, **{k: v for k, v in input_data.items() if k != "content"}},
            messages=[],  # agent_loop 内部管理 messages，不暴露给外部
            metadata={
                "agent": self.name,
                "elapsed_seconds": round(elapsed, 2),
                "iterations": iterations,
                "tools_used": tools_used,
                "attempt": attempt,
            },
            status=status,
            error=error_msg,
        )

        # ── 发送 subagent_done ──
        yield _sse("subagent_done", {
            "agent": self.name,
            "status": status,
            "elapsed_seconds": round(elapsed, 2),
            "iterations": iterations,
            "tools_used": tools_used,
            "output_preview": final_content[:300] if final_content else "",
            "error": error_msg or None,
        })

    # ── 序列化 ───────────────────────────────────────────────

    def to_dict(self) -> dict:
        """序列化为字典（API 展示用，不含函数）"""
        return {
            "name": self.name,
            "description": self.description,
            "system_prompt_preview": self.system_prompt[:200] if self.system_prompt else "",
            "tools_allowed": self.tools_allowed or "all",
            "skill_ids": self.skill_ids,
            "max_iterations": self.max_iterations,
            "on_error": self.config.on_error,
            "timeout": self.config.timeout,
        }
