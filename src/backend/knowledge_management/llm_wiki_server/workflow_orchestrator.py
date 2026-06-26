"""
Workflow 工作流编排器
=====================
将多个 SubAgent 按步骤编排为完整的工作流。

核心能力：
  1. 步骤顺序执行 — SubAgent 链式调用
  2. 共享状态流转 — shared_state 跨步骤传递数据
  3. 输入/输出映射 — 灵活的字段映射（$.step_results.xxx.field）
  4. 条件执行 — 步骤可设条件，不满足时跳过
  5. 等待用户确认 — await_user 步骤暂停等待用户输入
  6. 错误处理 — 每步可独立配置错误策略
  7. SSE 兼容 — 所有事件格式与 agent_loop 一致

SSE 事件类型：
  workflow_start   → {workflow, total_steps, step_names}
  subagent_start   → 透传（SubAgent 内部事件）
  agent_status     → 透传
  tool_call        → 透传
  tool_result      → 透传
  message          → 透传
  subagent_done    → 透传
  workflow_step    → {step, agent, status, step_index, total_steps}
  workflow_await   → {step, agent, message, data, workflow_id}  (等待用户)
  workflow_resume  → {step, agent, action}  (用户操作后恢复)
  workflow_done    → {total_steps, duration, step_results_summary}
  error            → 错误信息
  done             → {iterations, engine: "workflow"}
"""

import json
import re
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Any, Generator, Optional


# ── SSE 工具函数 ───────────────────────────────────────────────

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _parse_sse_event(event_str: str) -> Optional[tuple]:
    """解析 SSE 事件字符串"""
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


# ── 工作流状态存储（等待用户确认用）─────────────────────────────
_workflow_states: Dict[str, dict] = {}


# ── 数据类定义 ──────────────────────────────────────────────────

@dataclass
class GotoRule:
    """条件跳转规则。

    当条件满足时，Orchestrator 跳转到 target 步骤（通过步骤名匹配）。

    字段说明：
      condition  — 条件表达式，支持 {{step_results.xxx.field}} 模板
      target     — 目标步骤的 agent_name（必须是工作流中已定义的 SubAgent 名称）
      reason     — 跳转原因（日志 + SSE 事件用）
      max_jumps  — 此规则最多触发次数（防止无限回退，0=不限制）
    """
    condition: str
    target: str
    reason: str = ""
    max_jumps: int = 2


@dataclass
class WorkflowStep:
    """工作流步骤定义。

    字段说明：
      agent_name      — SubAgent 名称（必须在 SubAgentRegistry 中注册）
      input_mapping   — 输入映射：{"字段名": "$.path.to.value"}
      output_mapping  — 输出映射：{"result_key": "$.step_results.agent_name"}
      condition       — 条件表达式（空=总是执行）；支持 {{step.xxx.field}} 模板
      on_error        — 错误处理："stop" | "skip" | "continue" | "goto:<agent_name>"
      goto_rules      — 条件跳转规则列表（步骤成功执行后评估）
      goto_on_failure — 执行失败时跳转到的步骤 agent_name（快捷语法，等价于 on_error="goto:xxx"）
      max_revisits    — 此步骤最多被重入次数（0=不限制，防止无限循环）
      await_user      — 是否等待用户确认（暂停并等待用户操作）
      await_message   — 等待用户时显示的提示消息
      await_payload   — 等待用户时附加的数据（会发送到前端）
      timeout         — 步骤超时秒数（覆盖 SubAgent 的 timeout）
      skip_if_empty   — 如果输入映射结果为空则跳过此步骤
    """
    agent_name: str
    input_mapping: Dict[str, str] = field(default_factory=dict)
    output_mapping: Dict[str, str] = field(default_factory=dict)
    condition: str = ""
    on_error: str = "stop"
    goto_rules: List[Any] = field(default_factory=list)
    goto_on_failure: str = ""
    max_revisits: int = 2
    await_user: bool = False
    await_message: str = "请确认后继续"
    await_payload: Dict[str, Any] = field(default_factory=dict)
    timeout: Optional[int] = None
    skip_if_empty: bool = False


