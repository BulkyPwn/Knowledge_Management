"""
Skill 状态机引擎
================
将结构化 YAML Skill 定义转为强制执行的状态机，替代纯 Prompt 驱动模式。

核心能力：
  1. 步骤强制执行 — tool_call 步骤不等 LLM 决定，直接调用
  2. 工具白名单 — 只暴露 skill 声明的工具
  3. 验证 + 重试 — 每步可设 validate 条件，失败自动重试
  4. 条件分支 — 支持 condition 步骤做流程控制
  5. 后置验证 — llm_generate 步骤输出格式检查
  6. SSE 兼容 — 输出事件格式与 agent_loop.py 完全一致

Skill YAML 结构：
  name, version, description, trigger_keywords,
  tools_allowed, max_iterations, steps[]

步骤类型：
  tool_call    — 强制执行工具调用，不等 LLM
  llm_generate — 调用 LLM 生成，可设 post_validate
  condition    — 条件判断，决定流程走向
  validate     — 纯验证步骤，不产生输出
"""

import json
import re
import traceback
from typing import Dict, List, Any, Generator, Optional, Callable, Tuple

# SSE 事件格式（与 agent_loop.py 一致）
def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ══════════════════════════════════════════════════════════════
#  模板引擎 — 支持 {{variable}} 和 {{step.step_id.field}}
# ══════════════════════════════════════════════════════════════

_TEMPLATE_RE = re.compile(r"\{\{(.+?)\}\}")

def _render_template(template: str, state: dict) -> str:
    """渲染模板变量。支持：
      {{user_input}}        → state 中的值
      {{step.xxx.result}}   → 某步骤的结果
      {{step.xxx.count}}    → 工具返回的 count 字段
    """
    def _resolve(key: str) -> str:
        key = key.strip()
        try:
            # 层级引用: step.search_primary.result
            parts = key.split(".")
            if parts[0] == "step":
                step_id = parts[1]
                field = parts[2] if len(parts) > 2 else "result"
                step_data = state.get("_step_results", {}).get(step_id, {})
                val = step_data.get(field, "")
                return json.dumps(val, ensure_ascii=False) if not isinstance(val, str) else val
            if parts[0] == "step_raw":
                step_id = parts[1]
                step_data = state.get("_step_results", {}).get(step_id, {})
                raw = step_data.get("_raw", "")
                return str(raw)[:2000]
            # 直接变量: user_input, broad_keywords
            return str(state.get(key, ""))
        except Exception:
            return f"{{{{ {key} }}}}"

    return _TEMPLATE_RE.sub(lambda m: _resolve(m.group(1)), template)


def _extract_keywords(user_input: str) -> dict:
    """从用户输入提取基础变量"""
    return {
        "user_input": user_input,
        "user_input_short": user_input[:80],
    }


# ══════════════════════════════════════════════════════════════
#  步骤执行器
# ══════════════════════════════════════════════════════════════

