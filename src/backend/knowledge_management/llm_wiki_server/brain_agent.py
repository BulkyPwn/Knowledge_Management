"""
BrainAgent — 工作流的 LLM 决策大脑

架构定位：
  WorkflowOrchestrator 是"执行器"（机械地按步骤走），
  BrainAgent 是"大脑"（用 LLM 判断下一步该去哪）。

工作方式：
  每个 SubAgent 执行完后，Orchestrator 可选地调用 Brain.decide()，
  Brain 看到当前步骤结果 + 全局 shared_state 摘要，返回结构化决策。

决策类型：
  - continue: 继续下一步（默认）
  - goto:     回退/跳转到某个步骤
  - stop:     终止工作流

参考业界方案：
  - LangGraph 的条件边 + Replanner
  - CrewAI 的 Hierarchical Delegation
  - Plan-and-Execute 的 Replan 阶段

使用示例：
    from brain_agent import BrainAgent
    brain = BrainAgent()

    orch = WorkflowOrchestrator(
        workflow=ppt_workflow,
        agent_registry=registry,
        tool_registry=tools,
        llm_config=llm_config,
        brain=brain,           # ← 注入 Brain
    )

    ppt_workflow.use_brain = True  # 启用
"""

import json
import re
import time
import requests
from typing import Any, Dict, List, Optional


# ── Brain 的 System Prompt ─────────────────────────────────────
BRAIN_SYSTEM_PROMPT = """你是一个工作流决策大脑（Workflow Brain）。

你的职责是在工作流执行过程中，评估每一步的结果，决定下一步行动。

## 你可以做出的决策

1. **continue** — 当前步骤结果正常，继续执行下一步（默认）
2. **goto** — 当前步骤结果不理想，需要回退到某个早期步骤重新执行
3. **stop** — 发现严重问题，终止工作流

## 决策依据

你会收到：
- 当前执行的步骤名称和结果
- 工作流中所有可用的步骤列表
- 各步骤的历史执行状态

## 输出格式

你必须严格按照以下 JSON 格式输出（不要输出其他内容）：

```json
{
    "decision": "continue | goto | stop",
    "target": "目标步骤的 agent_name（仅 goto 时必填）",
    "reason": "做出此决策的原因（简短说明）",
    "instructions": "给目标步骤的补充指令（仅 goto 时建议填写，告诉它应该重点补充什么）",
    "confidence": 0.0 到 1.0 的置信度
}
```

## 决策原则

1. **谨慎回退**：回退是昂贵的（消耗额外 LLM 调用），只有结果确实不可用时才回退
2. **精准定位**：回退到能解决问题的最早步骤，但不要太早（避免不必要的重做）
3. **补充指令**：goto 时务必给 instructions，告诉目标步骤"上次缺了什么"、"重点补充什么"
4. **置信度**：如果你对结果质量的判断不确定，给出较低的置信度
5. **不要过度审查**：如果步骤返回了合理的结构化结果，默认 continue

## 举例

场景：质量审核步骤发现信息不足
```json
{
    "decision": "goto",
    "target": "info_collector",
    "reason": "质量审核发现内容缺乏具体数据支撑，需要补充收集",
    "instructions": "重点搜索以下内容：1) 具体的性能对比数据 2) 真实案例的量化效果",
    "confidence": 0.85
}
```

场景：内容规划步骤结果正常
```json
{
    "decision": "continue",
    "target": "",
    "reason": "大纲结构清晰，覆盖了所有核心要点，可以继续生成内容",
    "instructions": "",
    "confidence": 0.9
}
```
"""