@dataclass
class Workflow:
    """工作流定义。

    字段说明：
      name               — 工作流唯一名称
      description        — 简短描述
      steps              — 步骤列表
      shared_state_init  — 共享状态的初始值
      on_step_error      — 全局错误兜底策略（可被单步 on_error 覆盖）
    """
    name: str
    description: str = ""
    steps: List[WorkflowStep] = field(default_factory=list)
    shared_state_init: Dict[str, Any] = field(default_factory=dict)
    on_step_error: str = "stop"
    max_total_revisits: int = 10  # 整个工作流最多回退次数（全局安全阀）
    use_brain: bool = False       # 是否启用 BrainAgent 做动态决策


# ── 路径解析工具 ────────────────────────────────────────────────

_PATH_RE = re.compile(r"^\$(?:\.(.+))?$")


def _resolve_path(path: str, state: dict) -> Any:
    """解析 $.a.b.c 路径到 state 中的值。

    支持：
      $.user_input              → state["user_input"]
      $.step_results.analyzer   → state["step_results"]["analyzer"]
      $.step_results.a.field    → state["step_results"]["a"]["field"]
    """
    m = _PATH_RE.match(path.strip())
    if not m:
        return path  # 非路径，原样返回

    keys_str = m.group(1) or ""
    if not keys_str:
        return state

    keys = keys_str.split(".")
    current = state
    for key in keys:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return None  # 路径不存在
    return current


def _set_path(path: str, state: dict, value: Any) -> None:
    """将 value 写入 state 的指定路径。

    例：$.step_results.analyzer → state["step_results"]["analyzer"] = value
    """
    m = _PATH_RE.match(path.strip())
    if not m:
        return

    keys_str = m.group(1) or ""
    if not keys_str:
        return

    keys = keys_str.split(".")
    current = state
    for key in keys[:-1]:
        if key not in current or not isinstance(current.get(key), dict):
            current[key] = {}
        current = current[key]
    if keys:
        current[keys[-1]] = value


def _evaluate_condition(condition: str, state: dict) -> bool:
    """评估条件表达式。

    支持：
      {{step.analyzer.status}} == "success"
      {{step_results.info_collector.quality_score}} > 60
      {{user_input}} contains "PPT"
    """
    if not condition or not condition.strip():
        return True

    expr = condition.strip()

    # 替换 {{path}} 模板变量
    def _replace_var(m):
        var_path = m.group(1).strip()
        # 尝试作为 $.xxx 路径解析
        if not var_path.startswith("$"):
            var_path = f"$.{var_path}"
        val = _resolve_path(var_path, state)
        if val is None:
            return "None"
        if isinstance(val, str):
            return repr(val)
        return str(val)

    expr = re.sub(r"\{\{(.+?)\}\}", _replace_var, expr)

    # 替换 contains 运算符
    expr = expr.replace(" contains ", " in ")

    try:
        return bool(eval(expr, {"__builtins__": {}}, {
            "len": len, "str": str, "bool": bool, "int": int, "float": float,
            "True": True, "False": False, "None": None,
        }))
    except Exception:
        return True  # 条件解析失败时默认执行


# ── WorkflowRegistry（工作流注册表）─────────────────────────────

