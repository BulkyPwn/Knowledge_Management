"""
Agent 核心循环（KV Cache 优化版）
===================================
设计原则：
  1. 消息列表只追加（append），不修改已发送的前缀
  2. 所有 LLM 请求使用 stream=True，避免 pop+re-request 浪费 cache
  3. 压缩仅替换最旧的中间段，保留已冻结前缀 + 最近对话
  4. 每轮 LLM 调用的前缀 = 上轮完整消息，最大化 prefix cache 命中率

SSE 事件类型：
  agent_status  → {"status": "thinking"|"compressed", ...}
  tool_call     → {"tool": "...", "args": {...}, "call_id": "...", "status": "calling"}
  tool_result   → {"tool": "...", "call_id": "...", "result": "...", "status": "done"}
  message       → {"content": "...", "type": "delta"|"complete"}
  error         → {"message": "..."}
  done          → {"iterations": N}
"""

import json
import os
import requests
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Generator, Dict, Any, List, Optional, Tuple

from perf_tracker import record_step
from image_to_desc import get_thinking_limit


# ── 上下文管理常量 ─────────────────────────────────────────────
CONTEXT_TOKEN_LIMIT = 240_000       # 256K 窗口，预留 16K 给输出
COMPRESSION_TRIGGER_RATIO = 0.75    # 达到 75% 时触发压缩
COMPRESSION_TARGET_RATIO = 0.45     # 压缩后目标占比
MAX_OUTPUT_TOKENS = 16384           # 单次输出最大 token
MAX_SINGLE_TOOL_RESULT_CHARS = 80_000   # 单条 tool_result 最大字符数（≈27K tokens）
HARD_CAP_TOKENS = 230_000           # 硬上限：无论如何不能超过此值（留 26K 给输出）


# ── LLM 交互日志 ─────────────────────────────────────────────
# 路径与 app.py write_log 一致：logs/<session_id>_llm.log
_LOCAL_DIR = str(Path(__file__).resolve().parent)
_LLM_LOG_SESSION_ID = datetime.now().strftime('%Y%m%d_%H%M%S')
_LLM_LOG_FILE = None
_LLM_LOG_PART = 0
_LLM_LOG_MAX_SIZE = 5 * 1024 * 1024  # 5MB（LLM 交互日志较大）


def _get_llm_log_file():
    """获取当前 LLM 交互日志文件路径，必要时轮换"""
    global _LLM_LOG_FILE, _LLM_LOG_PART
    if _LLM_LOG_FILE is None:
        logs_dir = os.path.join(_LOCAL_DIR, "logs")
        os.makedirs(logs_dir, exist_ok=True)
        _LLM_LOG_FILE = os.path.join(logs_dir, f"{_LLM_LOG_SESSION_ID}_llm.log")
        return _LLM_LOG_FILE
    try:
        if os.path.exists(_LLM_LOG_FILE) and os.path.getsize(_LLM_LOG_FILE) >= _LLM_LOG_MAX_SIZE:
            _LLM_LOG_PART += 1
            logs_dir = os.path.join(_LOCAL_DIR, "logs")
            _LLM_LOG_FILE = os.path.join(logs_dir, f"{_LLM_LOG_SESSION_ID}_llm_{_LLM_LOG_PART:02d}.log")
    except OSError:
        pass
    return _LLM_LOG_FILE


def _log_llm_event(event_type: str, data: dict):
    """写入 LLM 交互日志（JSON Lines 格式）

    event_type:
      - "request"  : 发送给大模型的完整请求
      - "response" : 大模型返回的完整响应
      - "error"    : LLM 调用异常
    """
    log_file = _get_llm_log_file()
    entry = {
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3],
        "event": event_type,
        **data,
    }
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 日志写入失败不影响主流程


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ══════════════════════════════════════════════════════════════
#  Token 估算
# ══════════════════════════════════════════════════════════════