def _execute_tool_step(
    step: dict,
    tool_registry,
    state: dict,
    context: dict,
    call_id_prefix: str = "skill",
) -> Generator[str, None, dict]:
    """执行 tool_call 步骤。支持 retry + alternate_params。"""
    step_id = step.get("id", "unknown")
    tool_name = step["tool"]
    params_template = step.get("params", {})
    validate_def = step.get("validate", {})
    retry_def = step.get("retry", {})
    max_retries = retry_def.get("max_attempts", 1)
    alternate_params_list = retry_def.get("alternate_params", [])
    timeout = step.get("timeout", 30)

    tool = tool_registry.get_tool(tool_name)
    if not tool:
        error_msg = {"error": f"Unknown tool: {tool_name}"}
        yield _sse("error", {"message": f"Skill engine: tool '{tool_name}' not registered"})
        return error_msg

    for attempt in range(max_retries):
        # 第 1 次用原始 params，后续用 alternate_params
        if attempt == 0:
            params = {k: _render_template(v, state) for k, v in params_template.items()}
        else:
            alt_idx = min(attempt - 1, len(alternate_params_list) - 1)
            alt_params = alternate_params_list[alt_idx]
            params = {k: _render_template(str(v), state) for k, v in alt_params.items()}

        call_id = f"{call_id_prefix}_{step_id}_{attempt}"
        yield _sse("tool_call", {
            "tool": tool_name,
            "args": params,
            "call_id": call_id,
            "status": "calling",
            "skill_step": step_id,
            "attempt": attempt + 1,
        })

        try:
            result_str = tool_registry.execute_tool(tool_name, params, context)
        except Exception as e:
            result_str = json.dumps({"error": str(e), "traceback": traceback.format_exc()[-200:]})

        # 尝试解析 JSON
        try:
            result_data = json.loads(result_str)
        except (json.JSONDecodeError, TypeError):
            result_data = {"_raw": result_str}

        yield _sse("tool_result", {
            "tool": tool_name,
            "call_id": call_id,
            "result": result_str[:500],
            "status": "done",
            "skill_step": step_id,
            "attempt": attempt + 1,
        })

        # 验证结果
        if validate_def:
            condition = validate_def.get("condition", "")
            if condition and _evaluate_condition_string(condition, result_data):
                return result_data

            on_failure = validate_def.get("on_failure", "stop")
            if on_failure == "retry_with_alternate" and attempt < max_retries - 1:
                yield _sse("agent_status", {
                    "status": "skill_retry",
                    "step": step_id,
                    "attempt": attempt + 1,
                    "reason": f"Validation failed: {condition}",
                })
                continue
            elif on_failure == "continue_anyway":
                return result_data
            elif on_failure == "stop":
                return result_data  # 返回失败结果，让调用方决定
        else:
            return result_data

    return result_data


def _execute_llm_step(
    step: dict,
    llm_call_fn: Callable,
    state: dict,
    tool_registry,
    llm_config: dict,
) -> Generator[str, None, str]:
    """执行 llm_generate 步骤。调用 LLM 生成回答 + 后置验证。"""
    step_id = step.get("id", "unknown")
    instructions = _render_template(step.get("instructions", ""), state)
    prompt_template = step.get("prompt", "")
    prompt = _render_template(prompt_template, state) if prompt_template else ""
    model = step.get("model") or llm_config.get("llm_model", "")
    temperature = step.get("temperature", 0.3)
    max_tokens = step.get("max_tokens", 4096)
    validate_def = step.get("validate", {})

    system_msg = instructions or prompt
    user_msg = prompt_template and instructions or "请按上述要求生成回答。"

    messages = [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": user_msg},
    ]

    # 获取允许的工具（llm_generate 步骤中 LLM 可选的 tool）
    tools_allowed = step.get("tools_allowed", [])
    tools = []
    if tools_allowed:
        tools = [t for t in tool_registry.list_tools()
                 if t["function"]["name"] in tools_allowed]

    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    yield _sse("agent_status", {
        "status": "skill_llm",
        "step": step_id,
        "model": model,
    })

    try:
        content = llm_call_fn(body)
    except Exception as e:
        yield _sse("error", {"message": f"Skill engine LLM error: {str(e)}"})
        return ""

    if not isinstance(content, str):
        content = str(content)

    yield _sse("message", {"content": content, "type": "complete"})

    # 后置验证
    if validate_def:
        issues = _validate_output(content, validate_def)
        if issues:
            yield _sse("agent_status", {
                "status": "skill_validation_failed",
                "step": step_id,
                "issues": issues,
            })

    return content


def _evaluate_condition_string(condition: str, result_data: dict) -> bool:
    """解析并执行条件表达式。支持：
      result.count > 0
      result.count < 3
      result.error exists
      result._raw length > 100
    """
    try:
        # 替换变量
        expr = condition
        for key, val in result_data.items():
            placeholder = f"result.{key}"
            if placeholder in expr:
                if isinstance(val, str):
                    expr = expr.replace(placeholder, repr(val))
                else:
                    expr = expr.replace(placeholder, str(val))
        # 安全执行
        return bool(eval(expr, {"__builtins__": {}}, {
            "len": len, "str": str, "bool": bool, "int": int,
            "True": True, "False": False, "None": None,
        }))
    except Exception:
        return False