class WorkflowRegistry:
    """工作流注册表：管理所有已定义的工作流。"""

    def __init__(self):
        self._workflows: Dict[str, Workflow] = {}

    def register(self, workflow: Workflow) -> None:
        self._workflows[workflow.name] = workflow

    def get(self, name: str) -> Optional[Workflow]:
        return self._workflows.get(name)

    def list_workflows(self) -> List[dict]:
        result = []
        for name, wf in self._workflows.items():
            result.append({
                "name": wf.name,
                "description": wf.description,
                "steps_count": len(wf.steps),
                "step_names": [s.agent_name for s in wf.steps],
            })
        return result

    def list_names(self) -> List[str]:
        return list(self._workflows.keys())

    def remove(self, name: str) -> bool:
        """删除一个工作流，返回是否成功"""
        return self._workflows.pop(name, None) is not None

    def register_from_dict(self, config: dict) -> Workflow:
        """从字典配置创建工作流并注册。

        config 格式:
        {
            "name": "my_flow",
            "description": "...",
            "use_brain": false,
            "max_total_revisits": 5,
            "steps": [
                {
                    "agent_name": "intent_analyzer",
                    "input_mapping": {...},
                    "output_mapping": {...},
                    "condition": "",
                    "on_error": "stop",
                    "goto_on_failure": "",
                    "goto_rules": [{"condition": "...", "target": "...", "reason": "...", "max_jumps": 2}],
                    "max_revisits": 2,
                    "await_user": false,
                    "await_message": "",
                    "timeout": null,
                    "skip_if_empty": false
                }
            ]
        }
        """
        steps = []
        for step_config in config.get("steps", []):
            # 解析 goto_rules
            goto_rules = []
            for rule in step_config.get("goto_rules", []):
                if isinstance(rule, dict):
                    goto_rules.append(GotoRule(
                        condition=rule.get("condition", ""),
                        target=rule.get("target", ""),
                        reason=rule.get("reason", ""),
                        max_jumps=rule.get("max_jumps", 2),
                    ))
                elif isinstance(rule, GotoRule):
                    goto_rules.append(rule)

            step = WorkflowStep(
                agent_name=step_config.get("agent_name", ""),
                input_mapping=step_config.get("input_mapping", {}),
                output_mapping=step_config.get("output_mapping", {}),
                condition=step_config.get("condition", ""),
                on_error=step_config.get("on_error", "stop"),
                goto_rules=goto_rules,
                goto_on_failure=step_config.get("goto_on_failure", ""),
                max_revisits=step_config.get("max_revisits", 2),
                await_user=step_config.get("await_user", False),
                await_message=step_config.get("await_message", "请确认后继续"),
                await_payload=step_config.get("await_payload", {}),
                timeout=step_config.get("timeout"),
                skip_if_empty=step_config.get("skip_if_empty", False),
            )
            steps.append(step)

        workflow = Workflow(
            name=config.get("name", ""),
            description=config.get("description", ""),
            steps=steps,
            shared_state_init=config.get("shared_state_init", {}),
            on_step_error=config.get("on_step_error", "stop"),
            max_total_revisits=config.get("max_total_revisits", 10),
            use_brain=config.get("use_brain", False),
        )
        self.register(workflow)
        return workflow

    def get_detail(self, name: str) -> Optional[dict]:
        """获取工作流完整配置（含步骤详情）"""
        wf = self.get(name)
        if not wf:
            return None

        steps_detail = []
        for step in wf.steps:
            goto_rules = []
            for rule in step.goto_rules:
                if isinstance(rule, GotoRule):
                    goto_rules.append({
                        "condition": rule.condition,
                        "target": rule.target,
                        "reason": rule.reason,
                        "max_jumps": rule.max_jumps,
                    })

            steps_detail.append({
                "agent_name": step.agent_name,
                "input_mapping": step.input_mapping,
                "output_mapping": step.output_mapping,
                "condition": step.condition,
                "on_error": step.on_error,
                "goto_rules": goto_rules,
                "goto_on_failure": step.goto_on_failure,
                "max_revisits": step.max_revisits,
                "await_user": step.await_user,
                "await_message": step.await_message,
                "timeout": step.timeout,
                "skip_if_empty": step.skip_if_empty,
            })

        return {
            "name": wf.name,
            "description": wf.description,
            "use_brain": wf.use_brain,
            "max_total_revisits": wf.max_total_revisits,
            "on_step_error": wf.on_step_error,
            "steps": steps_detail,
        }


# ── WorkflowOrchestrator 主类 ──────────────────────────────────