def _estimate_tokens(messages: List[Dict]) -> int:
    """估算消息列表的 token 数。中英混合：总字符数 / 3。"""
    total_chars = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    total_chars += len(part.get("text", ""))
        if "tool_calls" in msg:
            total_chars += len(json.dumps(msg["tool_calls"], ensure_ascii=False))
        if msg.get("role") == "system":
            total_chars += 50
    return max(1, total_chars // 3)


# ══════════════════════════════════════════════════════════════
#  KV Cache 友好的上下文压缩
# ══════════════════════════════════════════════════════════════

def _compress_context(
    messages: List[Dict],
    frozen_idx: int = 0,
    token_limit: int = CONTEXT_TOKEN_LIMIT,
    trigger_ratio: float = COMPRESSION_TRIGGER_RATIO,
    target_ratio: float = COMPRESSION_TARGET_RATIO,
) -> Tuple[List[Dict], int]:
    """KV Cache 友好的上下文压缩。
    
    策略：
    - frozen_prefix = messages[:frozen_idx] → 永不修改（已发送给 LLM 并被缓存）
    - compressible = messages[frozen_idx:tail_idx] → 可压缩（旧 tool 结果、旧回答）
    - protected = messages[tail_idx:] → 最近 3 轮，不动
    
    压缩后：[frozen_prefix] + [summary_msg] + [protected]
    返回 (compressed_messages, new_frozen_idx)
    
    如果未触发压缩，返回 (messages, frozen_idx) 不变。
    """
    current_tokens = _estimate_tokens(messages)
    trigger_threshold = int(token_limit * trigger_ratio)
    
    if current_tokens <= trigger_threshold:
        return messages, frozen_idx  # 未达阈值
    
    target_tokens = int(token_limit * target_ratio)
    
    # ── 确定 protected 区间：最近 3 轮 ──
    tail_idx = len(messages)
    rounds_seen = 0
    for i in range(len(messages) - 1, frozen_idx, -1):
        if messages[i].get("role") == "user":
            rounds_seen += 1
            if rounds_seen >= 3:
                tail_idx = i
                break
    tail_idx = max(tail_idx, frozen_idx + 1)
    
    protected = messages[tail_idx:]
    compressible = messages[frozen_idx:tail_idx]
    
    if not compressible or len(compressible) < 2:
        return messages, frozen_idx  # 没有可压缩的内容
    
    # ── 压缩 compressible 部分 ──
    compressed_mid = _compress_block(compressible)
    
    # ── 组装结果 ──
    frozen_prefix = messages[:frozen_idx]
    result = frozen_prefix + compressed_mid + protected
    new_frozen_idx = len(frozen_prefix) + len(compressed_mid)
    
    new_tokens = _estimate_tokens(result)
    
    # 仍超标 → 激进丢弃
    if new_tokens > trigger_threshold and len(compressed_mid) > 1:
        result, new_frozen_idx = _aggressive_compress_cache_safe(
            messages, frozen_idx, protected, token_limit, target_tokens
        )
    
    return result, new_frozen_idx


def _compress_block(messages: List[Dict]) -> List[Dict]:
    """压缩一个消息块，返回压缩后的消息列表（通常 1 条摘要）"""
    if not messages:
        return []
    
    # 收集摘要信息
    summary_parts = []
    tool_call_count = 0
    tool_names_seen = set()
    
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        
        if role == "assistant" and msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                func = tc.get("function", {})
                name = func.get("name", "")
                tool_call_count += 1
                tool_names_seen.add(name)
                args_str = func.get("arguments", "{}")
                try:
                    args = json.loads(args_str) if isinstance(args_str, str) else args_str
                    key_args = {k: str(v)[:80] for k, v in (args.items() if isinstance(args, dict) else [])}
                    summary_parts.append(f"- Called {name}({json.dumps(key_args, ensure_ascii=False)})")
                except (json.JSONDecodeError, TypeError):
                    summary_parts.append(f"- Called {name}()")
        
        elif role == "tool" and content:
            # 提取 tool 结果摘要
            try:
                data = json.loads(content)
                if isinstance(data, dict):
                    brief = {}
                    for k in ("answer", "count", "result", "status", "error"):
                        if k in data:
                            v = data[k]
                            brief[k] = str(v)[:150] if isinstance(v, str) else v
                    if brief:
                        summary_parts.append(f"  → Result: {json.dumps(brief, ensure_ascii=False)[:200]}")
                    else:
                        summary_parts.append(f"  → [{len(content)} chars]")
            except (json.JSONDecodeError, TypeError):
                if len(content) > 200:
                    summary_parts.append(f"  → {content[:200]}...")
                else:
                    summary_parts.append(f"  → {content}")
        
        elif role == "assistant" and content:
            if len(content) > 300:
                summary_parts.append(f"- Assistant: {content[:300]}...")
            else:
                summary_parts.append(f"- Assistant: {content}")
        
        elif role == "user" and content:
            summary_parts.append(f"- User asked: {content[:150]}")
    
    if not summary_parts:
        return []
    
    summary_text = (
        f"[Compressed conversation history: {len(messages)} messages, "
        f"{tool_call_count} tool calls ({', '.join(tool_names_seen)})]\n\n"
        + "\n".join(summary_parts)
    )
    
    return [{"role": "user", "content": summary_text}]


def _aggressive_compress_cache_safe(
    messages: List[Dict],
    frozen_idx: int,
    protected: List[Dict],
    token_limit: int,
    target_tokens: int,
) -> Tuple[List[Dict], int]:
    """激进压缩：保留 frozen prefix + 摘要 + protected"""
    frozen_prefix = messages[:frozen_idx]
    middle = messages[frozen_idx:len(messages) - len(protected)]
    
    frozen_tokens = _estimate_tokens(frozen_prefix)
    protected_tokens = _estimate_tokens(protected)
    budget = target_tokens - frozen_tokens - protected_tokens
    
    if budget <= 0 or not middle:
        # 无预算：只保留 frozen + 一条摘要 + protected
        summary = [{"role": "user", "content": f"[{len(middle)} earlier messages compressed]"}]
        result = frozen_prefix + summary + protected
        return result, len(frozen_prefix) + 1
    
    # 从尾部保留尽量多的中间消息
    kept = []
    used = 0
    for msg in reversed(middle):
        msg_tokens = _estimate_tokens([msg])
        if used + msg_tokens > budget:
            break
        kept.insert(0, msg)
        used += msg_tokens
    
    if not kept:
        summary = [{"role": "user", "content": f"[{len(middle)} earlier messages compressed]"}]
        result = frozen_prefix + summary + protected
        return result, len(frozen_prefix) + 1
    
    result = frozen_prefix + kept + protected
    return result, len(frozen_prefix) + len(kept)


# ══════════════════════════════════════════════════════════════
#  安全阀：Tool Result 截断 + 硬保底
# ══════════════════════════════════════════════════════════════

def _truncate_tool_result(result_str: str, max_chars: int = MAX_SINGLE_TOOL_RESULT_CHARS) -> str:
    """截断单条 tool_result，防止一个网页抓取就撑爆上下文。
    
    保留头部 60% + 尾部 20%（尾部常有结论/摘要），中间用占位符替换。
    """
    if len(result_str) <= max_chars:
        return result_str
    head_size = int(max_chars * 0.6)
    tail_size = int(max_chars * 0.2)
    omitted = len(result_str) - head_size - tail_size
    return (
        result_str[:head_size]
        + f"\n\n[... truncated {omitted} chars to fit context window ...]\n\n"
        + result_str[-tail_size:]
    )


def _hard_cap_messages(
    messages: List[Dict],
    frozen_idx: int,
    hard_cap: int = HARD_CAP_TOKENS,
) -> Tuple[List[Dict], int]:
    """硬保底：如果压缩后仍超过 hard_cap，从 frozen_idx 之后逐条丢弃最旧消息。
    
    这是最后防线，会破坏 KV cache 前缀，但保证不会超限。
    返回 (trimmed_messages, new_frozen_idx)
    """
    total = _estimate_tokens(messages)
    if total <= hard_cap:
        return messages, frozen_idx
    
    frozen_prefix = messages[:frozen_idx]
    mutable = list(messages[frozen_idx:])  # 可丢弃的部分
    
    # 从最旧开始丢弃，直到总量 < hard_cap
    while mutable and _estimate_tokens(frozen_prefix + mutable) > hard_cap:
        mutable.pop(0)
    
    if not mutable:
        # 极端情况：连 frozen prefix 本身就超标 → 截断 frozen 尾部
        # 保留 system prompt（第一条）
        if frozen_prefix and frozen_prefix[0].get("role") == "system":
            result = [frozen_prefix[0]]
        else:
            result = []
        return result, len(result)
    
    result = frozen_prefix + mutable
    return result, frozen_idx


# ══════════════════════════════════════════════════════════════
#  流式 tool_calls 解析
# ══════════════════════════════════════════════════════════════

def _parse_stream_tool_calls(delta_tool_calls: List[Dict], accumulated: Dict):
    """增量合并流式 tool_calls chunk 到累积字典。
    
    OpenAI streaming tool_calls 格式：
    - 首个 chunk: {"index": 0, "id": "call_xxx", "type": "function", "function": {"name": "...", "arguments": ""}}
    - 后续 chunks: {"index": 0, "function": {"arguments": "..."}}  (增量追加)
    """
    for delta_tc in delta_tool_calls:
        idx = delta_tc.get("index", 0)
        if idx not in accumulated:
            accumulated[idx] = {
                "id": "",
                "type": "function",
                "function": {"name": "", "arguments": ""},
            }
        acc = accumulated[idx]
        if delta_tc.get("id"):
            acc["id"] = delta_tc["id"]
        if delta_tc.get("type"):
            acc["type"] = delta_tc["type"]
        func = delta_tc.get("function", {})
        if func.get("name"):
            acc["function"]["name"] += func["name"]
        if func.get("arguments"):
            acc["function"]["arguments"] += func["arguments"]


def _finalize_tool_calls(accumulated: Dict) -> List[Dict]:
    """将累积的 tool_calls 字典转为列表"""
    result = []
    for idx in sorted(accumulated.keys()):
        tc = accumulated[idx]
        if tc["id"] or tc["function"]["name"]:
            result.append({
                "id": tc["id"],
                "type": tc.get("type", "function"),
                "function": tc["function"],
            })
    return result


def _llm_call_stream(
    chat_url: str,
    headers: Dict,
    body: Dict,
    timeout: int = 180,
    yield_deltas: bool = False,
) -> Generator[str, None, Tuple[str, List[Dict], str]]:
    """流式 LLM 调用。yield SSE delta 事件（当 yield_deltas=True），返回 (content, tool_calls, finish_reason)。
    
    当 yield_deltas=True 时，每收到文本 chunk 就 yield 一条 SSE 事件。
    tool_calls 和 content 在流结束后通过 return value 返回。
    
    使用方式：
        gen = _llm_call_stream(url, headers, body, yield_deltas=True)
        try:
            while True:
                sse_event = next(gen)
                yield sse_event  # 转发给前端
        except StopIteration as e:
            content, tool_calls, finish_reason = e.value
    """
    body = dict(body)
    body["stream"] = True
    body["stream_options"] = {"include_usage": True}
    
    content_parts = []
    tool_calls_acc = {}
    finish_reason = None
    usage_info = None
    
    # ── 记录请求日志 ──
    _log_llm_event("request", {
        "model": body.get("model", ""),
        "url": chat_url,
        "messages_count": len(body.get("messages", [])),
        "tools_count": len(body.get("tools", [])),
        "temperature": body.get("temperature"),
        "max_tokens": body.get("max_tokens"),
        # 记录完整消息（可能很大，但便于调试）
        "messages": body.get("messages", []),
    })
    
    try:
        _start_time = time.perf_counter()
        resp = requests.post(chat_url, json=body, headers=headers, timeout=timeout, stream=True)
        resp.raise_for_status()
        # 强制 UTF-8 解码，避免 LLM API 未声明 charset 时回退到 latin-1 导致乱码
        resp.encoding = 'utf-8'
        
        for line in resp.iter_lines(decode_unicode=True):
            if not line:
                continue
            if not line.startswith("data: "):
                continue
            chunk_str = line[6:]
            if chunk_str.strip() == "[DONE]":
                break
            try:
                chunk = json.loads(chunk_str)
            except json.JSONDecodeError:
                continue
            
            # 捕获 usage 信息（通常在最后一个 chunk 中）
            if chunk.get("usage"):
                usage_info = chunk["usage"]
            
            choice = chunk.get("choices", [{}])[0] if chunk.get("choices") else {}
            delta = choice.get("delta", {})
            
            delta_content = delta.get("content", "")
            if delta_content:
                content_parts.append(delta_content)
                if yield_deltas:
                    yield _sse_event("message", {"content": delta_content, "type": "delta"})
            
            delta_tool_calls = delta.get("tool_calls")
            if delta_tool_calls:
                _parse_stream_tool_calls(delta_tool_calls, tool_calls_acc)
            
            fr = choice.get("finish_reason")
            if fr:
                finish_reason = fr
        
        content = "".join(content_parts)
        tool_calls = _finalize_tool_calls(tool_calls_acc)
        
        # ── 记录响应日志 ──
        _log_llm_event("response", {
            "model": body.get("model", ""),
            "finish_reason": finish_reason,
            "content": content[:2000] if content else "",  # 截断避免日志过大
            "content_length": len(content) if content else 0,
            "tool_calls": tool_calls,
            "usage": usage_info,
        })

        duration_ms = (time.perf_counter() - _start_time) * 1000
        record_step("agent_loop", "llm_call",
            duration_ms=duration_ms,
            model=body.get("model", ""),
            success=True,
            prompt_tokens=usage_info.get("prompt_tokens", 0) if usage_info else 0,
            completion_tokens=usage_info.get("completion_tokens", 0) if usage_info else 0,
            total_tokens=usage_info.get("total_tokens", 0) if usage_info else 0,
            tool_calls_count=len(tool_calls),
            content_length=len(content) if content else 0,
            finish_reason=finish_reason or "",
        )

        return content, tool_calls, finish_reason

    except Exception as e:
        duration_ms = (time.perf_counter() - _start_time) * 1000
        record_step("agent_loop", "llm_call",
            duration_ms=duration_ms,
            model=body.get("model", ""),
            success=False,
            error=str(e),
        )
        _log_llm_event("error", {
            "model": body.get("model", ""),
            "url": chat_url,
            "error_type": type(e).__name__,
            "error_message": str(e),
        })
        raise


# ══════════════════════════════════════════════════════════════
#  URL / Prompt 构建
# ══════════════════════════════════════════════════════════════

def _build_chat_url(base_url: str) -> str:
    url = (base_url or "").strip().rstrip("/")
    if not url:
        return ""
    suffix = "/chat/completions"
    if url.endswith(suffix):
        url = url[: -len(suffix)]
    lower_url = url.lower()
    if lower_url.endswith("/api/coding/v3") or lower_url.endswith("/v3"):
        return f"{url}{suffix}"
    if not lower_url.endswith("/v1"):
        if lower_url.endswith("/compatible-mode"):
            pass
        else:
            url += "/v1"
    return f"{url}{suffix}"


def _build_system_prompt(
    skills_prompt: str = "",
    custom_instructions: str = "",
    system_prompt: str = "",
) -> str:
    """构建 system prompt。

    当 system_prompt 非空时，以其为 base（替换默认通用 prompt）；
    否则使用内置通用 base。
    """
    if system_prompt:
        base = system_prompt
    else:
        base = (
            "You are a powerful AI assistant with access to tools. "
            "You can search knowledge bases, search the web, fetch web pages, and more.\n\n"
            "Guidelines:\n"
            "1. Use tools when they can help answer the user's question\n"
            "2. When searching knowledge bases, try different queries if the first one doesn't yield good results\n"
            "3. Always cite your sources when providing information from the knowledge base\n"
            "4. If a tool fails, try an alternative approach\n"
            "5. If the user asks what knowledge sources, platforms, or search channels you have, use get_available_sources before answering\n"
            "6. For multi-platform search or explicit HiDesk/海问思答 requests, prefer unified_search\n"
            "7. Respond in the same language as the user (Chinese if they write in Chinese)\n"
            "8. Be concise but thorough"
        )
    if custom_instructions:
        base += f"\n\nAdditional instructions:\n{custom_instructions}"
    if skills_prompt:
        base += skills_prompt
    return base


def _final_answer_after_iteration_limit(
    chat_url: str,
    headers: Dict[str, str],
    llm_model: str,
    full_messages: List[Dict],
    frozen_idx: int,
    iteration: int,
    max_iterations: int,
    stream_deltas: bool = False,
) -> Generator[str, None, None]:
    """Ask the model to answer with gathered context when tool rounds run out."""
    yield _sse_event("agent_status", {
        "status": "finalizing",
        "iteration": iteration,
        "reason": "max_iterations",
    })

    final_messages = full_messages + [{
        "role": "user",
        "content": (
            f"工具调用轮次已达到上限（{max_iterations} 轮）。请不要再请求工具，"
            "请基于以上已经获得的知识库、联网搜索或网页抓取结果，给出当前能支持的最佳回答。"
            "如果信息有限、存在不确定性或仍需进一步检索，请在回答中简要说明限制。"
        ),
    }]
    final_messages, _ = _compress_context(final_messages, frozen_idx)
    final_messages, _ = _hard_cap_messages(final_messages, frozen_idx)

    body = {
        "model": llm_model,
        "messages": final_messages,
        "temperature": 0.3,
        "max_tokens": MAX_OUTPUT_TOKENS,
    }
    # thinking 限制
    _agent_thinking = get_thinking_limit("agent_loop", 0)
    if _agent_thinking > 0:
        body["enable_thinking"] = True
        body["thinking_budget"] = _agent_thinking

    try:
        gen = _llm_call_stream(chat_url, headers, body, yield_deltas=stream_deltas)
        try:
            while True:
                delta_event = next(gen)
                if stream_deltas:
                    yield delta_event
        except StopIteration as _e:
            content, _tool_calls, _finish_reason = _e.value
    except requests.ConnectionError:
        yield _sse_event("error", {"message": f"Cannot connect to LLM ({chat_url})"})
        return
    except requests.Timeout:
        yield _sse_event("error", {"message": "LLM request timed out while finalizing answer"})
        return
    except Exception as e:
        yield _sse_event("error", {"message": f"LLM error while finalizing answer: {str(e)}"})
        return

    yield _sse_event("message", {"content": content or "", "type": "complete"})
    yield _sse_event("done", {
        "iterations": iteration,
        "max_iterations_reached": True,
    })


# ══════════════════════════════════════════════════════════════
#  Agent Loop（非流式输出，用于 SSE 场景）
# ══════════════════════════════════════════════════════════════

def run_agent_loop(
    messages: List[Dict],
    tools: List[Dict],
    registry,
    llm_config: Dict,
    skills_prompt: str = "",
    custom_instructions: str = "",
    max_iterations: int = 8,
    context: Dict = None,
    system_prompt: str = "",
) -> Generator[str, None, None]:
    """执行 agent 循环，yield SSE 事件。
    
    KV cache 友好：每轮请求 = 上轮完整消息 + 新追加的 append，
    前缀保持不变 → LLM 服务端 prefix cache 命中。
    """
    # 计算已启用的工具名称集合（用于安全校验）
    enabled_tool_names = {t["function"]["name"] for t in tools} if tools else set()

    llm_url = llm_config.get("llm_url", "")
    llm_api_key = llm_config.get("llm_api_key", "")
    llm_model = llm_config.get("llm_model", "")

    chat_url = _build_chat_url(llm_url)
    headers = {"Content-Type": "application/json"}
    if llm_api_key:
        headers["Authorization"] = f"Bearer {llm_api_key}"

    system_msg = {"role": "system", "content": _build_system_prompt(skills_prompt, custom_instructions, system_prompt)}
    # 核心：full_messages 只追加，不修改已有元素
    full_messages = [system_msg] + messages
    frozen_idx = len(full_messages)  # 初始前缀全部冻结

    iteration = 0

    while iteration < max_iterations:
        iteration += 1
        yield _sse_event("agent_status", {"status": "thinking", "iteration": iteration})

        # ── 上下文压缩（KV cache 友好：只压缩 frozen_idx 之后的部分）──
        estimated = _estimate_tokens(full_messages)
        full_messages, frozen_idx = _compress_context(full_messages, frozen_idx)
        new_estimated = _estimate_tokens(full_messages)
        if estimated != new_estimated:
            yield _sse_event("agent_status", {
                "status": "compressed",
                "before_tokens": estimated,
                "after_tokens": new_estimated,
                "iteration": iteration,
            })

        # ── 硬保底：压缩后仍超限时强制丢弃最旧消息 ──
        full_messages, frozen_idx = _hard_cap_messages(full_messages, frozen_idx)

        # ── 流式调用 LLM ──
        body = {
            "model": llm_model,
            "messages": full_messages,
            "temperature": 0.3,
            "max_tokens": MAX_OUTPUT_TOKENS,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        # thinking 限制
        _agent_thinking = get_thinking_limit("agent_loop", 0)
        if _agent_thinking > 0:
            body["enable_thinking"] = True
            body["thinking_budget"] = _agent_thinking

        try:
            gen = _llm_call_stream(chat_url, headers, body, yield_deltas=False)
            try:
                while True:
                    next(gen)
            except StopIteration as _e:
                content, tool_calls, finish_reason = _e.value
        except requests.ConnectionError:
            yield _sse_event("error", {"message": f"Cannot connect to LLM ({llm_url})"})
            return
        except requests.Timeout:
            yield _sse_event("error", {"message": "LLM request timed out (180s)"})
            return
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            detail = ""
            try:
                detail = e.response.json().get("error", {}).get("message", "") or str(e.response.text[:200])
            except Exception:
                detail = str(e)
            yield _sse_event("error", {"message": f"LLM error (HTTP {status}): {detail}"})
            return
        except Exception as e:
            yield _sse_event("error", {"message": f"Unexpected error: {str(e)}"})
            return

        # ── 构造 assistant 消息并追加（保持前缀一致性）──
        assistant_msg = {"role": "assistant", "content": content or None}
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        full_messages.append(assistant_msg)

        # ── 无 tool_calls → 最终回答 ──
        if not tool_calls:
            yield _sse_event("message", {"content": content or "", "type": "complete"})
            yield _sse_event("done", {"iterations": iteration})
            return

        # ── 有 tool_calls → 执行工具 ──
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            tool_args_str = func.get("arguments", "{}")
            tool_call_id = tc.get("id", "")

            try:
                tool_args = json.loads(tool_args_str) if isinstance(tool_args_str, str) else tool_args_str
            except json.JSONDecodeError:
                tool_args = {}

            yield _sse_event("tool_call", {
                "tool": tool_name,
                "args": tool_args,
                "call_id": tool_call_id,
                "status": "calling",
            })

            # 安全校验：如果工具不在已启用列表中，返回错误
            if enabled_tool_names and tool_name not in enabled_tool_names:
                result_str = json.dumps({
                    "error": f"Tool '{tool_name}' is not available. It may be disabled by platform settings.",
                }, ensure_ascii=False)
            else:
                result_str = registry.execute_tool(tool_name, tool_args, context)

            yield _sse_event("tool_result", {
                "tool": tool_name,
                "call_id": tool_call_id,
                "result": result_str[:500],
                "status": "done",
            })

            # 追加 tool result（截断防止单条结果撑爆上下文）
            full_messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": _truncate_tool_result(result_str),
            })

    yield from _final_answer_after_iteration_limit(
        chat_url=chat_url,
        headers=headers,
        llm_model=llm_model,
        full_messages=full_messages,
        frozen_idx=frozen_idx,
        iteration=iteration,
        max_iterations=max_iterations,
        stream_deltas=False,
    )


