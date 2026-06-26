"""
Common Vane-style search researcher.

This module is intentionally presentation-agnostic. Callers provide platform
callbacks through init_search_researcher(), then use collect_information() to
run a multi-round search, source picking, page fetching, fact extraction, and
quality evaluation loop.
"""

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import requests

from perf_tracker import record_step


class LLMCallFailed(Exception):
    """Raised when LLM API call fails after all retries."""
    pass


_refs = {}

LLM_REQ_TIMEOUT_NORMAL_SECONDS = 300   # ≤300s LLM requests → unified to 300s
LLM_REQ_TIMEOUT_LONG_SECONDS = 600     # >300s and ≤600s LLM requests → unified to 600s
LLM_MAX_RETRIES = 3
WEB_CONTENT_MAX_CHARS = int(os.environ.get("COMMON_SEARCH_WEB_CONTENT_MAX_CHARS", "120000"))
INFO_EVAL_MAX_CHARS = int(os.environ.get("COMMON_SEARCH_INFO_EVAL_MAX_CHARS", "60000"))
INFO_ORGANIZE_MAX_CHARS = int(os.environ.get("COMMON_SEARCH_INFO_ORGANIZE_MAX_CHARS", "500000"))
AGENT_PLANNER_PROMPT_LOG_CHARS = int(os.environ.get("COMMON_SEARCH_AGENT_PROMPT_LOG_CHARS", "6000"))
WEB_FETCH_BLACKLIST_DOMAINS = frozenset(
    d.strip()
    for d in os.environ.get(
        "COMMON_SEARCH_WEB_FETCH_BLACKLIST_DOMAINS",
        "zhuanlan.zhihu.com",
    ).split(",")
    if d.strip()
)


def init_search_researcher(app_refs: dict):
    _refs.clear()
    _refs.update(app_refs or {})


def is_initialized() -> bool:
    return bool(_refs)


def _log(msg):
    fn = _refs.get("_log")
    if fn:
        try:
            fn(msg)
        except TypeError:
            fn(str(msg))


def _write_log(action: str, details: dict, level: str = "info"):
    fn = _refs.get("write_log")
    if fn:
        fn(action, details, level=level)
    else:
        _log(f"[{action}] {json.dumps(details, ensure_ascii=False)[:1000]}")


def _search_project(project_id, query, mode="normal"):
    fn = _refs.get("_search_project")
    if fn:
        return fn(project_id, query, mode=mode)
    return [], []


def _do_web_search_with_diagnostics(query, max_results=40):
    fn = _refs.get("_do_web_search_with_diagnostics")
    if fn:
        return fn(query, max_results)
    fn = _refs.get("_do_web_search")
    if not fn:
        return [], {"engine": "none", "raw_count": 0, "filtered_count": 0}
    try:
        results, engine, diagnostics = fn(query, max_results=max_results)
        diagnostics = diagnostics or {}
        return results or [], {
            "engine": engine,
            "raw_count": diagnostics.get("raw_count", len(results or [])),
            "filtered_count": diagnostics.get("kept_count", len(results or [])),
            "error": "",
            "filter": {},
        }
    except Exception as exc:
        return [], {"engine": "error", "raw_count": 0, "filtered_count": 0, "error": str(exc)[:200]}


def _fetch_web_content(url, max_chars=WEB_CONTENT_MAX_CHARS):
    fn = _refs.get("_fetch_web_content")
    if fn:
        return fn(url, max_chars=max_chars)
    return ""


def _safe_json_loads(value, fallback=None):
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _can_call_llm() -> bool:
    try:
        load_llm_config = _refs.get("load_llm_config")
        if not load_llm_config:
            return False
        cfg = load_llm_config()
        return bool(cfg.get("llm_url") and cfg.get("llm_model"))
    except Exception:
        return False