class WorkflowOrchestrator:
    """工作流编排执行器。

    使用方式：
        orch = WorkflowOrchestrator(
            workflow=wf,
            agent_registry=sub_agent_registry,
            tool_registry=tool_registry,
            llm_config=llm_config,
            skills_manager=skills_mgr,
        )
        for event in orch.run(user_input="帮我做一份PPT"):
            yield event  # SSE 事件
    """

    def __init__(
        self,
        workflow: Workflow,
        agent_registry,       # SubAgentRegistry 实例
        tool_registry,        # ToolRegistry 实例
        llm_config: dict,
        skills_manager=None,
        log_fn=None,
        brain=None,           # BrainAgent 实例（可选）
    ):
        self.workflow = workflow
        self.agent_registry = agent_registry
        self.tool_registry = tool_registry
        self.llm_config = llm_config
        self.skills_manager = skills_manager
        self.brain = brain
        self._log = log_fn or (lambda msg: None)
        # 构建 agent_name → step_index 映射（用于 goto 跳转）
        self._name_to_idx: Dict[str, int] = {}
        for idx, step in enumerate(workflow.steps):
            self._name_to_idx[step.agent_name] = idx

    def _resolve_goto_target(
        self, step: WorkflowStep, result, shared_state: dict,
        total_revisits: int, visit_counts: dict,
    ) -> Optional[tuple]:
        """解析失败时的 goto 目标。返回 (target_idx, target_name) 或 None。

        优先级：goto_on_failure > on_error="goto:xxx"
        """
        if total_revisits >= self.workflow.max_total_revisits:
            self._log(f"goto blocked: max_total_revisits {self.workflow.max_total_revisits} reached")
            return None

        target_name = ""
        if step.goto_on_failure:
            target_name = step.goto_on_failure
        elif step.on_error.startswith("goto:"):
            target_name = step.on_error[5:]

        if not target_name:
            return None
        if target_name not in self._name_to_idx:
            self._log(f"goto target '{target_name}' not found in workflow steps")
            return None

        target_idx = self._name_to_idx[target_name]
        target_step = self.workflow.steps[target_idx]
        target_visits = visit_counts.get(target_name, 0)
        if target_step.max_revisits > 0 and target_visits >= target_step.max_revisits + 1:
            self._log(f"goto blocked: '{target_name}' already visited {target_visits} times")
            return None

        return (target_idx, target_name)

    def _evaluate_goto_rules(
        self, step: WorkflowStep, shared_state: dict,
        total_revisits: int, visit_counts: dict,
    ) -> Optional[tuple]:
        """评估 goto_rules 列表，返回第一个命中的 (target_idx, target_name, reason)。

        goto_rules 可以是 GotoRule 实例或字典。
        """
        if not step.goto_rules:
            return None
        if total_revisits >= self.workflow.max_total_revisits:
            return None

        for rule in step.goto_rules:
            if isinstance(rule, GotoRule):
                condition = rule.condition
                target = rule.target
                reason = rule.reason
                max_jumps = rule.max_jumps
            elif isinstance(rule, dict):
                condition = rule.get("condition", "")
                target = rule.get("target", "")
                reason = rule.get("reason", "")
                max_jumps = rule.get("max_jumps", 2)
            else:
                continue

            if not target or target not in self._name_to_idx:
                continue

            # 检查跳转次数
            goto_key = f"_goto_{step.agent_name}_to_{target}"
            jump_count = shared_state.get(goto_key, 0)
            if max_jumps > 0 and jump_count >= max_jumps:
                continue

            if _evaluate_condition(condition, shared_state):
                shared_state[goto_key] = jump_count + 1
                return (self._name_to_idx[target], target, reason)

        return None

    def _ask_brain(
        self, step: WorkflowStep, step_index: int,
        shared_state: dict, agent,
    ) -> Generator[str, None, Optional[dict]]:
        """调用 BrainAgent 做动态决策。

        返回 Brain 的决策 dict 或 None。
        """
        if not self.brain:
            return None

        yield _sse("agent_status", {
            "status": "brain_thinking",
            "step": step_index,
            "agent": step.agent_name,
        })

        try:
            decision = self.brain.decide(
                current_step=step.agent_name,
                step_result=shared_state.get("step_results", {}).get(step.agent_name, {}),
                shared_state=shared_state,
                available_steps=[
                    {"name": s.agent_name, "description": self.agent_registry.get(s.agent_name).description
                     if self.agent_registry.get(s.agent_name) else ""}
                    for s in self.workflow.steps
                ],
                workflow_name=self.workflow.name,
                llm_config=self.llm_config,
            )
            return decision
        except Exception as e:
            self._log(f"BrainAgent error: {e}")
            yield _sse("agent_status", {
                "status": "brain_error", "error": str(e),
            })
            return None

    def _resolve_input(self, mapping: Dict[str, str], shared_state: dict) -> dict:
        """解析输入映射，构建 SubAgent 的 input_data"""
        input_data = {}
        for field_name, path in mapping.items():
            value = _resolve_path(path, shared_state)
            if value is not None:
                input_data[field_name] = value
        return input_data

    def _store_output(self, mapping: Dict[str, str], shared_state: dict,
                      agent_name: str, result_output: dict) -> None:
        """按输出映射将 SubAgent 结果写入 shared_state"""
        if mapping:
            for result_key, path in mapping.items():
                value = result_output.get(result_key, result_output)
                _set_path(path, shared_state, value)
        else:
            # 默认：按 agent_name 存入 step_results
            _set_path(f"$.step_results.{agent_name}", shared_state, result_output)

    def _wait_for_user(
        self,
        workflow_id: str,
        step: WorkflowStep,
        step_index: int,
        total_steps: int,
        shared_state: dict,
    ) -> Generator[str, None, Optional[dict]]:
        """暂停工作流等待用户操作，yield 心跳事件。

        返回用户操作结果 dict（action, edited_content, feedback 等），
        或 None（超时/取消）。
        """
        # 存入等待状态
        _workflow_states[workflow_id] = {
            "stage": step.agent_name,
            "action": None,
            "edited_content": "",
            "feedback": "",
            "payload": {},
            "updated_at": time.time(),
        }

        payload = {
            "step": step_index,
            "agent": step.agent_name,
            "message": step.await_message,
            "workflow_id": workflow_id,
            **step.await_payload,
        }

        # 将 step_results 的最新状态放入 payload
        step_results = shared_state.get("step_results", {})
        if step.agent_name in step_results:
            payload["step_result"] = step_results[step.agent_name]

        yield _sse("workflow_await", payload)

        # 轮询等待用户操作
        last_hb = time.time()
        max_wait = 3600  # 最长等待 1 小时

        while True:
            state = _workflow_states.get(workflow_id, {})
            action = state.get("action")

            if action:
                result = {
                    "action": action,
                    "edited_content": state.get("edited_content", ""),
                    "feedback": state.get("feedback", ""),
                    "payload": state.get("payload", {}),
                }
                _workflow_states.pop(workflow_id, None)
                yield _sse("workflow_resume", {
                    "step": step_index,
                    "agent": step.agent_name,
                    "action": action,
                })
                return result

            # 超时检查
            if time.time() - state.get("updated_at", 0) > max_wait:
                _workflow_states.pop(workflow_id, None)
                yield _sse("error", {
                    "message": f"Workflow '{self.workflow.name}' timed out waiting for user at step '{step.agent_name}'",
                })
                return None

            # 心跳
            if time.time() - last_hb >= 10:
                yield _sse("workflow_await", {
                    **payload,
                    "heartbeat": True,
                    "waiting_since": state.get("updated_at", 0),
                })
                last_hb = time.time()

            time.sleep(1)

    def run(
        self,
        user_input: str,
        initial_state: dict = None,
        context: dict = None,
        workflow_id: str = None,
    ) -> Generator[str, None, None]:
        """执行工作流，yield SSE 事件。

        参数：
          user_input    — 用户原始输入
          initial_state — 额外的初始状态（会与 shared_state_init 合并）
          context       — 运行上下文（request_id 等）
          workflow_id   — 工作流实例 ID（用于 await_user 状态管理，不传则自动生成）
        """
        if context is None:
            context = {}
        if not workflow_id:
            workflow_id = str(uuid.uuid4())[:8]

        start_time = time.time()
        total_steps = len(self.workflow.steps)

        # ── 初始化 shared_state ──
        shared_state = dict(self.workflow.shared_state_init)
        shared_state["user_input"] = user_input
        shared_state["workflow_id"] = workflow_id
        shared_state.setdefault("step_results", {})
        if initial_state:
            shared_state.update(initial_state)

        # ── workflow_start 事件 ──
        yield _sse("workflow_start", {
            "workflow": self.workflow.name,
            "workflow_id": workflow_id,
            "description": self.workflow.description,
            "total_steps": total_steps,
            "step_names": [s.agent_name for s in self.workflow.steps],
        })

        self._log(f"[Workflow:{workflow_id}] start '{self.workflow.name}' input={user_input[:100]}")

        # ── 回退跟踪器 ──
        step_visit_counts: Dict[str, int] = {}   # agent_name → 已执行次数
        total_revisits = 0                        # 全局回退计数
        goto_reasons: List[dict] = []             # 回退历史（日志用）

        # ── while + cursor 主循环（支持 goto 回退）──
        cursor = 0
        while cursor < total_steps:
            step = self.workflow.steps[cursor]
            step_index = cursor + 1
            agent_name = step.agent_name

            # 回退次数检查
            visit_count = step_visit_counts.get(agent_name, 0)
            if step.max_revisits > 0 and visit_count >= step.max_revisits + 1:
                yield _sse("workflow_step", {
                    "step": step_index, "agent": agent_name,
                    "status": "skipped", "reason": "max_revisits_exceeded",
                    "visits": visit_count, "max": step.max_revisits + 1,
                    "total_steps": total_steps,
                })
                self._log(f"[Workflow:{workflow_id}] step {step_index} '{agent_name}' skipped (max visits {visit_count})")
                cursor += 1
                continue

            # 记录本次执行
            step_visit_counts[agent_name] = visit_count + 1

            # ── 条件检查 ──
            if step.condition:
                if not _evaluate_condition(step.condition, shared_state):
                    yield _sse("workflow_step", {
                        "step": step_index, "agent": agent_name,
                        "status": "skipped", "reason": "condition_not_met",
                        "total_steps": total_steps,
                    })
                    self._log(f"[Workflow:{workflow_id}] step {step_index} '{agent_name}' skipped (condition)")
                    cursor += 1
                    continue

            # ── 解析输入 ──
            input_data = self._resolve_input(step.input_mapping, shared_state)
            if step.skip_if_empty and not input_data:
                yield _sse("workflow_step", {
                    "step": step_index, "agent": agent_name,
                    "status": "skipped", "reason": "empty_input",
                    "total_steps": total_steps,
                })
                cursor += 1
                continue

            yield _sse("workflow_step", {
                "step": step_index, "agent": agent_name,
                "status": "running", "total_steps": total_steps,
                "visit": visit_count + 1,
            })
            self._log(f"[Workflow:{workflow_id}] step {step_index} '{agent_name}' start (visit {visit_count + 1})")

            # ── 获取 SubAgent ──
            agent = self.agent_registry.get(agent_name)
            if not agent:
                error_msg = f"SubAgent '{agent_name}' not found in registry"
                yield _sse("error", {"message": error_msg})
                goto_target = self._resolve_goto_target(step, None, shared_state, total_revisits, step_visit_counts)
                if goto_target is not None:
                    goto_reasons.append({"from": agent_name, "to": goto_target[1], "reason": error_msg})
                    total_revisits += 1
                    cursor = goto_target[0]
                    continue
                if step.on_error == "skip" or self.workflow.on_step_error == "skip":
                    cursor += 1
                    continue
                yield _sse("workflow_done", {
                    "workflow": self.workflow.name, "status": "error",
                    "failed_step": step_index, "error": error_msg,
                })
                yield _sse("done", {"iterations": step_index, "engine": "workflow", "error": True})
                return

            # 覆盖 timeout
            if step.timeout is not None:
                agent.config.timeout = step.timeout

            # ── 执行 SubAgent ──
            step_error = None
            try:
                for event_str in agent.run(
                    input_data=input_data,
                    shared_state=shared_state,
                    tool_registry=self.tool_registry,
                    llm_config=self.llm_config,
                    skills_manager=self.skills_manager,
                    context={**context, "workflow_id": workflow_id, "step": step_index},
                ):
                    yield event_str
            except Exception as e:
                step_error = f"Step '{agent_name}' execution error: {str(e)}"
                yield _sse("error", {"message": step_error})

            # ── 检查结果 ──
            result = agent.last_result
            if result and result.status == "error":
                step_error = result.error or f"SubAgent '{agent_name}' returned error"

            # ── 错误处理（支持 goto）──
            if step_error:
                self._log(f"[Workflow:{workflow_id}] step {step_index} '{agent_name}' error: {step_error}")
                shared_state["step_results"][agent_name] = {"status": "error", "error": step_error}

                goto_target = self._resolve_goto_target(step, result, shared_state, total_revisits, step_visit_counts)
                if goto_target is not None:
                    target_idx, target_name = goto_target
                    yield _sse("workflow_goto", {
                        "from_step": step_index, "from_agent": agent_name,
                        "to_step": target_idx + 1, "to_agent": target_name,
                        "reason": step_error,
                        "total_revisits": total_revisits + 1,
                    })
                    goto_reasons.append({"from": agent_name, "to": target_name, "reason": step_error})
                    total_revisits += 1
                    cursor = target_idx
                    continue

                error_action = step.on_error or self.workflow.on_step_error
                if error_action == "skip":
                    cursor += 1
                    continue
                elif error_action == "continue":
                    pass  # 继续到下方 goto_rules 评估
                else:  # "stop"
                    yield _sse("workflow_done", {
                        "workflow": self.workflow.name, "status": "error",
                        "failed_step": step_index, "error": step_error,
                        "duration_seconds": round(time.time() - start_time, 2),
                        "goto_history": goto_reasons,
                    })
                    yield _sse("done", {"iterations": step_index, "engine": "workflow", "error": True})
                    return
            else:
                # 成功：存储输出
                if result:
                    self._store_output(step.output_mapping, shared_state, agent_name, result.output)
                    shared_state["step_results"][agent_name] = {
                        "status": "success", **result.output,
                        "_metadata": result.metadata,
                    }
                else:
                    shared_state["step_results"][agent_name] = {"status": "unknown"}

            # ── 等待用户确认 ──
            if step.await_user:
                user_response = yield from self._wait_for_user(
                    workflow_id=workflow_id, step=step,
                    step_index=step_index, total_steps=total_steps,
                    shared_state=shared_state,
                )
                if user_response is None or user_response.get("action") == "cancel":
                    yield _sse("workflow_done", {
                        "workflow": self.workflow.name, "status": "cancelled",
                        "cancelled_at_step": step_index,
                        "duration_seconds": round(time.time() - start_time, 2),
                    })
                    yield _sse("done", {"iterations": step_index, "engine": "workflow", "cancelled": True})
                    return

                shared_state[f"{agent_name}_user_response"] = user_response
                if user_response.get("edited_content"):
                    edited = user_response["edited_content"]
                    try:
                        edited_data = json.loads(edited) if isinstance(edited, str) else edited
                        shared_state["step_results"][agent_name] = {"status": "user_edited", **edited_data}
                    except (json.JSONDecodeError, TypeError):
                        shared_state["step_results"][agent_name]["user_edit"] = edited

                # 用户操作后也可能触发回退（通过 brain 或 goto_rules）

            # ── 评估 goto_rules（成功执行后检查是否需要回退）──
            goto_target = self._evaluate_goto_rules(step, shared_state, total_revisits, step_visit_counts)
            if goto_target is not None:
                target_idx, target_name, reason = goto_target
                yield _sse("workflow_goto", {
                    "from_step": step_index, "from_agent": agent_name,
                    "to_step": target_idx + 1, "to_agent": target_name,
                    "reason": reason,
                    "total_revisits": total_revisits + 1,
                })
                goto_reasons.append({"from": agent_name, "to": target_name, "reason": reason})
                total_revisits += 1
                cursor = target_idx
                continue

            # ── Brain Agent 动态决策（可选）──
            if self.workflow.use_brain and self.brain:
                brain_decision = yield from self._ask_brain(
                    step=step, step_index=step_index,
                    shared_state=shared_state, agent=agent,
                )
                if brain_decision and brain_decision.get("decision") == "goto":
                    target_name = brain_decision.get("target", "")
                    if target_name in self._name_to_idx:
                        target_idx = self._name_to_idx[target_name]
                        reason = brain_decision.get("reason", "brain decision")
                        if total_revisits < self.workflow.max_total_revisits:
                            # 注入 brain 指令到 shared_state，让目标 SubAgent 能看到
                            shared_state["_brain_instructions"] = brain_decision.get("instructions", "")
                            yield _sse("workflow_goto", {
                                "from_step": step_index, "from_agent": agent_name,
                                "to_step": target_idx + 1, "to_agent": target_name,
                                "reason": reason, "source": "brain",
                                "instructions": brain_decision.get("instructions", ""),
                                "total_revisits": total_revisits + 1,
                            })
                            goto_reasons.append({"from": agent_name, "to": target_name, "reason": reason, "source": "brain"})
                            total_revisits += 1
                            cursor = target_idx
                            continue

            yield _sse("workflow_step", {
                "step": step_index, "agent": agent_name,
                "status": "done", "total_steps": total_steps,
            })
            self._log(f"[Workflow:{workflow_id}] step {step_index} '{agent_name}' done")
            cursor += 1

        # ── workflow_done ──
        elapsed = time.time() - start_time
        step_summary = {}
        for name, result in shared_state.get("step_results", {}).items():
            step_summary[name] = {
                "status": result.get("status", "unknown"),
            }

        yield _sse("workflow_done", {
            "workflow": self.workflow.name,
            "workflow_id": workflow_id,
            "status": "success",
            "total_steps": total_steps,
            "duration_seconds": round(elapsed, 2),
            "step_results_summary": step_summary,
            "total_revisits": total_revisits,
            "goto_history": goto_reasons,
            "step_visit_counts": step_visit_counts,
        })
        yield _sse("done", {
            "iterations": total_steps,
            "engine": "workflow",
            "workflow": self.workflow.name,
            "total_revisits": total_revisits,
        })
        self._log(f"[Workflow:{workflow_id}] done in {elapsed:.1f}s")