# ══════════════════════════════════════════════════════════════
#  Agent Stream（流式文字输出 + 工具调用）
# ══════════════════════════════════════════════════════════════

def run_agent_stream(
    messages: List[Dict],
    tools: List[Dict],
    registry,
    llm_config: Dict,
    skills_prompt: str = "",
    custom_instructions: str = "",
    max_iterations: int = 8,
    context: Dict = None,
    system_prompt: str = "",
) -> Generator[str, None, None]:
    """执行 agent 循环，最终回答逐块流式输出。
    
    KV cache 优化：
    - 所有 LLM 调用统一用 stream=True
    - 消息列表只 append，不 pop / 不修改已有元素
    - 每轮前缀 = 上轮完整消息 + 新追加 → prefix cache 命中
    - 无 pop+re-request，不浪费 cache
    """
    # 计算已启用的工具名称集合（用于安全校验，防止 LLM 调用被平台开关过滤的工具）
    enabled_tool_names = {t["function"]["name"] for t in tools} if tools else set()

    llm_url = llm_config.get("llm_url", "")
    llm_api_key = llm_config.get("llm_api_key", "")
    llm_model = llm_config.get("llm_model", "")

    chat_url = _build_chat_url(llm_url)
    headers = {"Content-Type": "application/json"}
    if llm_api_key:
        headers["Authorization"] = f"Bearer {llm_api_key}"

    system_msg = {"role": "system", "content": _build_system_prompt(skills_prompt, custom_instructions, system_prompt)}
    full_messages = [system_msg] + messages
    frozen_idx = len(full_messages)

    iteration = 0

    while iteration < max_iterations:
        iteration += 1
        yield _sse_event("agent_status", {"status": "thinking", "iteration": iteration})

        # ── 上下文压缩 ──
        estimated = _estimate_tokens(full_messages)
        full_messages, frozen_idx = _compress_context(full_messages, frozen_idx)
        new_estimated = _estimate_tokens(full_messages)
        if estimated != new_estimated:
            yield _sse_event("agent_status", {
                "status": "compressed",
                "before_tokens": estimated,
                "after_tokens": new_estimated,
                "iteration": iteration,
            })

        # ── 硬保底：压缩后仍超限时强制丢弃最旧消息 ──
        full_messages, frozen_idx = _hard_cap_messages(full_messages, frozen_idx)

        body = {
            "model": llm_model,
            "messages": full_messages,
            "temperature": 0.3,
            "max_tokens": MAX_OUTPUT_TOKENS,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        # thinking 限制
        _agent_thinking = get_thinking_limit("agent_loop", 0)
        if _agent_thinking > 0:
            body["enable_thinking"] = True
            body["thinking_budget"] = _agent_thinking

        try:
            gen = _llm_call_stream(chat_url, headers, body, yield_deltas=True)
            try:
                while True:
                    delta_event = next(gen)
                    yield delta_event  # 转发逐字 delta 给前端
            except StopIteration as _e:
                content, tool_calls, finish_reason = _e.value
        except requests.ConnectionError:
            yield _sse_event("error", {"message": f"Cannot connect to LLM ({llm_url})"})
            return
        except requests.Timeout:
            yield _sse_event("error", {"message": "LLM request timed out (180s)"})
            return
        except Exception as e:
            yield _sse_event("error", {"message": f"LLM error: {str(e)}"})
            return

        # ── 构造 assistant 消息并追加（前缀只增不减）──
        assistant_msg = {"role": "assistant", "content": content or None}
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        full_messages.append(assistant_msg)

        # ── 无 tool_calls → 最终回答 ──
        if not tool_calls:
            # delta 事件已在上面的流中转发；这里发送 complete 确认
            yield _sse_event("message", {"content": content or "", "type": "complete"})
            yield _sse_event("done", {"iterations": iteration})
            return

        # ── 有 tool_calls → 执行工具 ──
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            tool_args_str = func.get("arguments", "{}")
            tool_call_id = tc.get("id", "")

            try:
                tool_args = json.loads(tool_args_str) if isinstance(tool_args_str, str) else tool_args_str
            except json.JSONDecodeError:
                tool_args = {}

            yield _sse_event("tool_call", {
                "tool": tool_name,
                "args": tool_args,
                "call_id": tool_call_id,
                "status": "calling",
            })

            # 安全校验：如果工具不在已启用列表中（可能被平台开关过滤），返回错误
            if enabled_tool_names and tool_name not in enabled_tool_names:
                result_str = json.dumps({
                    "error": f"Tool '{tool_name}' is not available. It may be disabled by platform settings.",
                }, ensure_ascii=False)
            else:
                result_str = registry.execute_tool(tool_name, tool_args, context)

            yield _sse_event("tool_result", {
                "tool": tool_name,
                "call_id": tool_call_id,
                "result": result_str[:500],
                "status": "done",
            })

            # 追加 tool result（截断防止单条结果撑爆上下文）
            full_messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": _truncate_tool_result(result_str),
            })

    yield from _final_answer_after_iteration_limit(
        chat_url=chat_url,
        headers=headers,
        llm_model=llm_model,
        full_messages=full_messages,
        frozen_idx=frozen_idx,
        iteration=iteration,
        max_iterations=max_iterations,
        stream_deltas=True,
    )