class BrainAgent:
    """工作流决策大脑。

    使用 LLM 评估每一步的执行结果，决定是否回退/继续/停止。
    """

    def __init__(
        self,
        system_prompt: str = "",
        max_context_chars: int = 6000,
        temperature: float = 0.3,
        log_fn=None,
    ):
        """
        参数：
          system_prompt      — 自定义系统提示词（默认使用内置的 BRAIN_SYSTEM_PROMPT）
          max_context_chars  — 传递给 LLM 的上下文最大字符数（防止 token 过多）
          temperature        — LLM 温度（决策类任务建议低温）
          log_fn             — 日志函数
        """
        self.system_prompt = system_prompt or BRAIN_SYSTEM_PROMPT
        self.max_context_chars = max_context_chars
        self.temperature = temperature
        self._log = log_fn or (lambda msg: None)

    def _build_context(
        self,
        current_step: str,
        step_result: dict,
        shared_state: dict,
        available_steps: List[dict],
        workflow_name: str,
    ) -> str:
        """构建传递给 LLM 的上下文摘要。"""
        # 各步骤执行状态摘要
        step_statuses = {}
        for name, result in shared_state.get("step_results", {}).items():
            if isinstance(result, dict):
                status = result.get("status", "unknown")
                # 提取关键指标（如果有）
                quality = result.get("quality_score", result.get("verdict", ""))
                entry = {"status": status}
                if quality:
                    entry["quality_indicator"] = quality
                step_statuses[name] = entry

        # 当前步骤结果（截断）
        result_str = json.dumps(step_result, ensure_ascii=False, indent=2)
        if len(result_str) > self.max_context_chars:
            result_str = result_str[:self.max_context_chars] + "\n...(truncated)"

        # 可用步骤列表
        steps_str = "\n".join(
            f"  - {s['name']}: {s.get('description', '')}"
            for s in available_steps
        )

        # Brain 之前给的指令（如果有）
        brain_instructions = shared_state.get("_brain_instructions", "")

        context_parts = [
            f"## 工作流：{workflow_name}",
            f"## 当前完成的步骤：{current_step}",
            f"## 当前步骤结果：\n```json\n{result_str}\n```",
            f"## 各步骤状态：\n```json\n{json.dumps(step_statuses, ensure_ascii=False, indent=2)}\n```",
            f"## 可用步骤：\n{steps_str}",
        ]
        if brain_instructions:
            context_parts.append(f"## 上次 Brain 给的补充指令：{brain_instructions}")

        return "\n\n".join(context_parts)

    def decide(
        self,
        current_step: str,
        step_result: dict,
        shared_state: dict,
        available_steps: List[dict],
        workflow_name: str,
        llm_config: dict,
    ) -> Optional[dict]:
        """评估步骤结果，返回决策。

        参数：
          current_step     — 刚完成的步骤名称
          step_result      — 该步骤的执行结果
          shared_state     — 工作流全局状态
          available_steps  — 工作流中所有步骤信息
          workflow_name    — 工作流名称
          llm_config       — LLM 配置

        返回：
          决策 dict：{"decision": "continue|goto|stop", "target": "...", "reason": "...", ...}
          或 None（解析失败时默认 continue）
        """
        context = self._build_context(
            current_step, step_result, shared_state, available_steps, workflow_name,
        )

        messages = [
            {"role": "user", "content": f"{self.system_prompt}\n\n---\n\n请评估以下情况并做出决策：\n\n{context}"},
        ]

        self._log(f"[Brain] deciding for step '{current_step}', context_len={len(context)}")

        try:
            # 调用 LLM
            response = self._call_llm(messages, llm_config)

            if not response:
                self._log("[Brain] LLM returned empty response, defaulting to continue")
                return {"decision": "continue", "reason": "brain_empty_response"}

            # 提取 JSON（兼容 markdown code block）
            decision = self._parse_decision(response)
            self._log(f"[Brain] decision: {json.dumps(decision, ensure_ascii=False)}")
            return decision

        except Exception as e:
            self._log(f"[Brain] error: {e}")
            return {"decision": "continue", "reason": f"brain_error: {str(e)}"}

    def _parse_decision(self, response: str) -> dict:
        """从 LLM 响应中解析决策 JSON。"""
        # 尝试直接解析
        try:
            return json.loads(response)
        except json.JSONDecodeError:
            pass

        # 尝试从 ```json ... ``` 中提取
        json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", response, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1).strip())
            except json.JSONDecodeError:
                pass

        # 尝试从响应中找第一个 { ... } 块
        brace_match = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", response, re.DOTALL)
        if brace_match:
            try:
                return json.loads(brace_match.group(0))
            except json.JSONDecodeError:
                pass

        # 解析失败，默认 continue
        return {
            "decision": "continue",
            "reason": "brain_parse_failed",
            "raw_response": response[:500],
        }

    def _call_llm(self, messages: List[dict], llm_config: dict) -> Optional[str]:
        """直接调用 LLM API（非流式），返回文本结果。

        复用 agent_loop 的 llm_config 格式（llm_url, llm_api_key, llm_model）。
        """
        if not llm_config:
            return None

        llm_url = llm_config.get("llm_url", "")
        llm_api_key = llm_config.get("llm_api_key", "")
        llm_model = llm_config.get("llm_model", "")

        if not llm_url or not llm_model:
            return None

        # 构建 chat URL
        chat_url = llm_url.rstrip("/")
        if not chat_url.endswith("/chat/completions"):
            lower_url = chat_url.lower()
            if lower_url.endswith("/api/coding/v3") or lower_url.endswith("/v3"):
                pass
            elif not chat_url.endswith("/v1"):
                chat_url += "/v1"
            chat_url += "/chat/completions"

        headers = {"Content-Type": "application/json"}
        if llm_api_key:
            headers["Authorization"] = f"Bearer {llm_api_key}"

        body = {
            "model": llm_model,
            "messages": [{"role": "user", "content": messages[0]["content"]}],
            "temperature": self.temperature,
            "max_tokens": 1024,
        }

        try:
            resp = requests.post(chat_url, json=body, headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            choices = data.get("choices", [{}])
            if not choices:
                return None
            return choices[0].get("message", {}).get("content", "")
        except requests.exceptions.Timeout:
            self._log("[Brain] LLM call timeout")
            return None
        except Exception as e:
            self._log(f"[Brain] LLM call error: {e}")
            return None