def _validate_output(content: str, validate_def: dict) -> List[str]:
    """后置验证 LLM 输出"""
    issues = []
    required_contains = validate_def.get("contains")
    min_length = validate_def.get("min_length")
    required_pattern = validate_def.get("pattern")

    if required_contains and required_contains not in content:
        issues.append(f"Output missing required string: '{required_contains}'")
    if min_length and len(content) < min_length:
        issues.append(f"Output too short: {len(content)} < {min_length}")
    if required_pattern:
        try:
            if not re.search(required_pattern, content):
                issues.append(f"Output doesn't match pattern: '{required_pattern}'")
        except re.error:
            issues.append(f"Invalid regex pattern: '{required_pattern}'")

    return issues


# ══════════════════════════════════════════════════════════════
#  Skill 引擎主类
# ══════════════════════════════════════════════════════════════

class SkillEngine:
    """结构化 Skill 状态机执行引擎。

    使用方式：
        engine = SkillEngine(skill_def, tool_registry, llm_config)
        for event in engine.run(user_input, messages):
            yield event  # SSE 事件
    """

    def __init__(self, skill_def: dict, tool_registry, llm_config: dict):
        self.skill = skill_def
        self.name = skill_def.get("name", "unnamed")
        self.steps_def = skill_def.get("steps", [])
        self.tools_allowed = set(skill_def.get("tools_allowed", []))
        self.max_iterations = skill_def.get("max_iterations", 5)
        self._registry = tool_registry
        self._llm_config = llm_config

    def get_allowed_tools(self) -> List[dict]:
        """返回此 skill 允许的工具列表（OpenAI 格式）"""
        if not self.tools_allowed:
            return self._registry.list_tools()
        return [t for t in self._registry.list_tools()
                if t["function"]["name"] in self.tools_allowed]

    def get_allowed_tool_names(self) -> set:
        """返回允许的工具名集合"""
        return self.tools_allowed or set()

    def run(
        self,
        user_input: str,
        messages: List[dict],
        context: dict = None,
        extra_state: dict = None,
    ) -> Generator[str, None, None]:
        """主执行循环。按 skill.steps 顺序执行，yield SSE 事件。

        SSE 事件类型（与 agent_loop 完全兼容）：
          agent_status → {status: "skill_step" | "skill_retry" | ...}
          tool_call    → {tool, args, call_id, status, skill_step}
          tool_result  → {tool, call_id, result, status, skill_step}
          message      → {content, type: "complete"}
          error        → {message}
          done         → {iterations, engine: "skill"}
        """
        if context is None:
            context = {}

        # 初始化状态
        state = _extract_keywords(user_input)
        state["_step_results"] = {}
        if extra_state:
            state.update(extra_state)

        # 注入用户消息作为模板变量
        state["user_message"] = user_input
        if messages:
            last_user = next((m["content"] for m in reversed(messages)
                            if m.get("role") == "user"), user_input)
            state["user_message"] = last_user

        total_steps = len(self.steps_def)
        yield _sse("agent_status", {
            "status": "skill_start",
            "skill": self.name,
            "total_steps": total_steps,
            "tools_allowed": list(self.tools_allowed) if self.tools_allowed else "all",
        })

        for i, step in enumerate(self.steps_def):
            step_id = step.get("id", f"step_{i}")
            step_type = step.get("type", "unknown")

            yield _sse("agent_status", {
                "status": "skill_step",
                "step": step_id,
                "step_index": i + 1,
                "total_steps": total_steps,
                "type": step_type,
            })

            try:
                if step_type == "tool_call":
                    for event in _execute_tool_step(
                        step, self._registry, state, context,
                        call_id_prefix=f"skill_{self.name}",
                    ):
                        if event.startswith("event: tool_result"):
                            # 提取结果存到 state
                            pass
                        yield event

                    # 从最后一个 tool_result 事件中解析结果（在调用处处理）
                    # 这里简化：重新执行一次来获取结果
                    result_data = _execute_tool_step_sync(step, self._registry, state, context)
                    state["_step_results"][step_id] = result_data
                    state[step_id] = result_data  # 顶层别名

                elif step_type == "llm_generate":
                    # llm_generate 需要实际的 LLM 调用函数，由外部注入
                    pass  # 由 run_with_llm() 处理

                elif step_type == "condition":
                    condition_str = step.get("condition", "True")
                    condition_str = _render_template(condition_str, state)
                    result = _evaluate_condition_string(condition_str, state.get("_step_results", {}))
                    state["_step_results"][step_id] = {"condition": condition_str, "result": result}
                    if not result:
                        yield _sse("agent_status", {
                            "status": "skill_condition_failed",
                            "step": step_id,
                            "condition": condition_str,
                        })
                        if step.get("on_false") == "stop":
                            break
                        elif step.get("on_false") == "skip_next":
                            continue

                elif step_type == "validate":
                    validate_def = step.get("validate", {})
                    target_step = step.get("target_step")
                    target_content = state.get("_step_results", {}).get(target_step, {}).get("_raw", "")
                    issues = _validate_output(target_content, validate_def)
                    state["_step_results"][step_id] = {"issues": issues, "passed": len(issues) == 0}
                    if issues:
                        yield _sse("agent_status", {
                            "status": "skill_validation_failed",
                            "step": step_id,
                            "issues": issues,
                        })

            except Exception as e:
                yield _sse("error", {
                    "message": f"Skill step '{step_id}' failed: {str(e)}",
                    "step": step_id,
                    "traceback": traceback.format_exc()[-300:],
                })
                state["_step_results"][step_id] = {"error": str(e)}
                if step.get("on_error") == "stop":
                    break

        yield _sse("done", {
            "iterations": total_steps,
            "engine": "skill",
            "skill": self.name,
        })

    def run_with_llm(
        self,
        user_input: str,
        messages: List[dict],
        llm_call_fn: Callable,
        context: dict = None,
        extra_state: dict = None,
    ) -> Generator[str, None, None]:
        """带 LLM 调用能力的完整执行（支持 llm_generate 步骤）。

        llm_call_fn: (body: dict) -> str
            接收 OpenAI 格式的请求体，返回 LLM 生成的文本。
        """
        if context is None:
            context = {}

        state = _extract_keywords(user_input)
        state["_step_results"] = {}
        if extra_state:
            state.update(extra_state)

        if messages:
            last_user = next((m["content"] for m in reversed(messages)
                            if m.get("role") == "user"), user_input)
            state["user_message"] = last_user

        total_steps = len(self.steps_def)
        yield _sse("agent_status", {
            "status": "skill_start",
            "skill": self.name,
            "total_steps": total_steps,
            "tools_allowed": list(self.tools_allowed) if self.tools_allowed else "all",
        })

        for i, step in enumerate(self.steps_def):
            step_id = step.get("id", f"step_{i}")
            step_type = step.get("type", "unknown")

            yield _sse("agent_status", {
                "status": "skill_step",
                "step": step_id,
                "step_index": i + 1,
                "total_steps": total_steps,
                "type": step_type,
            })

            try:
                if step_type == "tool_call":
                    result_data = _execute_tool_step_sync(step, self._registry, state, context)
                    state["_step_results"][step_id] = result_data
                    state[step_id] = result_data

                    # 重放 SSE 事件（前端需要看到 tool_call/tool_result）
                    for event in _execute_tool_step(
                        step, self._registry, state, context,
                        call_id_prefix=f"skill_{self.name}",
                    ):
                        yield event

                elif step_type == "llm_generate":
                    for event in _execute_llm_step(
                        step, llm_call_fn, state, self._registry, self._llm_config,
                    ):
                        yield event

                elif step_type == "condition":
                    condition_str = step.get("condition", "True")
                    condition_str = _render_template(condition_str, state)
                    result = _evaluate_condition_string(condition_str, state.get("_step_results", {}))
                    state["_step_results"][step_id] = {"condition": condition_str, "result": result}
                    if not result:
                        yield _sse("agent_status", {
                            "status": "skill_condition_failed",
                            "step": step_id,
                            "condition": condition_str,
                        })
                        if step.get("on_false") == "stop":
                            break

                elif step_type == "validate":
                    validate_def = step.get("validate", {})
                    target_step = step.get("target_step")
                    target_content = state.get("_step_results", {}).get(target_step, {}).get("_raw", "")
                    issues = _validate_output(target_content, validate_def)
                    state["_step_results"][step_id] = {"issues": issues, "passed": len(issues) == 0}
                    if issues:
                        yield _sse("agent_status", {
                            "status": "skill_validation_failed",
                            "step": step_id,
                            "issues": issues,
                        })

            except Exception as e:
                yield _sse("error", {
                    "message": f"Skill step '{step_id}' failed: {str(e)}",
                    "step": step_id,
                })
                state["_step_results"][step_id] = {"error": str(e)}
                if step.get("on_error") == "stop":
                    break

        yield _sse("done", {
            "iterations": total_steps,
            "engine": "skill",
            "skill": self.name,
        })