def _call_llm_raw(
    system_prompt: str,
    user_msg: str,
    temperature: float = 0.5,
    max_tokens: int = 4096,
    timeout_seconds: Optional[int] = None,
) -> str:
    load_llm_config = _refs.get("load_llm_config")
    if not load_llm_config:
        raise LLMCallFailed("load_llm_config not set")
    cfg = load_llm_config()
    llm_url = cfg.get("llm_url", "")
    llm_api_key = cfg.get("llm_api_key", "")
    llm_model = cfg.get("llm_model", "")
    if not llm_url or not llm_model:
        raise LLMCallFailed("llm_url or llm_model not configured")

    build_fn = _refs.get("build_chat_completions_url")
    chat_url = build_fn(llm_url) if build_fn else llm_url.rstrip("/")
    if not chat_url.endswith("/chat/completions"):
        chat_url += "/chat/completions"

    headers = {"Content-Type": "application/json"}
    if llm_api_key:
        headers["Authorization"] = f"Bearer {llm_api_key}"

    body = {
        "model": llm_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    # thinking 限制
    from image_to_desc import get_thinking_limit
    _search_thinking = get_thinking_limit("search_research", 0)
    if _search_thinking > 0:
        body["enable_thinking"] = True
        body["thinking_budget"] = _search_thinking

    _RETRYABLE_HTTP_STATUS = frozenset({429, 500, 502, 503, 504})
    last_error = None
    max_attempts = LLM_MAX_RETRIES + 1
    _start_time = time.perf_counter()

    for attempt in range(max_attempts):
        # 重试时放大超时时间：attempt 0→1x, 1→2x, 2→3x, 3→4x
        effective_timeout = (timeout_seconds or LLM_REQ_TIMEOUT_NORMAL_SECONDS) * (attempt + 1)
        try:
            resp = requests.post(
                chat_url,
                headers=headers,
                json=body,
                timeout=effective_timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            if not content:
                raise LLMCallFailed("LLM API returned empty content")

            duration_ms = (time.perf_counter() - _start_time) * 1000
            usage = data.get("usage", {})
            record_step("common_search", "llm_call",
                duration_ms=duration_ms,
                model=llm_model,
                success=True,
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                total_tokens=usage.get("total_tokens", 0),
                attempts=attempt + 1,
            )
            return content
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            if status in _RETRYABLE_HTTP_STATUS and attempt < max_attempts - 1:
                delay = 2 ** attempt
                _log(f"common search LLM retry {attempt + 1}/{LLM_MAX_RETRIES} "
                     f"after {delay}s for HTTP {status}")
                time.sleep(delay)
                last_error = exc
                continue
            duration_ms = (time.perf_counter() - _start_time) * 1000
            record_step("common_search", "llm_call",
                duration_ms=duration_ms,
                model=llm_model,
                success=False,
                error=f"HTTP {status}: {exc}",
            )
            raise LLMCallFailed(
                f"LLM API HTTP {status}: {exc}"
            ) from exc
        except (requests.Timeout, requests.ConnectionError) as exc:
            if attempt < max_attempts - 1:
                delay = 2 ** attempt
                _log(f"common search LLM retry {attempt + 1}/{LLM_MAX_RETRIES} "
                     f"after {delay}s for {type(exc).__name__}")
                time.sleep(delay)
                last_error = exc
                continue
            duration_ms = (time.perf_counter() - _start_time) * 1000
            record_step("common_search", "llm_call",
                duration_ms=duration_ms,
                model=llm_model,
                success=False,
                error=str(exc),
            )
            raise LLMCallFailed(
                f"LLM API network error: {exc}"
            ) from exc
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            duration_ms = (time.perf_counter() - _start_time) * 1000
            record_step("common_search", "llm_call",
                duration_ms=duration_ms,
                model=llm_model,
                success=False,
                error=str(exc),
            )
            raise LLMCallFailed(
                f"LLM API unexpected response format: {exc}"
            ) from exc

    duration_ms = (time.perf_counter() - _start_time) * 1000
    record_step("common_search", "llm_call",
        duration_ms=duration_ms,
        model=llm_model,
        success=False,
        error=f"all {max_attempts} attempts failed",
        attempts=max_attempts,
    )
    raise LLMCallFailed(
        f"LLM API call failed after {max_attempts} attempts"
    )


def _call_llm_raw_detailed(
    system_prompt: str,
    user_msg: str,
    temperature: float = 0.5,
    max_tokens: int = 4096,
    timeout_seconds: Optional[int] = None,
) -> dict:
    started = time.time()
    try:
        content = _call_llm_raw(
            system_prompt,
            user_msg,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout_seconds=timeout_seconds,
        )
        return {
            "ok": bool(content),
            "content": content or "",
            "elapsed": round(time.time() - started, 2),
            "error_type": "" if content else "empty_response",
            "error_message": "" if content else "LLM returned no content",
            "max_tokens": max_tokens,
            "input_chars": len(system_prompt or "") + len(user_msg or ""),
        }
    except LLMCallFailed as exc:
        return {
            "ok": False,
            "content": "",
            "elapsed": round(time.time() - started, 2),
            "error_type": "llm_call_failed",
            "error_message": str(exc),
            "max_tokens": max_tokens,
            "input_chars": len(system_prompt or "") + len(user_msg or ""),
        }
    except Exception as exc:
        return {
            "ok": False,
            "content": "",
            "elapsed": round(time.time() - started, 2),
            "error_type": type(exc).__name__,
            "error_message": str(exc)[:500],
            "max_tokens": max_tokens,
            "input_chars": len(system_prompt or "") + len(user_msg or ""),
        }


def _normalize_query(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _search_subject(topic: str) -> str:
    subject = re.sub(
        r"(technical report|presentation|ppt|pptx|slide deck|report|document)",
        " ",
        str(topic or ""),
        flags=re.IGNORECASE,
    )
    subject = _normalize_query(subject).strip(" -_")
    if not subject:
        subject = _normalize_query(topic)
    return f'"{subject}"' if subject and " " in subject else subject


def _extract_focus_model_names(focus_areas) -> list:
    text = " ".join(str(v) for v in (focus_areas or []) if v)
    patterns = [
        r"GPT[-\s]?\d+(?:\.\d+)?(?:[-\s]?[A-Za-z]+)?",
        r"Opus\s*\d+(?:\.\d+)?",
        r"Claude\s+Opus\s*\d+(?:\.\d+)?",
        r"Gemini\s*\d+(?:\.\d+)?(?:[-\s]?[A-Za-z]+)?",
        r"Qwen\s*(?:\d+(?:\.\d+)?(?:[-\s]?[A-Za-z]+)?|[A-Za-z]+)?",
        r"Llama\s*\d+(?:\.\d+)?(?:[-\s]?[A-Za-z]+)?",
        r"Kimi\s*[A-Za-z0-9.\-]+",
        r"Doubao\s*[A-Za-z0-9.\-]+",
    ]
    models = []
    for pattern in patterns:
        for match in re.findall(pattern, text, flags=re.IGNORECASE):
            cleaned = re.sub(r"\s+", " ", str(match)).strip(" ,;:()")
            if cleaned and cleaned.lower() not in {m.lower() for m in models}:
                models.append(cleaned)
    return models


def build_targeted_feedback_queries(topic: str, feedback: str, intent: dict, max_queries: int = 4) -> list:
    text = _normalize_query(feedback)
    if not text:
        return []

    intent = intent or {}
    subject = _search_subject(topic or intent.get("topic", ""))
    focus_areas = list(intent.get("focus_areas") or []) + [text]
    models = _extract_focus_model_names(focus_areas)
    model_text = " ".join(models)
    queries = []

    if model_text:
        queries.extend([
            f"{subject} {model_text} comparison official report",
            f"{subject} vs {model_text} review analysis specification",
            f"{model_text} official documentation pricing features",
        ])
        for model in models[:3]:
            queries.append(f"{model} official documentation review specification pricing")

    if re.search(
        r"comparison|benchmark|review|pricing|cost|ranking|competitor|market|对比|比较|评测|竞品|价格|定价|排名",
        text,
        flags=re.IGNORECASE,
    ):
        queries.append(f"{subject} {text} comparison official")

    queries.append(f"{subject} {text}")
    return _dedupe_strings(queries)[:max_queries]


def _build_initial_queries(topic: str, intent: dict, max_queries: int = 4) -> list:
    focus_areas = intent.get("focus_areas") or []
    queries = [topic]
    for area in focus_areas:
        area_text = _normalize_query(area)
        if area_text:
            queries.append(f"{topic} {area_text}")
    return _dedupe_strings(queries)[:max_queries]


def _deterministic_missing_topic_queries(topic: str, intent: dict, missing_topics: list) -> list:
    subject = _search_subject(topic)
    queries = []
    missing_text = " ".join(str(v) for v in (missing_topics or []) if v)
    for missing in missing_topics or []:
        missing = _normalize_query(missing)
        if missing:
            queries.append(f"{subject} {missing} official report whitepaper")
    if re.search(r"comparison|benchmark|ranking|price|pricing|cost|competitor|market|对比|评测|排名|竞品|价格", missing_text, re.I):
        queries.extend([
            f"{subject} comparison benchmark official report",
            f"{subject} competitive landscape market ranking review",
            f"{subject} vs alternatives specification comparison table",
        ])
    if re.search(r"performance|latency|throughput|serving|deployment|性能|延迟|吞吐|部署", missing_text, re.I):
        queries.extend([
            f"{subject} performance benchmark latency throughput test report",
            f"{subject} deployment cost performance official documentation",
        ])
    if re.search(r"risk|safety|security|compliance|bias|limitation|风险|安全|合规|局限", missing_text, re.I):
        queries.extend([
            f"{subject} safety risk limitations compliance evaluation report",
            f"{subject} security risk assessment official documentation",
        ])
    if re.search(r"data|dataset|corpus|training|source|数据|训练|语料|来源", missing_text, re.I):
        queries.extend([
            f"{subject} data composition corpus filtering official report",
            f"{subject} dataset licensing copyright disclosure official",
        ])
    return _dedupe_strings(queries)


def _expand_missing_topics_to_queries(topic, intent, missing_topics, searched_queries, collected_summary="", max_queries=4):
    missing_topics = [str(v).strip() for v in (missing_topics or []) if str(v).strip()]
    if not missing_topics:
        return [], {"method": "none", "reason": "no_missing_topics"}

    searched = [_normalize_query(v) for v in (searched_queries or []) if v]
    fallback_queries = _deterministic_missing_topic_queries(topic, intent, missing_topics)
    llm_queries = []
    rationale = []
    if _can_call_llm():
        prompt = (
            "You are a search strategy expert. Rewrite broad missing topics into concrete web search queries. "
            "Each query must include the core topic, target one gap, and include a source channel such as "
            "official, report, whitepaper, paper, documentation, pricing, specification, evaluation, benchmark, or comparison. "
            "Return strict JSON: {\"queries\":[...],\"rationale\":[...]}"
        )
        try:
            raw = _call_llm_raw(
                prompt,
                "Topic: {topic}\nFocus areas: {focus}\nMissing topics: {missing}\nSearched queries: {searched}\nCollected summary: {summary}".format(
                    topic=topic,
                    focus=json.dumps(intent.get("focus_areas", []), ensure_ascii=False),
                    missing=json.dumps(missing_topics, ensure_ascii=False),
                    searched=json.dumps(searched[-30:], ensure_ascii=False),
                    summary=(collected_summary or "")[:1800],
                ),
                temperature=0.25,
                max_tokens=1024,
            )
            data = _extract_json_object(raw)
            if isinstance(data, dict):
                llm_queries = data.get("queries", []) or []
                rationale = data.get("rationale", []) or []
        except LLMCallFailed:
            _log("common search missing topic LLM expansion failed, falling back to deterministic rules")

    searched_keys = {q.lower() for q in searched}
    accepted = []
    rejected = []
    seen = set()
    for q in llm_queries:
        q = _normalize_query(q)
        key = q.lower()
        source_ok = any(t in key for t in (
            "official", "report", "whitepaper", "paper", "documentation",
            "pricing", "specification", "evaluation", "review", "analysis",
            "benchmark", "table", "comparison",
        ))
        duplicate = not q or key in searched_keys or key in seen
        if q and source_ok and not duplicate:
            seen.add(key)
            accepted.append(q)
        else:
            rejected.append({"query": q, "reasons": ["duplicate" if duplicate else "missing_source_channel"]})

    candidates = []
    for idx in range(max(len(fallback_queries), len(accepted))):
        if idx < len(fallback_queries):
            candidates.append(fallback_queries[idx])
        if idx < len(accepted):
            candidates.append(accepted[idx])
    deduped = []
    seen = set()
    for q in candidates:
        q = _normalize_query(q)
        key = q.lower()
        if not q or key in searched_keys or key in seen:
            continue
        seen.add(key)
        deduped.append(q)

    return deduped[:max_queries], {
        "method": "llm_plus_rules" if llm_queries else "rules_fallback",
        "missing_topics": missing_topics,
        "llm_queries": [_normalize_query(q) for q in llm_queries],
        "accepted_llm_queries": accepted,
        "rejected_llm_queries": rejected[:8],
        "fallback_queries": fallback_queries,
        "rationale": rationale,
    }


def _available_research_tools_description(platforms: dict, project_ids: list, mode: str) -> str:
    tools = []
    if mode != "speed":
        tools.append(
            """<tool name="__reasoning_preamble">
Use this FIRST on every iteration to state your plan in natural language before any search action. Keep it short, action-focused, and tailored to the current query. Do not mention tool names.
YOU CAN NEVER CALL ANY OTHER TOOL BEFORE CALLING THIS ONE FIRST.
</tool>"""
        )
    if platforms.get("webSearch", False):
        tools.append(
            f"""<tool name="web_search">
Use this tool to perform web searches. Provide up to 3 queries at a time.
{_web_search_action_description(mode)}
</tool>"""
        )
    if platforms.get("local", bool(project_ids)) and project_ids:
        tools.append(
            """<tool name="kb_search">
Use this tool to search the user's knowledge base sources. Provide up to 3 queries at a time. Queries should be directly relevant to the user's request and should not include web-only source-channel words unless those words are part of the user's actual topic.
</tool>"""
        )
    if platforms.get("hiDesk", False):
        tools.append(
            """<tool name="hidesk_search">
Use this tool to search HiDesk enterprise sources. Provide up to 3 concise queries.
</tool>"""
        )
    if platforms.get("haiwen", False):
        tools.append(
            """<tool name="haiwen_search">
Use this tool to search Haiwen enterprise sources. Provide up to 3 concise queries.
</tool>"""
        )
    tools.append(
        """<tool name="done">
Only call this after __reasoning_preamble and after needed search calls when you truly have enough information. Do not call if important information is still missing.
</tool>"""
    )
    return "\n\n".join(tools)


def _web_search_action_description(mode: str) -> str:
    common = (
        "Your queries should be targeted, specific, SEO-friendly keywords rather than full sentences. "
        "Use all 3 query slots when useful. Avoid broad or generic queries unless you are intentionally starting with an overview."
    )
    if mode == "speed":
        return (
            "You are in speed mode and only get one search action. Prioritize the most important queries likely to answer the request in one go. "
            + common
        )
    if mode == "quality":
        return (
            "You are in quality mode. Search several times unless the question is trivial. Start broad, then narrow based on previous results. "
            "Cover multiple angles: overview, features, benchmarks, comparisons, recent updates, use cases, limitations, and critiques. "
            + common
        )
    return (
        "You are in balanced mode. Start initially with broader queries to get an overview, then narrow down with more specific queries based on the results. "
        + common
    )


def _build_research_agent_prompt(mode: str, iteration: int, max_iterations: int, tool_descriptions: str) -> str:
    today = datetime.now(timezone.utc).isoformat()
    if mode == "quality":
        role = "Assistant is a deep-research orchestrator. Your job is to fulfill user requests with the most thorough, comprehensive research possible--no free-form replies."
        goal = (
            "Conduct deep research. Follow an iterative reason-act loop: call __reasoning_preamble before every search action, "
            "then decide the next search action. Each reasoning preamble should reflect on previous results and state the next step."
        )
        core = (
            "Your knowledge is outdated; always use available sources to ground information. Explore multiple angles: definitions, features, comparisons, "
            "recent news, expert opinions, use cases, limitations, alternatives. Do not stop at surface-level coverage."
        )
        protocol = (
            "Aim for 4-7 information-gathering iterations when useful. You may call done only after comprehensive, multi-angle information is gathered."
        )
    elif mode == "speed":
        role = "Assistant is an action orchestrator. Your job is to fulfill user requests by selecting focused search actions--no free-form replies."
        goal = "Fulfill the request quickly using the available sources. Use the most targeted queries first."
        core = "Your knowledge is outdated; if search is available, use it to ground answers even for seemingly basic facts."
        protocol = (
            "Use 3-4 focused information-gathering iterations when useful. Speed comes from using search snippets "
            "without fetching full pages, not from stopping after one iteration. Do not call done before two "
            "information-gathering iterations unless search is unavailable or no usable queries remain."
        )
    else:
        role = "Assistant is an action orchestrator. Your job is to fulfill user requests by reasoning briefly and executing focused search actions--no free-form replies."
        goal = (
            "Fulfill the request with concise reasoning plus focused actions. You must call __reasoning_preamble before every search action. "
            "Alternate: __reasoning_preamble -> search action -> __reasoning_preamble -> search action -> __reasoning_preamble -> done."
        )
        core = (
            "Your knowledge is outdated; if search is available, use it to ground answers. You can call at most 6 actions total per turn: "
            "reasoning, 2-3 information-gathering actions, and done. Aim for at least two information-gathering actions unless results are already sufficient."
        )
        protocol = "Do not stop after a single search unless the task is trivial or prior results already cover the answer."

    return f"""
{role}

Today's date: {today}
You are currently on iteration {iteration + 1} of {max_iterations}.
When finished, call done. Never output normal prose.

<goal>
{goal}
</goal>

<core_principle>
{core}
</core_principle>

<available_tools>
{tool_descriptions}
</available_tools>

<query_generation_rules>
- Each query MUST be 2-6 concise keywords, NOT a sentence or question.
- Queries are search-engine queries, not natural language. Strip all filler words.
- Provide up to 3 queries per action.
- Balanced/quality: start broad to understand the landscape, then narrow based on previous results.
- Prefer diverse queries that cover different dimensions.
- For web search, source-channel words (official, report, paper, documentation, benchmark) are useful when relevant.
- For knowledge-base search, use domain terms and user intent terms; avoid web-only source-channel words.
- Timeliness: when the topic names a specific year or conference edition (e.g. "MLSys 2026"), always include the year in queries. Prefer results from that edition over archived pages from prior years.

<good_examples>
✅ "MLSys 2026 storage papers"
✅ "DeepSeek V4 technical report 2026"
✅ "KV cache compression attention"
✅ "NVIDIA H200 benchmark MMLU 2026"
</good_examples>

<bad_examples>
❌ "What are the latest storage papers at MLSys 2026"  (sentence)
❌ "MLSys storage papers"  (missing year, will return outdated results)
❌ "tell me about DeepSeek V4 architecture"  (natural language)
❌ "I need to find information about GPU memory management techniques"  (sentence)
</bad_examples>
</query_generation_rules>

<mistakes_to_avoid>
1. Over-assuming: do not assume facts; search.
2. Verification obsession: do not waste actions verifying existence; search for the thing directly.
3. Endless loops: if repeated searches do not improve coverage, call done.
4. Skipping the reasoning step: in balanced/quality, __reasoning_preamble must appear before any search action and before done.
5. Query spam: avoid broad duplicates and full-sentence queries.
6. Ignoring timeliness: when the topic references a specific year, conference, event, or release version, explicitly include that temporal scope in queries. Do not pick search results from outdated years unless the topic explicitly calls for historical comparison.
</mistakes_to_avoid>

<response_protocol>
Return strict JSON only. No markdown, no prose outside JSON.
{protocol}
Output schema:
{{
  "reasoning_preamble": "Short natural-language plan. No tool names.",
  "actions": [
    {{"name": "web_search", "queries": ["query1", "query2", "query3"]}},
    {{"name": "kb_search", "queries": ["query1", "query2"]}}
  ],
  "done": false,
  "done_reason": ""
}}
If enough information has been gathered, return:
{{
  "reasoning_preamble": "I have gathered enough information and will wrap up.",
  "actions": [],
  "done": true,
  "done_reason": "why enough"
}}
</response_protocol>
""".strip()


def _research_observation_summary(round_details: list, all_results: list, last_missing_topics: list, searched_queries: set) -> str:
    recent_rounds = []
    for rd in (round_details or [])[-3:]:
        recent_rounds.append({
            "round": rd.get("round"),
            "reasoning_preamble": rd.get("reasoning_preamble", ""),
            "queries": rd.get("queries", []),
            "quality": rd.get("quality", 0),
            "missing_topics": rd.get("missing_topics", []),
            "kb_count": len(rd.get("kb_results", []) or []),
            "web_count": len(rd.get("web_results", []) or []),
            "web_diagnostics": rd.get("web_diagnostics", {}),
        })
    recent_results = []
    for item in (all_results or [])[-8:]:
        text = re.sub(r"\s+", " ", str(item or "")).strip()
        if text:
            recent_results.append(text[:700])
    return json.dumps({
        "recent_rounds": recent_rounds,
        "recent_result_snippets": recent_results,
        "last_missing_topics": last_missing_topics or [],
        "searched_queries": sorted(list(searched_queries or []))[-30:],
    }, ensure_ascii=False, indent=2)


def _fallback_agent_plan(topic: str, intent: dict, round_num: int, last_missing_topics: list, searched_queries: set, forced_queries=None) -> dict:
    if round_num == 0:
        queries = list(forced_queries or [])
        queries.extend(_build_initial_queries(topic, intent or {}, max_queries=3))
        reasoning = (
            f"Okay, the user wants information about {topic}. I will start with broad, directly relevant searches to establish the main context."
        )
    else:
        queries = _deterministic_missing_topic_queries(topic, intent or {}, last_missing_topics)[:3]
        if not queries:
            queries = _build_initial_queries(topic, intent or {}, max_queries=4)
        reasoning = (
            "Based on the previous results, I will narrow the search toward the remaining information gaps and look for more specific evidence."
        )
    searched_keys = {str(q).lower() for q in (searched_queries or set())}
    queries = [q for q in _dedupe_strings(queries) if q.lower() not in searched_keys][:3]
    return {
        "reasoning_preamble": reasoning,
        "actions": [{"name": "web_search", "queries": queries}, {"name": "kb_search", "queries": queries}],
        "done": False,
        "done_reason": "",
        "fallback": True,
    }


def _normalize_agent_plan(plan: dict, platforms: dict, project_ids: list, use_web_search: bool) -> dict:
    plan = plan if isinstance(plan, dict) else {}
    reasoning = _normalize_query(plan.get("reasoning_preamble") or plan.get("plan") or "")
    actions = []
    allowed = set()
    if use_web_search and platforms.get("webSearch", False):
        allowed.add("web_search")
    if platforms.get("local", bool(project_ids)) and project_ids:
        allowed.add("kb_search")
    if platforms.get("hiDesk", False):
        allowed.add("hidesk_search")
    if platforms.get("haiwen", False):
        allowed.add("haiwen_search")
    for action in plan.get("actions", []) or []:
        if not isinstance(action, dict):
            continue
        name = str(action.get("name") or "").strip()
        if name not in allowed:
            continue
        queries = action.get("queries", [])
        queries = queries if isinstance(queries, list) else [queries]
        queries = _dedupe_strings(queries)[:3]
        if queries:
            actions.append({"name": name, "queries": queries})
    return {
        "reasoning_preamble": reasoning,
        "actions": actions,
        "done": bool(plan.get("done")),
        "done_reason": _normalize_query(plan.get("done_reason") or ""),
        "raw": plan,
    }


def _plan_research_actions(
    query: str,
    topic: str,
    intent: dict,
    mode: str,
    round_num: int,
    max_rounds: int,
    platforms: dict,
    project_ids: list,
    use_web_search: bool,
    searched_queries: set,
    all_results: list,
    round_details: list,
    last_missing_topics: list,
    forced_queries: list = None,
    run_id: str = "",
) -> dict:
    fallback_plan = _fallback_agent_plan(topic, intent, round_num, last_missing_topics, searched_queries, forced_queries)
    if not _can_call_llm():
        plan = _normalize_agent_plan(fallback_plan, platforms, project_ids, use_web_search)
        plan["planner_diagnostics"] = {"method": "fallback_no_llm"}
        _write_log("common_search_agent_plan", {
            "run_id": run_id,
            "round": round_num + 1,
            "mode": mode,
            "reasoning_preamble": plan.get("reasoning_preamble", ""),
            "actions": plan.get("actions", []),
            "done": plan.get("done"),
            "done_reason": plan.get("done_reason", ""),
            "planner": plan.get("planner_diagnostics", {}),
        })
        return plan

    tool_desc = _available_research_tools_description(platforms, project_ids, mode)
    system_prompt = _build_research_agent_prompt(mode, round_num, max_rounds, tool_desc)
    user_msg = (
        f"<conversation>\nUser request: {query}\nStandalone question: {topic}\n"
        f"Intent: {json.dumps(intent or {}, ensure_ascii=False)}\n</conversation>\n\n"
        f"<previous_observations>\n{_research_observation_summary(round_details, all_results, last_missing_topics, searched_queries)}\n</previous_observations>\n\n"
        "Plan the next research action now."
    )
    started = time.time()
    raw = _call_llm_raw(system_prompt, user_msg, temperature=0.2, max_tokens=1400, timeout_seconds=LLM_REQ_TIMEOUT_NORMAL_SECONDS)
    elapsed = round(time.time() - started, 2)
    data = _extract_json_object(raw)
    normalized = _normalize_agent_plan(data or {}, platforms, project_ids, use_web_search)
    normalized["planner_diagnostics"] = {
        "method": "llm_agent" if data else "fallback_parse_failed",
        "elapsed": elapsed,
        "raw_preview": (raw or "")[:1200],
        "system_prompt_preview": system_prompt[:AGENT_PLANNER_PROMPT_LOG_CHARS],
        "user_prompt_preview": user_msg[:AGENT_PLANNER_PROMPT_LOG_CHARS],
        "parse_ok": bool(data),
    }
    if not normalized["reasoning_preamble"]:
        normalized["reasoning_preamble"] = fallback_plan["reasoning_preamble"]
    if not normalized["actions"] and not normalized["done"]:
        fallback_normalized = _normalize_agent_plan(fallback_plan, platforms, project_ids, use_web_search)
        normalized["actions"] = fallback_normalized["actions"]
        normalized["planner_diagnostics"]["method"] = "fallback_empty_actions"

    _write_log("common_search_agent_plan", {
        "run_id": run_id,
        "round": round_num + 1,
        "mode": mode,
        "reasoning_preamble": normalized.get("reasoning_preamble", ""),
        "actions": normalized.get("actions", []),
        "done": normalized.get("done"),
        "done_reason": normalized.get("done_reason", ""),
        "planner": normalized.get("planner_diagnostics", {}),
    })
    return normalized


def _queries_from_agent_actions(agent_plan: dict, platforms: dict, project_ids: list, use_web_search: bool) -> tuple:
    web_queries = []
    kb_queries = []
    other_queries = []
    for action in agent_plan.get("actions", []) or []:
        name = action.get("name")
        queries = action.get("queries", []) or []
        if name == "web_search":
            web_queries.extend(queries)
        elif name == "kb_search":
            kb_queries.extend(queries)
        elif name in ("hidesk_search", "haiwen_search"):
            other_queries.extend(queries)
    combined = []
    if platforms.get("webSearch", False) and use_web_search:
        combined.extend(web_queries)
    if platforms.get("local", bool(project_ids)) and project_ids:
        combined.extend(kb_queries or web_queries)
    if platforms.get("hiDesk", False) or platforms.get("haiwen", False):
        combined.extend(other_queries or web_queries or kb_queries)
    if not combined:
        combined.extend(web_queries or kb_queries or other_queries)
    return _dedupe_strings(combined)[:3], {
        "web_queries": _dedupe_strings(web_queries)[:3],
        "kb_queries": _dedupe_strings(kb_queries)[:3],
        "other_queries": _dedupe_strings(other_queries)[:3],
    }


def _extract_json_object(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        pass
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return None
    try:
        return json.loads(match.group())
    except Exception:
        return None


def _dedupe_strings(values) -> list:
    out = []
    seen = set()
    for value in values or []:
        text = _normalize_query(value)
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            out.append(text)
    return out


def _result_text_key(text: str) -> str:
    text = str(text or "")
    url_match = re.search(r"(?im)^URL:\s*(\S+)", text)
    if url_match:
        return "url:" + url_match.group(1).strip().lower()
    return "text:" + re.sub(r"\s+", " ", text).strip().lower()[:800]


def _append_unique_results(all_results: list, new_results: list) -> int:
    seen = {_result_text_key(item) for item in all_results if item}
    added = 0
    for item in new_results or []:
        key = _result_text_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        all_results.append(item)
        added += 1
    return added


def _dedupe_web_candidates(results):
    deduped = []
    seen_urls = set()
    seen_titles = set()
    for item in results or []:
        url = (item.get("url") or "").strip()
        title_key = _normalize_query(item.get("title", "")).lower()
        if url and url in seen_urls:
            continue
        if title_key and title_key in seen_titles:
            continue
        if url:
            seen_urls.add(url)
        if title_key:
            seen_titles.add(title_key)
        deduped.append(item)
    return deduped


def _pick_web_results(query, candidates, max_pick=5):
    candidates = _dedupe_web_candidates(candidates)[:20]
    diag = {
        "enabled": os.environ.get("COMMON_SEARCH_LLM_PICKER", "1") != "0",
        "candidate_count": len(candidates),
        "picked_indices": [],
        "method": "fallback_relevance",
        "error": "",
    }
    if not candidates:
        return [], diag

    fallback = sorted(
        candidates,
        key=lambda item: item.get("relevance", {}).get("score", 0),
        reverse=True,
    )[:max_pick]
    if not diag["enabled"] or not _can_call_llm():
        diag["picked_indices"] = [candidates.index(item) for item in fallback if item in candidates]
        return fallback, diag

    payload = [
        {
            "index": idx,
            "title": item.get("title", "")[:180],
            "url": item.get("url", "")[:260],
            "snippet": item.get("snippet", "")[:500],
        }
        for idx, item in enumerate(candidates)
    ]
    system_prompt = (
        "You are an AI search result picker. Pick the 3-7 results most worth fetching. "
        "Prefer official docs, technical reports, papers, whitepapers, reputable technical articles, "
        "and diverse sources. Avoid irrelevant navigation pages. Return strict JSON: "
        "{\"picked_indices\":[0,2]}"
    )
    try:
        answer = _call_llm_raw(
            system_prompt,
            f"Query: {query}\n\nCandidates:\n{json.dumps(payload, ensure_ascii=False, indent=2)}",
            temperature=0,
            max_tokens=256,
            timeout_seconds=LLM_REQ_TIMEOUT_NORMAL_SECONDS,
        )
        data = _safe_json_loads(answer, None) or _extract_json_object(answer) or {}
        indices = data.get("picked_indices", []) if isinstance(data, dict) else []
        picked = []
        used = set()
        for value in indices:
            try:
                idx = int(value)
            except Exception:
                continue
            if 0 <= idx < len(candidates) and idx not in used:
                picked.append(candidates[idx])
                used.add(idx)
            if len(picked) >= max_pick:
                break
        if picked:
            diag["picked_indices"] = list(used)
            diag["method"] = "llm_picker"
            return picked, diag
    except Exception as exc:
        diag["error"] = str(exc)[:200]
        _log(f"common search picker failed: {exc}")

    diag["picked_indices"] = [candidates.index(item) for item in fallback if item in candidates]
    return fallback, diag


def _extract_web_facts(query, title, url, content, max_chars=WEB_CONTENT_MAX_CHARS):
    content = (content or "").strip()
    diag = {
        "enabled": os.environ.get("COMMON_SEARCH_FACT_EXTRACT", "1") != "0",
        "input_chars": len(content),
        "output_chars": 0,
        "method": "raw_content",
        "error": "",
    }
    if not content:
        return "", diag
    if not diag["enabled"] or not _can_call_llm():
        trimmed = content[:max_chars]
        diag["output_chars"] = len(trimmed)
        return trimmed, diag

    system_prompt = (
        "You are an AI information extractor. Extract only high-density facts relevant to the query. "
        "Keep exact numbers, dates, metrics, table values, benchmark names, prices, and version names. "
        "Ignore navigation, ads, comments, and marketing filler. Output bullet points. "
        "Return strict JSON: {\"extracted_facts\":\"- Fact 1\\n- Fact 2\"}"
    )
    user_prompt = (
        f"Query: {query}\nSource title: {title}\nURL: {url}\n\n"
        f"Web page content:\n{content[:12000]}"
    )
    answer = _call_llm_raw(system_prompt, user_prompt, temperature=0, max_tokens=1800, timeout_seconds=LLM_REQ_TIMEOUT_NORMAL_SECONDS)
    data = _safe_json_loads(answer, None) or _extract_json_object(answer) or {}
    facts = data.get("extracted_facts", "") if isinstance(data, dict) else ""
    facts = str(facts or "").strip()
    if facts:
        if len(facts) > max_chars:
            facts = facts[:max_chars] + f"\n\n...(truncated, kept {max_chars} chars)"
        diag["output_chars"] = len(facts)
        diag["method"] = "llm_extractor"
        return facts, diag
    else:
        _log(f"common search fact extraction empty: query={query[:60]} title={title[:60]} "
             f"raw_len={len(answer or '')} "
             f"json_keys={list(data.keys()) if isinstance(data, dict) else 'non_json'} "
             f"raw_preview={(answer or '')[:200]}")
        diag["error"] = "extracted_facts_empty_or_missing"

    placeholder = f"[content not extracted] Source URL: {url}\n(query: {query[:80]})"
    diag["output_chars"] = len(placeholder)
    return placeholder, diag


def _aggregate_round_info(round_details, current_round):
    aggregate = {"kb_results": [], "web_results": []}
    for rd in (round_details or []) + ([current_round] if current_round else []):
        aggregate["kb_results"].extend(rd.get("kb_results", []) or [])
        aggregate["web_results"].extend(rd.get("web_results", []) or [])
    return aggregate


def _adjust_quality_score(llm_score, round_info, missing_topics=None):
    score = float(llm_score or 0)
    missing_topics = missing_topics or []
    kb_count = len(round_info.get("kb_results", []) or [])
    web_results = round_info.get("web_results", []) or []
    web_count = len(web_results)
    fetched_count = len([w for w in web_results if w.get("fetched")])
    if kb_count + web_count < 2:
        score = min(score, 65)
    elif kb_count + web_count < 4:
        score = min(score, 80)
    if web_count > 0:
        fetch_ratio = fetched_count / max(web_count, 1)
        if fetched_count == 0:
            score = min(score, 75)
        elif fetch_ratio < 0.3:
            score = min(score, 85)
    if len(missing_topics) >= 1:
        score = min(score, 95)
    if len(missing_topics) >= 2:
        score = min(score, 85)
    if len(missing_topics) >= 3:
        score = min(score, 75)
    return round(score, 1)


def _process_single_query(
    q,
    qi,
    round_num,
    topic,
    project_ids,
    platforms,
    per_query_web_limit,
    run_id,
    seen_web_urls_snapshot,
    seen_kb_paths_snapshot,
    log_prefix,
    mode="balanced",
    cancel_check=None,
):
    if cancel_check and cancel_check():
        return _empty_query_result(q, qi, cancelled=True)

    use_kb = platforms.get("local", bool(project_ids)) and bool(project_ids)
    use_web = platforms.get("webSearch", False)
    use_hidesk = platforms.get("hiDesk", False)
    use_haiwen = platforms.get("haiwen", False)

    result = _empty_query_result(q, qi, web_enabled=use_web)
    query_diag = result["query_diag"]

    platform_results = {"kb_sources": [], "web_data": None, "web_diag": None, "hidesk_result": None, "haiwen_result": None}
    max_workers = max(len(project_ids or []) + int(use_web) + int(use_hidesk) + int(use_haiwen), 3)
    futures = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        if use_kb:
            for pid in (project_ids or []):
                futures[executor.submit(_search_project, pid, q, mode="graph")] = ("kb", pid)
        if use_web:
            futures[executor.submit(_do_web_search_with_diagnostics, q, max_results=per_query_web_limit)] = ("web",)
        if use_hidesk and _refs.get("_search_platform_hidesk"):
            futures[executor.submit(_refs["_search_platform_hidesk"], q)] = ("hidesk",)
        if use_haiwen and _refs.get("_search_platform_haiwen"):
            futures[executor.submit(_refs["_search_platform_haiwen"], q)] = ("haiwen",)

        for fut in as_completed(futures):
            tag = futures[fut]
            try:
                value = fut.result(timeout=120)
                if tag[0] == "kb":
                    platform_results["kb_sources"].append((tag[1], *value))
                elif tag[0] == "web":
                    platform_results["web_data"], platform_results["web_diag"] = value
                elif tag[0] == "hidesk":
                    platform_results["hidesk_result"] = value
                elif tag[0] == "haiwen":
                    platform_results["haiwen_result"] = value
            except Exception as exc:
                query_diag["errors"].append(f"{tag}: {str(exc)[:200]}")

    for pid, contexts, sources in platform_results["kb_sources"]:
        _write_log("common_search_kb_search", {
            "run_id": run_id,
            "round": round_num + 1,
            "query": q,
            "project_id": pid,
            "contexts_count": len(contexts or []),
            "sources_count": len(sources or []),
        })
        kb_items = []
        for ctx in (contexts or []):
            if len(kb_items) >= 10:
                break
            content = ctx.get("content", "")
            path = ctx.get("path", "")
            if path and path in seen_kb_paths_snapshot:
                continue
            if path:
                result["new_kb_paths"].add(path)
            kb_items.append({"path": path, "snippet": content[:200]})
            if content:
                result["texts"].append(content)
        result["kb_items"].extend(kb_items)
        query_diag["kb_count"] += len(kb_items)
        query_diag["kb_items"].extend(kb_items[:5])
        result["sources"].extend(sources or [])

    _merge_platform_text_result(result, platform_results.get("hidesk_result"), "HiDesk")
    _merge_platform_text_result(result, platform_results.get("haiwen_result"), "Haiwen")

    web_data = platform_results.get("web_data")
    web_diag = platform_results.get("web_diag")
    if use_web and web_data is not None:
        _process_web_results(
            result,
            web_data,
            web_diag,
            q,
            round_num,
            run_id,
            seen_web_urls_snapshot,
            log_prefix,
            mode,
        )

    plats = []
    if use_kb and platform_results["kb_sources"]:
        plats.append(f"KB({query_diag['kb_count']})")
    if use_web and web_data is not None:
        plats.append(f"Web({query_diag['web_kept_count']})")
    if use_hidesk and platform_results.get("hidesk_result"):
        plats.append(f"HiDesk({len((platform_results['hidesk_result'] or {}).get('results', []))})")
    if use_haiwen and platform_results.get("haiwen_result"):
        plats.append(f"Haiwen({len((platform_results['haiwen_result'] or {}).get('results', []))})")
    result["platforms_summary"] = ", ".join(plats)
    _log(f"{log_prefix}common search round={round_num + 1} query={q!r} platforms=[{result['platforms_summary']}]")
    return result


def _empty_query_result(q, qi, web_enabled=False, cancelled=False):
    errors = ["cancelled"] if cancelled else []
    return {
        "query": q,
        "qi": qi,
        "texts": [],
        "kb_items": [],
        "web_result_items": [],
        "new_web_urls": set(),
        "new_kb_paths": set(),
        "sources": [],
        "query_diag": {
            "query": q,
            "kb_count": 0,
            "kb_items": [],
            "web_enabled": bool(web_enabled),
            "web_raw_count": 0,
            "web_kept_count": 0,
            "web_duplicate_count": 0,
            "web_no_url_count": 0,
            "web_fetch_failed_count": 0,
            "web_items": [],
            "errors": errors,
        },
        "web_search_called": False,
        "web_raw_count": 0,
        "web_filtered_count": 0,
        "web_blacklist_dropped": 0,
        "web_cross_round_dedup_dropped": 0,
        "web_picked_count": 0,
        "web_kept_count": 0,
        "web_fetch_failed_count": 0,
        "web_no_url_count": 0,
        "web_duplicate_count": 0,
        "platforms_summary": "",
    }


def _merge_platform_text_result(result, platform_result, label):
    if not platform_result or not isinstance(platform_result, dict):
        return
    for item in platform_result.get("results", []) or []:
        content = item.get("content", "")
        if content:
            result["texts"].append(f"[{label}] {content}")
            result["query_diag"]["kb_items"].append({
                "path": item.get("path", ""),
                "snippet": content[:200],
                "platform": label,
            })


def _process_web_results(result, web_data, web_search_diag, query, round_num, run_id, seen_web_urls_snapshot, log_prefix, mode="balanced"):
    query_diag = result["query_diag"]
    result["web_search_called"] = True
    query_diag["web_search_diagnostics"] = web_search_diag or {}
    query_diag["web_raw_count"] = (web_search_diag or {}).get("raw_count", len(web_data or []))
    query_diag["web_filtered_count"] = (web_search_diag or {}).get("filtered_count", len(web_data or []))
    result["web_raw_count"] = query_diag["web_raw_count"]
    result["web_filtered_count"] = query_diag["web_filtered_count"]

    if not web_data:
        return

    before_filter = len(web_data)
    web_data = [
        item for item in web_data
        if (urlparse(item.get("url", "")).netloc or urlparse("//" + item.get("url", "")).netloc)
        not in WEB_FETCH_BLACKLIST_DOMAINS
    ]
    result["web_blacklist_dropped"] += before_filter - len(web_data)

    before_dedup = len(web_data)
    web_data = [item for item in web_data if item.get("url", "") not in seen_web_urls_snapshot]
    result["web_cross_round_dedup_dropped"] += before_dedup - len(web_data)
    if not web_data:
        return

    max_pick = min(5, len(web_data))
    picked_web_data, picker_diag = _pick_web_results(query, web_data, max_pick=max_pick)
    query_diag["vane_picker"] = picker_diag
    result["web_picked_count"] += len(picked_web_data)
    _write_log("common_search_web_pick", {
        "run_id": run_id,
        "round": round_num + 1,
        "mode": mode,
        "query": query,
        "picked_count": len(picked_web_data),
        "picker": picker_diag,
        "picked": [{"title": it.get("title", ""), "url": it.get("url", "")} for it in picked_web_data],
    })

    # Speed mode: skip web scraping and LLM fact extraction, use snippet directly
    if mode in ("speed",):
        for item in picked_web_data:
            url = item.get("url", "")
            if not url or url in seen_web_urls_snapshot:
                continue
            title = item.get("title", "")
            snippet = item.get("snippet", "")
            text = f"## Source: {title}\nURL: {url}\n\n{snippet}"
            result["texts"].append(text)
            web_item = {
                "title": title,
                "url": url,
                "snippet": snippet[:150],
                "fetched": False,
                "content_length": len(snippet),
                "extracted": False,
                "extracted_length": len(snippet),
                "extract_diagnostics": {"method": "snippet_only_speed_mode"},
            }
            result["web_result_items"].append(web_item)
            query_diag["web_items"].append(web_item)
            query_diag["web_kept_count"] += 1
            result["web_kept_count"] += 1
            result["sources"].append(url)
            result["new_web_urls"].add(url)
        return

    processed_urls = set(seen_web_urls_snapshot)
    fetch_tasks = []
    for item in picked_web_data:
        url = item.get("url", "")
        if not url or url in processed_urls:
            continue
        processed_urls.add(url)
        fetch_tasks.append((item, url))

    fetch_results = {}
    failed_fetch_urls = set()
    if fetch_tasks:
        def fetch_one(url, tasks):
            content = _fetch_web_content(url, max_chars=WEB_CONTENT_MAX_CHARS)
            facts = ""
            diag = {"enabled": False}
            title = ""
            if content:
                for item, item_url in tasks:
                    if item_url == url:
                        title = item.get("title", "")
                        break
                facts, diag = _extract_web_facts(query, title, url, content, max_chars=WEB_CONTENT_MAX_CHARS)
            return url, content or "", facts, diag, title

        with ThreadPoolExecutor(max_workers=min(len(fetch_tasks), 4)) as executor:
            futures = {executor.submit(fetch_one, url, fetch_tasks): url for _, url in fetch_tasks}
            _write_log("common_search_web_fetch_start", {
                "run_id": run_id,
                "round": round_num + 1,
                "mode": mode,
                "query": query,
                "fetch_count": len(fetch_tasks),
                "max_workers": min(len(fetch_tasks), 4),
                "fact_extract_enabled": os.environ.get("COMMON_SEARCH_FACT_EXTRACT", "1") != "0",
                "urls": list(futures.values()),
            })
            for fut in as_completed(futures):
                url_for_log = futures[fut]
                try:
                    url, content, facts, diag, title = fut.result(timeout=60)
                    fetch_results[url] = (content, facts, diag, title)
                except Exception as exc:
                    failed_fetch_urls.add(url_for_log)
                    result["web_fetch_failed_count"] += 1
                    query_diag["web_fetch_failed_count"] += 1
                    _write_log("common_search_web_fetch_failed", {
                        "run_id": run_id,
                        "round": round_num + 1,
                        "mode": mode,
                        "query": query,
                        "url": url_for_log,
                        "error": str(exc)[:300],
                    }, level="warning")
                    _log(f"{log_prefix}common search fetch failed: {url_for_log}: {exc}")

    success_count = 0
    fail_count = 0
    for item, url in fetch_tasks:
        if not url:
            result["web_no_url_count"] += 1
            query_diag["web_no_url_count"] += 1
            continue
        if url not in fetch_results:
            if url in failed_fetch_urls:
                continue
            result["web_fetch_failed_count"] += 1
            query_diag["web_fetch_failed_count"] += 1
            _write_log("common_search_web_fetch_failed", {
                "run_id": run_id,
                "round": round_num + 1,
                "mode": mode,
                "query": query,
                "url": url,
                "error": "fetch returned no result",
            }, level="warning")
            continue
        web_content, extracted_facts, extract_diag, _ = fetch_results[url]
        if web_content:
            success_count += 1
            _append_web_item(result, query_diag, item, url, web_content, extracted_facts, extract_diag, run_id, round_num, query)
        else:
            fail_count += 1
            result["web_fetch_failed_count"] += 1
            query_diag["web_fetch_failed_count"] += 1

    if fail_count > 0 and success_count < max_pick:
        used_urls = {it.get("url", "") for it in picked_web_data}
        backups = sorted(
            [
                item for item in web_data
                if item.get("url", "") not in used_urls and item.get("url", "") not in processed_urls
            ],
            key=lambda item: item.get("relevance", {}).get("score", 0),
            reverse=True,
        )
        for backup in backups:
            if success_count >= max_pick:
                break
            url = backup.get("url", "")
            if not url or url in processed_urls:
                continue
            processed_urls.add(url)
            content = _fetch_web_content(url, max_chars=WEB_CONTENT_MAX_CHARS)
            if content:
                facts, diag = _extract_web_facts(query, backup.get("title", ""), url, content, max_chars=WEB_CONTENT_MAX_CHARS)
                _append_web_item(result, query_diag, backup, url, content, facts, diag, run_id, round_num, query)
                success_count += 1
            else:
                result["web_fetch_failed_count"] += 1
                query_diag["web_fetch_failed_count"] += 1

    result["new_web_urls"].update(processed_urls)


def _append_web_item(result, query_diag, item, url, web_content, extracted_facts, extract_diag, run_id, round_num, query):
    title = item.get("title", "")
    snippet = item.get("snippet", "")
    text = f"## Source: {title}\nURL: {url}\n\n{extracted_facts or web_content}"
    result["texts"].append(text)
    web_item = {
        "title": title,
        "url": url,
        "snippet": snippet[:150],
        "fetched": True,
        "content_length": len(web_content),
        "extracted": extract_diag.get("method") == "llm_extractor",
        "extracted_length": extract_diag.get("output_chars", 0),
        "extract_diagnostics": extract_diag,
    }
    result["web_result_items"].append(web_item)
    query_diag["web_items"].append(web_item)
    query_diag["web_kept_count"] += 1
    result["web_kept_count"] += 1
    result["sources"].append(url)
    result["new_web_urls"].add(url)
    _write_log("common_search_web_fetch", {
        "run_id": run_id,
        "round": round_num + 1,
        "query": query,
        "title": title,
        "url": url,
        "content_length": len(web_content),
        "extract_method": extract_diag.get("method", "-"),
        "extracted_length": extract_diag.get("output_chars", 0),
    })


def collect_information(
    query: str,
    intent: dict,
    project_ids: list,
    use_web_search: bool,
    max_rounds: int = 5,
    on_progress=None,
    run_id: str = "",
    forced_queries: list = None,
    platforms: dict = None,
    mode: str = "balanced",
    cancel_check=None,
) -> dict:
    if platforms is None:
        platforms = {"local": bool(project_ids), "webSearch": bool(use_web_search), "hiDesk": False, "haiwen": False}
    if mode not in ("speed", "balanced", "quality"):
        mode = "balanced"

    if mode == "speed":
        max_rounds = max(max_rounds, 4)
    elif mode == "balanced":
        max_rounds = max(max_rounds, 6)
    elif mode == "quality":
        max_rounds = max(max_rounds, 8)

    all_results = []
    all_sources = []
    quality_score = 0.0
    rounds_used = 0
    planning_rounds_used = 0
    round_details = []
    topic = (intent or {}).get("topic", query)
    focus_areas = (intent or {}).get("focus_areas") or []
    searched_queries = set()
    seen_kb_paths = set()
    seen_web_urls = set()
    last_missing_topics = []
    log_prefix = f"[Search:{run_id}] " if run_id else "[Search] "

    _write_log("common_search_start", {
        "run_id": run_id,
        "topic": topic,
        "project_ids": project_ids,
        "use_web_search": bool(use_web_search),
        "max_rounds": max_rounds,
        "forced_queries": forced_queries or [],
        "mode": mode,
    })

    for round_num in range(max_rounds):
        if cancel_check and cancel_check():
            break
        planning_rounds_used = round_num + 1
        round_info = {
            "round": round_num + 1,
            "queries": [],
            "skipped_queries": [],
            "kb_results": [],
            "web_results": [],
            "quality": 0,
            "web_diagnostics": {
                "enabled": bool(use_web_search),
                "search_called": 0,
                "raw_count": 0,
                "filtered_count": 0,
                "filtered_drop_count": 0,
                "duplicate_count": 0,
                "no_url_count": 0,
                "fetch_failed_count": 0,
                "kept_count": 0,
                "error_count": 0,
                "errors": [],
            },
            "query_results": [],
        }
        if on_progress:
            on_progress({
                "step": 2,
                "status": "running",
                "message": f"Searching information (round {round_num + 1}/{max_rounds})...",
                "round": round_num + 1,
            })

        agent_plan = _plan_research_actions(
            query=query,
            topic=topic,
            intent=intent or {},
            mode=mode,
            round_num=round_num,
            max_rounds=max_rounds,
            platforms=platforms,
            project_ids=project_ids,
            use_web_search=use_web_search,
            searched_queries=searched_queries,
            all_results=all_results,
            round_details=round_details,
            last_missing_topics=last_missing_topics,
            forced_queries=forced_queries if round_num == 0 else None,
            run_id=run_id,
        )
        minimum_search_rounds = 2 if mode in ("speed", "balanced") else 4
        if agent_plan.get("done") and all_results and rounds_used < minimum_search_rounds:
            fallback_plan = _normalize_agent_plan(
                _fallback_agent_plan(
                    topic, intent or {}, round_num, last_missing_topics,
                    searched_queries, forced_queries=None,
                ),
                platforms, project_ids, use_web_search,
            )
            agent_plan["done"] = False
            agent_plan["done_reason"] = ""
            agent_plan["actions"] = fallback_plan.get("actions", [])
            agent_plan["reasoning_preamble"] = (
                f"Only {rounds_used} actual search round(s) have completed; "
                f"continue toward the minimum of {minimum_search_rounds} with a focused follow-up search."
            )
            _write_log("common_search_early_done_overridden", {
                "run_id": run_id,
                "round": round_num + 1,
                "mode": mode,
                "actual_search_rounds": rounds_used,
                "minimum_search_rounds": minimum_search_rounds,
                "replacement_actions": agent_plan.get("actions", []),
            })
        search_queries, action_queries = _queries_from_agent_actions(
            agent_plan, platforms, project_ids, use_web_search
        )
        round_info["reasoning_preamble"] = agent_plan.get("reasoning_preamble", "")
        round_info["agent_actions"] = agent_plan.get("actions", [])
        round_info["agent_done"] = bool(agent_plan.get("done"))
        round_info["agent_done_reason"] = agent_plan.get("done_reason", "")
        round_info["agent_planner"] = agent_plan.get("planner_diagnostics", {})
        round_info["query_expansion"] = {
            "method": "vane_research_agent",
            "action_queries": action_queries,
            "forced_queries": forced_queries or [],
        }

        if on_progress and round_info["reasoning_preamble"]:
            on_progress({
                "step": 2,
                "status": "reasoning",
                "message": round_info["reasoning_preamble"],
                "data": {
                    "round": round_num + 1,
                    "actions": round_info["agent_actions"],
                },
            })

        if agent_plan.get("done") and all_results:
            round_info["results_count"] = 0
            round_info["new_results_count"] = 0
            round_info["cumulative_results_count"] = len(all_results)
            round_info["quality"] = quality_score
            round_info["missing_topics"] = last_missing_topics
            round_details.append(round_info)
            _write_log("common_search_agent_done", {
                "run_id": run_id,
                "round": round_num + 1,
                "reasoning_preamble": round_info["reasoning_preamble"],
                "done_reason": round_info["agent_done_reason"],
                "total_results": len(all_results),
            })
            break

        searched_keys = {s.lower() for s in searched_queries}
        deduped_queries = []
        skipped_queries = []
        for q in search_queries:
            q = _normalize_query(q)
            if not q:
                continue
            if q.lower() in searched_keys:
                skipped_queries.append(q)
                continue
            deduped_queries.append(q)
        search_queries = deduped_queries[:3]
        round_info["queries"] = search_queries
        round_info["skipped_queries"] = skipped_queries

        if not search_queries:
            round_info["results_count"] = 0
            round_info["new_results_count"] = 0
            round_info["cumulative_results_count"] = len(all_results)
            round_info["quality"] = quality_score
            round_info["missing_topics"] = last_missing_topics
            round_details.append(round_info)
            _write_log("common_search_no_new_queries", {
                "run_id": run_id,
                "round": round_num + 1,
                "reasoning_preamble": round_info.get("reasoning_preamble", ""),
                "agent_actions": round_info.get("agent_actions", []),
                "searched_queries": sorted(list(searched_queries)),
                "skipped_queries": skipped_queries,
            })
            break

        queried_list = []
        for q in search_queries:
            if q.lower() in {s.lower() for s in searched_queries}:
                continue
            queried_list.append(q)
            searched_queries.add(q)

        if queried_list:
            rounds_used += 1

        if on_progress and queried_list:
            on_progress({
                "step": 2,
                "status": "running",
                "message": f"Running {len(queried_list)} search queries in parallel...",
                "hb_data": {"round": round_num + 1, "max_rounds": max_rounds, "parallel_queries": len(queried_list)},
            })
        _write_log("common_search_round_execute", {
            "run_id": run_id,
            "round": round_num + 1,
            "mode": mode,
            "reasoning_preamble": round_info.get("reasoning_preamble", ""),
            "queries": queried_list,
            "skipped_queries": skipped_queries,
            "agent_actions": round_info.get("agent_actions", []),
        })

        query_outputs = []
        seen_web_snapshot = set(seen_web_urls)
        seen_kb_snapshot = set(seen_kb_paths)
        with ThreadPoolExecutor(max_workers=max(len(queried_list), 1)) as executor:
            futures = {
                executor.submit(
                    _process_single_query,
                    q,
                    idx,
                    round_num,
                    topic,
                    project_ids,
                    platforms,
                    20,
                    run_id,
                    seen_web_snapshot,
                    seen_kb_snapshot,
                    log_prefix,
                    mode,
                    cancel_check,
                ): (idx, q)
                for idx, q in enumerate(queried_list)
            }
            for fut in as_completed(futures):
                idx, q = futures[fut]
                try:
                    query_outputs.append((idx, fut.result(timeout=600)))
                except Exception as exc:
                    _write_log("common_search_query_failed", {
                        "run_id": run_id,
                        "round": round_num + 1,
                        "mode": mode,
                        "query": q,
                        "error": str(exc)[:300],
                    }, level="warning")
                    _log(f"{log_prefix}query {q!r} failed: {exc}")

        query_outputs.sort(key=lambda item: item[0])
        round_results = []
        for _, qout in query_outputs:
            round_results.extend(qout["texts"])
            round_info["kb_results"].extend(qout["kb_items"])
            round_info["web_results"].extend(qout["web_result_items"])
            seen_web_urls.update(qout["new_web_urls"])
            seen_kb_paths.update(qout["new_kb_paths"])
            all_sources.extend(qout["sources"])
            round_info["query_results"].append(qout["query_diag"])
            wd = round_info["web_diagnostics"]
            if qout["web_search_called"]:
                wd["search_called"] += 1
            wd["raw_count"] += qout["web_raw_count"]
            wd["filtered_count"] += qout["web_filtered_count"]
            wd["filtered_drop_count"] += max(qout["web_raw_count"] - qout["web_filtered_count"], 0)
            wd["blacklist_dropped"] = wd.get("blacklist_dropped", 0) + qout["web_blacklist_dropped"]
            wd["cross_round_dedup_dropped"] = wd.get("cross_round_dedup_dropped", 0) + qout["web_cross_round_dedup_dropped"]
            wd["picked_count"] = wd.get("picked_count", 0) + qout["web_picked_count"]
            wd["kept_count"] += qout["web_kept_count"]
            wd["fetch_failed_count"] += qout["web_fetch_failed_count"]
            wd["no_url_count"] += qout["web_no_url_count"]
            wd["duplicate_count"] += qout["web_duplicate_count"]
            if on_progress:
                short = qout["query"][:40] + ("..." if len(qout["query"]) > 40 else "")
                on_progress({"step": 2, "status": "running", "message": f"Search complete: \"{short}\" -> {qout['platforms_summary'] or 'no result'}"})
            _write_log("common_search_query_done", {
                "run_id": run_id,
                "round": round_num + 1,
                "query": qout["query"],
                "platforms_summary": qout.get("platforms_summary", ""),
                "texts_count": len(qout.get("texts", [])),
                "kb_count": len(qout.get("kb_items", [])),
                "web_count": len(qout.get("web_result_items", [])),
                "query_diag": qout.get("query_diag", {}),
            })

        if round_results:
            unique_added = _append_unique_results(all_results, round_results)
        else:
            unique_added = 0

        if on_progress and round_results:
            total_kb = sum(qr.get("kb_count", 0) for qr in round_info["query_results"])
            total_web = sum(qr.get("web_kept_count", 0) for qr in round_info["query_results"])
            fetched_web = sum(1 for r in round_info.get("web_results", []) if r.get("fetched"))
            on_progress({
                "step": 2,
                "status": "running",
                "message": f"Round {round_num + 1} complete: KB {total_kb} + Web {total_web} (fetched {fetched_web}); total {len(all_results)}",
                "hb_data": {"round": round_num + 1, "round_kb": total_kb, "round_web": total_web, "cumulative_results": len(all_results)},
            })
        _write_log("common_search_round_results", {
            "run_id": run_id,
            "round": round_num + 1,
            "raw_results_count": len(round_results),
            "unique_added": unique_added,
            "cumulative_results_count": len(all_results),
            "kb_results_count": len(round_info["kb_results"]),
            "web_results_count": len(round_info["web_results"]),
            "web_diagnostics": round_info["web_diagnostics"],
        })

        round_info["new_results_count"] = unique_added
        round_info["cumulative_results_count"] = len(all_results)
        round_info["results_count"] = len(round_results)
        round_details.append(round_info)

    collected_info = "\n".join(all_results)[:INFO_ORGANIZE_MAX_CHARS]
    summary_text = "\n".join(all_results[:5])[:500] if all_results else ""

    # Final quality evaluation (for reference only, does not affect search flow)
    final_eval_data, final_eval_call = _evaluate_information_quality(topic, focus_areas, searched_queries, last_missing_topics, all_results)
    if final_eval_data:
        final_missing = final_eval_data.get("missing_topics", []) or []
        raw_score = final_eval_data.get("total_score", 0)
        quality_score = _adjust_quality_score(raw_score, {"kb_results": [], "web_results": []}, final_missing)
        _write_log("common_search_quality_eval", {
            "run_id": run_id,
            "round": "final",
            "quality_score": quality_score,
            "raw_quality_score": raw_score,
            "coverage": final_eval_data.get("coverage", 0),
            "depth": final_eval_data.get("depth", 0),
            "timeliness": final_eval_data.get("timeliness", 0),
            "missing_topics": final_missing,
            "cumulative_results_count": len(all_results),
            "note": "reference_only_gaps_handled_by_content_planning",
        })
        if on_progress:
            on_progress({"step": 2, "status": "search_done", "data": {
                "results_count": len(all_results),
                "cumulative_results_count": len(all_results),
                "quality_score": quality_score,
                "raw_quality_score": raw_score,
                "coverage": final_eval_data.get("coverage", 0),
                "depth": final_eval_data.get("depth", 0),
                "timeliness": final_eval_data.get("timeliness", 0),
                "missing_topics": final_missing,
                "round_details": round_details,
                "note": "reference_only_gaps_handled_by_content_planning",
            }})

    if on_progress:
        on_progress({"step": 2, "status": "done", "data": {
            "total_results": len(all_results),
            "final_quality": quality_score,
            "rounds_used": rounds_used,
            "planning_rounds_used": planning_rounds_used,
            "sources_count": len(set(all_sources)),
            "round_details": round_details,
            "summary": summary_text,
            "collected_info_length": len(collected_info),
        }})

    _write_log("common_search_done", {
        "run_id": run_id,
        "quality_score": quality_score,
        "rounds_used": rounds_used,
        "planning_rounds_used": planning_rounds_used,
        "total_results": len(all_results),
        "sources_count": len(set(all_sources)),
        "collected_info_length": len(collected_info),
    })
    return {
        "collected_info": collected_info,
        "quality_score": quality_score,
        "rounds_used": rounds_used,
        "planning_rounds_used": planning_rounds_used,
        "total_results": len(all_results),
        "sources": list(set(all_sources)),
        "round_details": round_details,
        "summary": summary_text,
    }


def _evaluate_information_quality(topic, focus_areas, searched_queries, last_missing_topics, all_results):
    eval_prompt = (
        "You are an information quality evaluator. Score whether the collected information can support "
        "a high-quality analytical deliverable. Dimensions: coverage 0-40, depth 0-40, timeliness/data quality 0-20. "
        "Return strict JSON: {\"coverage\":0,\"depth\":0,\"timeliness\":0,\"total_score\":0,"
        "\"missing_topics\":[...],\"improvement_suggestions\":[...]}"
    )
    collected_summary = "\n".join(all_results[-40:])[:INFO_EVAL_MAX_CHARS]
    eval_call = _call_llm_raw_detailed(
        eval_prompt,
        f"Topic: {topic}\nFocus areas: {json.dumps(focus_areas, ensure_ascii=False)}\n"
        f"Searched queries: {json.dumps(list(searched_queries), ensure_ascii=False)}\n"
        f"Previous missing topics: {json.dumps(last_missing_topics, ensure_ascii=False)}\n\n"
        f"Collected information:\n{collected_summary}\n\nEvaluate information quality.",
        temperature=0.3,
        max_tokens=4096,
    )
    data = _extract_json_object(eval_call.get("content", ""))
    return data if isinstance(data, dict) else None, eval_call


def format_search_debug_log(info_result: dict) -> str:
    lines = [
        "# Search Debug Log",
        "",
        f"- Final quality: {info_result.get('quality_score', '-')}",
        f"- Rounds used: {info_result.get('rounds_used', '-')}",
        f"- Total results: {info_result.get('total_results', '-')}",
        f"- Sources: {len(info_result.get('sources', []) or [])}",
        "",
    ]
    for rd in info_result.get("round_details", []) or []:
        web_diag = rd.get("web_diagnostics", {}) or {}
        lines.extend([
            f"## Round {rd.get('round', '-')}",
            "",
            f"- Reasoning preamble: {rd.get('reasoning_preamble', '')}",
            f"- Agent done: {rd.get('agent_done', False)}",
            f"- Agent done reason: {rd.get('agent_done_reason', '')}",
            f"- Agent actions: {json.dumps(rd.get('agent_actions', []), ensure_ascii=False)}",
            f"- Agent planner: {json.dumps(rd.get('agent_planner', {}), ensure_ascii=False)}",
            f"- Quality: {rd.get('quality', '-')}",
            f"- Raw quality: {rd.get('raw_quality', '-')}",
            f"- Queries: {json.dumps(rd.get('queries', []), ensure_ascii=False)}",
            f"- Skipped queries: {json.dumps(rd.get('skipped_queries', []), ensure_ascii=False)}",
            f"- Missing topics: {json.dumps(rd.get('missing_topics', []), ensure_ascii=False)}",
            f"- Query expansion: {json.dumps(rd.get('query_expansion', {}), ensure_ascii=False)}",
            f"- Web diagnostics: {json.dumps(web_diag, ensure_ascii=False)}",
            "",
        ])
        for qd in rd.get("query_results", []) or []:
            lines.extend([
                f"### Query: {qd.get('query', '')}",
                "",
                f"- KB kept: {qd.get('kb_count', 0)}",
                f"- Web raw: {qd.get('web_raw_count', 0)}",
                f"- Web filtered: {qd.get('web_filtered_count', qd.get('web_kept_count', 0))}",
                f"- Web kept: {qd.get('web_kept_count', 0)}",
                f"- Web duplicates: {qd.get('web_duplicate_count', 0)}",
                f"- Web no URL: {qd.get('web_no_url_count', 0)}",
                f"- Web fetch failed: {qd.get('web_fetch_failed_count', 0)}",
                f"- Errors: {json.dumps(qd.get('errors', []), ensure_ascii=False)}",
                "",
            ])
            for item in (qd.get("web_items", []) or [])[:8]:
                lines.append(
                    f"- [{item.get('title', 'Untitled')}]({item.get('url', '')}) "
                    f"fetched={item.get('fetched')} chars={item.get('content_length', 0)}"
                )
            if qd.get("kb_items"):
                lines.append("")
                lines.append("KB snippets:")
                for item in (qd.get("kb_items", []) or [])[:5]:
                    snippet = re.sub(r"\s+", " ", str(item.get("snippet", ""))).strip()
                    lines.append(f"- {item.get('path', '')}: {snippet[:180]}")
            lines.append("")
    return "\n".join(lines)