# ── 工具函数：等待状态管理 API ──────────────────────────────────

def get_workflow_state(workflow_id: str) -> Optional[dict]:
    """获取指定工作流的等待状态"""
    return _workflow_states.get(workflow_id)


def set_workflow_action(workflow_id: str, action: str,
                        edited_content: str = "",
                        feedback: str = "",
                        payload: dict = None) -> bool:
    """设置用户操作，唤醒等待中的工作流。

    返回 True 表示找到并更新了状态，False 表示工作流不存在。
    """
    state = _workflow_states.get(workflow_id)
    if not state:
        return False
    state["action"] = action
    state["edited_content"] = edited_content
    state["feedback"] = feedback
    state["payload"] = payload or {}
    state["updated_at"] = time.time()
    return True


def list_pending_workflows() -> List[dict]:
    """列出所有等待用户操作的工作流"""
    result = []
    for wf_id, state in _workflow_states.items():
        result.append({
            "workflow_id": wf_id,
            "stage": state.get("stage", ""),
            "updated_at": state.get("updated_at", 0),
            "waiting_seconds": round(time.time() - state.get("updated_at", 0), 1),
        })
    return result


# ── 内置工作流定义 ─────────────────────────────────────────────

def build_default_workflow_registry() -> WorkflowRegistry:
    """构建包含内置工作流定义的注册表。

    当前包含：
      - ppt_generation（示例，6 步 PPT 生成）
    """
    registry = WorkflowRegistry()

    # PPT 生成工作流（示例，含回退规则）
    ppt_workflow = Workflow(
        name="ppt_generation",
        description="6 步 PPT 生成工作流：意图分析 → 信息收集 → 信息精炼 → 结构规划 → 内容生成 → 质量审核（支持回退）",
        max_total_revisits=8,
        use_brain=False,  # 可设为 True 启用 BrainAgent
        steps=[
            WorkflowStep(
                agent_name="intent_analyzer",
                input_mapping={"user_query": "$.user_input"},
                output_mapping={"content": "$.step_results.intent_analyzer.intent"},
                await_user=True,
                await_message="请确认意图分析结果，确认后将开始收集信息。",
            ),
            WorkflowStep(
                agent_name="info_collector",
                input_mapping={
                    "topic": "$.step_results.intent_analyzer.intent.topic",
                    "focus_areas": "$.step_results.intent_analyzer.intent.focus_areas",
                    "brain_instructions": "$_brain_instructions",  # Brain 给的补充指令
                },
                output_mapping={"content": "$.step_results.info_collector.collected_info"},
                on_error="continue",
            ),
            WorkflowStep(
                agent_name="summarizer",
                input_mapping={"raw_text": "$.step_results.info_collector.collected_info.content"},
                output_mapping={"content": "$.step_results.summarizer.distilled_info"},
                on_error="continue",
            ),
            WorkflowStep(
                agent_name="content_planner",
                input_mapping={
                    "distilled_info": "$.step_results.summarizer.distilled_info.content",
                    "intent": "$.step_results.intent_analyzer.intent",
                },
                output_mapping={"content": "$.step_results.content_planner.outline"},
                await_user=True,
                await_message="结构规划已完成，请确认大纲或提出修改意见。",
                on_error="goto:info_collector",  # 规划失败 → 回到信息收集
                max_revisits=2,
            ),
            WorkflowStep(
                agent_name="content_generator",
                input_mapping={
                    "outline": "$.step_results.content_planner.outline.content",
                    "reference_info": "$.step_results.summarizer.distilled_info.content",
                },
                output_mapping={"content": "$.step_results.content_generator.full_content"},
                on_error="goto:content_planner",  # 生成失败 → 回到规划
            ),
            WorkflowStep(
                agent_name="quality_reviewer",
                input_mapping={"content": "$.step_results.content_generator.full_content.content"},
                output_mapping={"content": "$.step_results.quality_reviewer.review"},
                goto_rules=[
                    # 审核不通过 → 回退到信息收集
                    GotoRule(
                        condition="{{step_results.quality_reviewer.review.content.verdict}} == 'reject'",
                        target="info_collector",
                        reason="质量审核不通过(reject)，需重新收集信息",
                        max_jumps=1,
                    ),
                    # 审核需修改 → 回退到内容生成
                    GotoRule(
                        condition="{{step_results.quality_reviewer.review.content.verdict}} == 'revise'",
                        target="content_generator",
                        reason="质量审核需修改(revise)，重新生成内容",
                        max_jumps=2,
                    ),
                ],
            ),
        ],
    )

    registry.register(ppt_workflow)
    return registry