def _execute_tool_step_sync(step: dict, tool_registry, state: dict, context: dict) -> dict:
    """同步执行 tool_call 步骤并返回结果（用于状态更新）"""
    tool_name = step["tool"]
    params_template = step.get("params", {})

    params = {}
    for k, v in params_template.items():
        rendered = _render_template(str(v), state)
        # 尝试将 JSON 字符串转回 dict
        try:
            params[k] = json.loads(rendered)
        except (json.JSONDecodeError, TypeError):
            params[k] = rendered

    try:
        result_str = tool_registry.execute_tool(tool_name, params, context)
        try:
            return json.loads(result_str)
        except (json.JSONDecodeError, TypeError):
            return {"_raw": result_str}
    except Exception as e:
        return {"error": str(e)}


# ══════════════════════════════════════════════════════════════
#  工具函数 — YAML 加载 + Skill 编排
# ══════════════════════════════════════════════════════════════

def load_yaml_skill(filepath: str) -> Optional[dict]:
    """从 YAML 文件加载结构化 Skill 定义。返回 None 如果文件不存在或格式错误。"""
    import os
    try:
        import yaml
    except ImportError:
        # 简易 YAML 解析（不依赖 PyYAML）
        return _parse_simple_yaml(filepath)

    if not os.path.isfile(filepath):
        return None
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception:
        return None


def _parse_simple_yaml(filepath: str) -> Optional[dict]:
    """简易 YAML 解析器（不依赖 PyYAML，作为 fallback）。
    
    仅支持嵌套字典和列表、字符串、数字、布尔值。不支持多行字符串、锚点、标签。
    """
    import os
    if not os.path.isfile(filepath):
        return None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return None

    # 递归解析
    def parse_value(lines: list, indent_level: int = 0) -> tuple:
        result = {}
        i = 0
        while i < len(lines):
            line = lines[i]
            stripped = line.rstrip()
            if not stripped or stripped.startswith("#"):
                i += 1
                continue

            # 计算缩进
            leading = len(line) - len(line.lstrip())
            if leading < indent_level:
                break
            if leading > indent_level:
                i += 1
                continue

            content_line = line.lstrip()
            # 列表项: - value
            if content_line.startswith("- "):
                list_items = []
                list_indent = leading + 2
                j = i
                while j < len(lines):
                    l = lines[j].rstrip()
                    if not l or l.startswith("#"):
                        j += 1
                        continue
                    l_leading = len(lines[j]) - len(lines[j].lstrip())
                    if l_leading < leading:
                        break
                    item_line = lines[j].lstrip()
                    if item_line.startswith("- "):
                        list_items.append(item_line[2:].strip().strip("'\""))
                        j += 1
                    elif l_leading >= list_indent:
                        # 嵌套列表项内容
                        j += 1
                    else:
                        break
                return list_items, j

            # 键值对
            if ":" in content_line:
                key, _, val = content_line.partition(":")
                key = key.strip()
                val = val.strip()

                if val == "":
                    # 可能是嵌套对象
                    nested, next_i = parse_value(lines[i+1:], leading + 2)
                    result[key] = nested
                    i = i + 1 + next_i
                elif val in ("true", "True", "TRUE"):
                    result[key] = True
                elif val in ("false", "False", "FALSE"):
                    result[key] = False
                elif val.startswith('"') and val.endswith('"'):
                    result[key] = val[1:-1]
                elif val.startswith("'") and val.endswith("'"):
                    result[key] = val[1:-1]
                else:
                    try:
                        result[key] = int(val)
                    except ValueError:
                        try:
                            result[key] = float(val)
                        except ValueError:
                            result[key] = val
                i += 1
            else:
                i += 1
        return result, i

    lines = content.split("\n")
    parsed, _ = parse_value(lines, 0)
    return parsed if parsed else None


def is_structured_skill(skill_def: dict) -> bool:
    """判断 skill 定义是否为结构化（YAML/引擎驱动）类型"""
    return skill_def.get("type") == "structured" or "steps" in skill_def