"""
PPT Pipeline Module - Six-step PPT generation pipeline.

Steps 1-4 (intent analysis, info collection, structure planning, content review)
are handled by this module. Steps 5-6 (rendering, visual review) are delegated
to the chrys rendering pipeline via SSE 'ready_for_render' event.
"""

import json
import os
import re
import queue
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from urllib.parse import urlparse

import requests
from flask import Response, jsonify, request

import common_search_researcher
from image_to_desc import get_thinking_limit

# ---------------------------------------------------------------------------
# Module-level references injected by register_ppt_pipeline_routes()
# ---------------------------------------------------------------------------
_refs = {}

# Lazy import ppt_executor (initialized in register_ppt_pipeline_routes)
ppt_executor = None

LLM_REQ_TIMEOUT_NORMAL_SECONDS = 300   # ≤300s LLM requests → unified to 300s
LLM_REQ_TIMEOUT_LONG_SECONDS = 600     # >300s and ≤600s LLM requests → unified to 600s
LLM_REQ_TIMEOUT_MAX_SECONDS = 1200     # >600s LLM requests → unified to 1200s

PPT_REVIEW_HARD_BLOCK_SCORE = 60
PPT_REVIEW_PASS_SCORE = 80
PPT_REVIEW_OUTLINE_INPUT_CHARS = 18000
PPT_REFINE_OUTLINE_INPUT_CHARS = 22000

PPT_WEB_CONTENT_MAX_CHARS = int(os.environ.get("PPT_WEB_CONTENT_MAX_CHARS", "120000"))

# 抓取黑名单：这些域名的网页存在反爬/付费墙，抓取成功率极低
PPT_WEB_FETCH_BLACKLIST_DOMAINS = frozenset([
    "zhuanlan.zhihu.com",
])
PPT_INFO_EVAL_MAX_CHARS = int(os.environ.get("PPT_INFO_EVAL_MAX_CHARS", "60000"))
PPT_INFO_ORGANIZE_MAX_CHARS = int(os.environ.get("PPT_INFO_ORGANIZE_MAX_CHARS", "500000"))
PPT_STRUCTURE_INPUT_MAX_CHARS = int(os.environ.get("PPT_STRUCTURE_INPUT_MAX_CHARS", "500000"))
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "20000"))

_PPT_TASKS_DIR_NAME = "ppt-tasks"
_PPT_TASKS_MAX_DIRS = 50

# Pipeline state storage (in-memory)
_pipeline_states = {}

# Pipeline cancellation registry - frontend cancel triggers backend stop
_cancelled_pipelines = set()


def _is_pipeline_cancelled(pipeline_id: str) -> bool:
    """Check if a pipeline has been cancelled by the user."""
    return pipeline_id in _cancelled_pipelines


def _cancel_pipeline(pipeline_id: str):
    """Mark a pipeline as cancelled."""
    _cancelled_pipelines.add(pipeline_id)
    _log(f"[PPT:{pipeline_id}] Pipeline cancelled by user")
    _write_log("ppt_pipeline_cancelled", {"pipeline_id": pipeline_id})

PPT_TYPE_ALIASES = {
    "关键指标仪表盘": "kpi_dashboard", "指标仪表盘": "kpi_dashboard",
    "数据看板": "kpi_dashboard", "看板": "kpi_dashboard",
    "对比矩阵": "comparison_matrix", "对比页": "comparison_matrix", "矩阵": "comparison_matrix",
    "流程图": "process_flow", "流程": "process_flow",
    "架构图": "architecture", "架构": "architecture",
    "时间线": "timeline", "路线图": "timeline",
    "风险矩阵": "decision_summary", "风险页": "decision_summary",
    "基准对比": "benchmark_matrix", "评测对比": "benchmark_matrix",
    "内容卡片": "content_cards", "内容页": "content_cards",
}

# ---------------------------------------------------------------------------
# Chart template catalog (loaded once from bundled ppt-master)
# ---------------------------------------------------------------------------

_CHART_CATALOG: str | None = None

def _load_chart_catalog() -> str:
    """Load and format the full chart template index for LLM prompt injection."""
    global _CHART_CATALOG
    if _CHART_CATALOG is not None:
        return _CHART_CATALOG

    # Resolve ppt_master directory (bundled alongside ppt_pipeline.py)
    local_dir = os.path.join(os.path.dirname(__file__), "ppt_master")
    if not os.path.isdir(local_dir):
        local_dir = os.path.join(os.environ.get("APPDATA", ""), "chrys", "skills", "ppt-master")
    index_path = os.path.join(
        os.environ.get("PPT_MASTER_SKILL_DIR", local_dir),
        "templates", "charts", "charts_index.json",
    )
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        _CHART_CATALOG = ""
        return ""

    charts = data.get("charts", {})
    lines = ["## 可用图表模板目录 (共 {} 种)".format(len(charts))]
    lines.append("每页只能选一种图表模板，值填模板名。选择规则: Pick for <内容形状>. Skip if <原因→替代>.\n")
    for key, info in sorted(charts.items()):
        summary = info.get("summary", "") if isinstance(info, dict) else str(info)
        lines.append(f"- **{key}**: {summary}")
    _CHART_CATALOG = "\n".join(lines)
    return _CHART_CATALOG


# ===========================================================================
#  Proxy helpers – delegate to app.py via _refs
# ===========================================================================

def _log(msg):
    fn = _refs.get("_log")
    if fn:
        fn(msg)


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
    return [], {"engine": "none", "raw_count": 0, "filtered_count": 0}


def _fetch_web_content(url, max_chars=PPT_WEB_CONTENT_MAX_CHARS):
    fn = _refs.get("_fetch_web_content")
    if fn:
        return fn(url, max_chars=max_chars)
    return ""


def _get_active_base_dir():
    fn = _refs.get("_get_current_project")
    if fn:
        project = fn()
        if project and project.get("path"):
            return project["path"]
    raise RuntimeError("No active knowledge base project")


# ===========================================================================
#  PPT Task Directory Management
# ===========================================================================

def _get_ppt_tasks_base_dir() -> str:
    try:
        base = _get_active_base_dir()
    except RuntimeError:
        base = os.path.join(os.path.expanduser("~"), ".one-stop-desktop-tool")
    p = os.path.join(base, _PPT_TASKS_DIR_NAME)
    os.makedirs(p, exist_ok=True)
    return p


def _create_ppt_task_dir(pipeline_id: str, query: str) -> str:
    tasks_base = _get_ppt_tasks_base_dir()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_query = re.sub(r'[\\/:*?"<>|\s]+', '_', query[:20]).strip('_') or 'untitled'
    dir_name = f"{ts}_{pipeline_id}_{safe_query}"
    task_dir = os.path.join(tasks_base, dir_name)
    os.makedirs(task_dir, exist_ok=True)
    _cleanup_ppt_task_dirs(tasks_base)
    return task_dir


def _cleanup_ppt_task_dirs(tasks_base: str):
    try:
        dirs = []
        for name in os.listdir(tasks_base):
            full_path = os.path.join(tasks_base, name)
            if os.path.isdir(full_path):
                dirs.append((full_path, os.path.getmtime(full_path)))
        dirs.sort(key=lambda x: x[1], reverse=True)
        for old_dir, _ in dirs[_PPT_TASKS_MAX_DIRS:]:
            try:
                import shutil
                shutil.rmtree(old_dir, ignore_errors=True)
            except Exception as e:
                _log(f"清理旧PPT任务目录失败: {old_dir}, 错误: {e}")
    except Exception as e:
        _log(f"PPT任务目录清理失败: {e}")


def _save_ppt_step_artifact(task_dir: str, step, step_name: str, data: dict) -> str:
    if not task_dir:
        return ""
    filename = f"step{step}_{step_name}.json"
    filepath = os.path.join(task_dir, filename)
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return filepath
    except Exception as e:
        _log(f"保存PPT步骤输出失败: {filepath}, 错误: {e}")
        return ""


def _save_ppt_pipeline_log(task_dir: str, events: list, summary: dict = None) -> str:
    if not task_dir:
        return ""
    filepath = os.path.join(task_dir, "pipeline_log.json")
    log_data = {
        "timestamp": datetime.now().isoformat(),
        "events": events,
        "summary": summary or {},
    }
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(log_data, f, ensure_ascii=False, indent=2)
        return filepath
    except Exception as e:
        _log(f"保存PPT流水线日志失败: {filepath}, 错误: {e}")
        return ""


def _save_ppt_text_artifact(task_dir: str, filename: str, content: str) -> str:
    if not task_dir:
        return ""
    filepath = os.path.join(task_dir, filename)
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return filepath
    except Exception as e:
        _log(f"保存PPT文本输出失败: {filepath}, 错误: {e}")
        return ""


def _read_ppt_json_artifact(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _read_ppt_text_artifact(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def _find_ppt_task_dir(task_dir: str = "", pipeline_id: str = "") -> str:
    if task_dir and os.path.isdir(task_dir):
        return os.path.abspath(task_dir)

    tasks_base = _get_ppt_tasks_base_dir()
    candidates = []
    for name in os.listdir(tasks_base):
        full_path = os.path.join(tasks_base, name)
        if not os.path.isdir(full_path):
            continue
        if pipeline_id and pipeline_id not in name:
            continue
        candidates.append((full_path, os.path.getmtime(full_path)))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[1], reverse=True)
    return os.path.abspath(candidates[0][0])


def _latest_ppt_artifact(task_dir: str, patterns: list) -> str:
    matches = []
    base = Path(task_dir)
    for pattern in patterns:
        matches.extend([p for p in base.glob(pattern) if p.is_file()])
    if not matches:
        return ""
    matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return str(matches[0])


# ===========================================================================
#  Utility Helpers
# ===========================================================================

def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_json_loads(value, fallback=None):
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _has_ppt_page_title(block: str) -> bool:
    return bool(_extract_ppt_page_title(block, 0, fallback=""))


def _has_ppt_page_body(block: str) -> bool:
    text = block or ""
    return bool(re.search(
        r'(?im)^\s*(?:\[TYPE\]|\[summary\]|\[KPI\]|\[CHART\]|###\s+|- |\|)',
        text,
    ))


def _is_ppt_title_only_block(block: str) -> bool:
    lines = [line.strip() for line in (block or "").splitlines() if line.strip()]
    if not lines or not _has_ppt_page_title(block):
        return False
    body_lines = [
        line for line in lines
        if not re.match(r'^\s*#{1,3}\s+', line)
        and not re.match(r'^\s*(?:第\s*)?\d+\s*(?:页|頁|p|P|slide|Slide|SLIDE|张)?\s*[:：.、\-\s]+.+$', line)
        and not re.match(r'^\s*(?:Slide|Page)\s*\d+\s*[:：.、\-\s]+.+$', line, flags=re.IGNORECASE)
        and not re.match(r'^\s*(?:标题|页面标题|页标题|Slide Title|Page Title)\s*[:：]\s*.+$', line, flags=re.IGNORECASE)
    ]
    return not body_lines or not _has_ppt_page_body("\n".join(body_lines))


def _normalize_ppt_outline_blocks(outline: str) -> list:
    raw_blocks = [block.strip() for block in re.split(r'\n\s*---\s*\n', outline or "") if block.strip()]
    if not raw_blocks:
        return []

    blocks = []
    idx = 0
    while idx < len(raw_blocks):
        current = raw_blocks[idx]
        next_block = raw_blocks[idx + 1] if idx + 1 < len(raw_blocks) else ""
        if (
            next_block
            and _is_ppt_title_only_block(current)
            and not _has_ppt_page_title(next_block)
            and _has_ppt_page_body(next_block)
        ):
            blocks.append(f"{current}\n\n{next_block}".strip())
            idx += 2
            continue
        blocks.append(current)
        idx += 1
    return blocks


def _clean_ppt_page_title(title: str, index: int = 0) -> str:
    text = re.sub(r'\s+', ' ', str(title or "")).strip()
    text = re.sub(r'^\s*(?:第\s*)?\d+\s*(?:页|頁|p|P|slide|Slide|SLIDE|张)?\s*[:：.、\-\s]+', '', text)
    text = re.sub(r'^\s*(?:Slide|Page)\s*\d+\s*[:：.、\-\s]+', '', text, flags=re.IGNORECASE)
    text = re.sub(r'^\s*(?:标题|页面标题|页标题|Slide Title|Page Title)\s*[:：]\s*', '', text, flags=re.IGNORECASE)
    text = text.strip(" #\t\r\n-:：")
    return text or (f"第 {index + 1} 页" if index >= 0 else "")


def _extract_ppt_page_title(block: str, index: int = 0, fallback: str = None) -> str:
    text = block or ""
    patterns = [
        r'(?im)^\s*#{1,3}\s+(.+?)\s*$',
        r'(?im)^\s*(?:第\s*)?\d+\s*(?:页|頁|p|P|slide|Slide|SLIDE|张)?\s*[:：.、\-\s]+(.+?)\s*$',
        r'(?im)^\s*(?:Slide|Page)\s*\d+\s*[:：.、\-\s]+(.+?)\s*$',
        r'(?im)^\s*(?:标题|页面标题|页标题|Slide Title|Page Title)\s*[:：]\s*(.+?)\s*$',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            title = _clean_ppt_page_title(match.group(1), index)
            if title:
                return title

    for line in text.splitlines()[:6]:
        line = line.strip()
        if not line:
            continue
        if re.match(r'^\s*(?:\[|[-*]|\||###)', line):
            continue
        if len(line) <= 60:
            return _clean_ppt_page_title(line, index)
    return fallback if fallback is not None else f"第 {index + 1} 页"


def _count_outline_pages(outline: str) -> int:
    blocks = _normalize_ppt_outline_blocks(outline)
    titled_blocks = [block for block in blocks if _has_ppt_page_title(block)]
    return len(titled_blocks) or len(blocks)


def _min_required_slide_count(intent: dict) -> int:
    estimated = max(_safe_int(intent.get("estimated_slides"), 10), 1)
    complexity = str(intent.get("complexity", "medium")).lower()
    if complexity == "complex":
        return max(7, round(estimated * 0.7))
    if complexity == "medium":
        return max(5, round(estimated * 0.6))
    return max(3, round(estimated * 0.5))


def _build_ppt_block_event(step, message, data=None):
    return {"step": step, "status": "blocked", "message": message, "data": data or {}}


def _build_ppt_requirement_clarity(query: str, intent: dict) -> dict:
    text = f"{query or ''} {json.dumps(intent or {}, ensure_ascii=False)}".lower()
    checks = {
        "audience": bool(intent.get("audience") and intent.get("audience") != "通用") or bool(re.search(r"受众|面向|汇报给|audience|cto|ceo|管理层|研发|工程师|客户|投资人", text)),
        "scenario": bool(intent.get("scenario") and intent.get("scenario") != "汇报展示") or bool(re.search(r"场景|用途|会议|发布会|内部|汇报|分享|培训|路演|答辩|presentation", text)),
        "slide_count": bool(re.search(r"\d+\s*(页|p|slide|slides|张)", text)),
        "focus": bool(intent.get("focus_areas")) or bool(re.search(r"重点|聚焦|包含|覆盖|benchmark|评测|架构|风险|部署|路线|结论", text)),
    }
    labels = {"audience": "受众", "scenario": "使用场景", "slide_count": "页数", "focus": "重点内容"}
    missing = [labels[key] for key, ok in checks.items() if not ok]
    options = []
    if missing:
        options = [
            {"label": "正式技术报告", "value": "受众：技术决策者、研发团队；场景：内部技术分享；页数：10页；重点：架构、评测、部署、风险与结论"},
            {"label": "发布会演示", "value": "受众：客户和管理层；场景：技术发布会；页数：8页；重点：亮点、能力、对比、价值和路线图"},
            {"label": "学术交流", "value": "受众：研究人员、工程师；场景：学术/技术交流；页数：12页；重点：方法、实验、benchmark、局限和参考来源"},
        ]
    return {
        "is_clear": not missing,
        "missing": missing,
        "options": options,
        "suggestion": "需求不完整时建议先确认受众、场景、页数和重点内容。" if missing else "",
    }


def _summarize_slide_types(slides):
    counts = {}
    for slide in slides or []:
        slide_type = slide.get("slide_type") or "unknown"
        counts[slide_type] = counts.get(slide_type, 0) + 1
    return counts


def _build_structure_warnings(actual_slides, expected_slides, min_required_slides, page_plans):
    warnings = []
    if actual_slides < min_required_slides:
        warnings.append(f"页数不足：最低需要{min_required_slides}页，当前{actual_slides}页")
    elif abs(actual_slides - expected_slides) > 1:
        warnings.append(f"页数偏离：目标{expected_slides}页，当前{actual_slides}页")
    type_counts = {}
    for page in page_plans or []:
        page_type = page.get("type") or "unknown"
        type_counts[page_type] = type_counts.get(page_type, 0) + 1
    if len([k for k in type_counts if k not in ("cover", "unknown")]) < 3 and actual_slides >= 5:
        warnings.append("页面类型偏少，建议混合数据看板、对比矩阵、架构、流程或时间线")
    if any(not page.get("summary") for page in page_plans or []):
        warnings.append("部分页面缺少核心结论 summary")
    return warnings


def _extract_outline_source_markers(block):
    text = block or ""
    markers = re.findall(r"\[(?:SOURCE|VERIFY)\s*(?:[:：][^\]]*)?\]", text, flags=re.IGNORECASE)
    markers.extend(re.findall(r"【(?:联网|知识库)[^】]*】", text))
    return [m.strip() for m in markers if str(m).strip()]


def _extract_ppt_page_plans(outline_full):
    page_blocks = _normalize_ppt_outline_blocks(outline_full)
    page_plans = []
    for idx, block in enumerate(page_blocks):
        block = block.strip()
        if not block:
            continue
        page_title = _extract_ppt_page_title(block, idx)
        type_match = re.search(r'^\[TYPE\]\s*[:：]?\s*(.+)$', block, re.MULTILINE | re.IGNORECASE)
        zh_type_match = re.search(r'^(?:页面类型|页型|版式|布局)\s*[:：]\s*(.+)$', block, re.MULTILINE)
        page_type = ""
        if type_match:
            page_type = _normalize_ppt_slide_type(type_match.group(1)) or type_match.group(1).strip()
        elif zh_type_match:
            page_type = _normalize_ppt_slide_type(zh_type_match.group(1)) or zh_type_match.group(1).strip()
        bullets = [b.strip() for b in re.findall(r'^-\s+(.+)', block, re.MULTILINE)[:5]]
        kpis = re.findall(r'^\[KPI\]\s*[:：]?\s*(.+)', block, re.MULTILINE | re.IGNORECASE)
        kpis.extend(re.findall(r'^(?:关键指标|KPI|指标)\s*[:：]\s*(.+)', block, re.MULTILINE | re.IGNORECASE))
        sections = re.findall(r'^###\s+(.+)', block, re.MULTILINE)
        sources = _extract_outline_source_markers(block)
        sources.extend(re.findall(r'^(?:来源|证据|参考来源)\s*[:：]\s*(.+)', block, re.MULTILINE))
        visual_data_count = len(_extract_slide_visual_data({
            "chart_type": "", "chart_unit": "",
            "sections": [{"title": "outline", "items": block.splitlines()}],
            "bullets": [],
        }))
        summary_match = re.search(r'\[summary\]\s*(.+)', block)
        page_summary = summary_match.group(1).strip() if summary_match else ""
        page_plans.append({
            "title": page_title[:40], "type": page_type, "bullets": bullets,
            "kpis": [k.strip() for k in kpis[:4]], "sections": [s.strip() for s in sections[:4]],
            "source_count": len(sources), "visual_data_count": visual_data_count,
            "summary": page_summary[:80] if page_summary else "",
        })
    return page_plans


def _normalize_ppt_slide_type(value):
    raw = re.sub(r'\s+', ' ', str(value or "")).strip()
    if not raw:
        return ""
    raw = raw.strip("：:，,。;；")
    lower = raw.lower()
    aliases = {
        "kpi": "kpi_dashboard", "dashboard": "kpi_dashboard",
        "compare": "comparison_matrix", "comparison": "comparison_matrix", "matrix": "comparison_matrix",
        "benchmark": "benchmark_matrix", "benchmark_comparison": "benchmark_matrix",
        "risk": "decision_summary", "risk_matrix": "decision_summary",
        "roadmap": "timeline", "flow": "process_flow", "process": "process_flow",
        "arch": "architecture", "cards": "content_cards",
    }
    allowed = {
        "kpi_dashboard", "comparison_matrix", "timeline", "process_flow",
        "architecture", "benchmark_matrix", "decision_summary",
        "capability_radar", "content_cards", "cover",
    }
    normalized = aliases.get(lower, lower)
    if normalized in allowed:
        return normalized
    return PPT_TYPE_ALIASES.get(raw, "")


def _parse_ppt_meta_line(stripped):
    text = (stripped or "").strip()
    if not text:
        return None
    type_match = re.match(r'^\[(?:TYPE|type|PAGE|page|LAYOUT|layout)\]\s*[:：]?\s*(.+)$', text)
    if type_match:
        return ("type", _normalize_ppt_slide_type(type_match.group(1)) or type_match.group(1).strip().lower())
    zh_type_match = re.match(r'^(?:页面类型|页型|版式|布局)\s*[:：]\s*(.+)$', text)
    if zh_type_match:
        return ("type", _normalize_ppt_slide_type(zh_type_match.group(1)))
    kpi_match = re.match(r'^\[(?:KPI|kpi)\]\s*[:：]?\s*(.+)$', text)
    if kpi_match:
        return ("kpi", kpi_match.group(1).strip())
    chart_match = re.match(r'^\[(?:CHART|chart)\]\s*[:：]?\s*(.+)$', text)
    if chart_match:
        return ("chart", chart_match.group(1).strip())
    unit_match = re.match(r'^\[(?:UNIT|unit)\]\s*[:：]?\s*(.+)$', text)
    if unit_match:
        return ("unit", unit_match.group(1).strip())
    zh_kpi_match = re.match(r'^(?:关键指标|KPI|指标)\s*[:：]\s*(.+)$', text, re.IGNORECASE)
    if zh_kpi_match:
        return ("kpi", zh_kpi_match.group(1).strip())
    summary_match = re.match(r'^\[(?:总结|summary)\]\s*[:：]?\s*(.+)$', text, re.IGNORECASE)
    if summary_match:
        return ("summary", summary_match.group(1).strip())
    zh_summary_match = re.match(r'^(?:总结|核心结论|关键结论)\s*[:：]\s*(.+)$', text)
    if zh_summary_match:
        return ("summary", zh_summary_match.group(1).strip())
    evidence_match = re.match(r'^\[(SOURCE|source|来源|ASSUMPTION|assumption|假设|推断|VERIFY|verify|待验证)\]\s*[:：]?\s*(.+)$', text)
    if evidence_match:
        label = evidence_match.group(1).lower()
        if label in ("source", "来源"):
            return ("source", evidence_match.group(2).strip())
        if label in ("assumption", "假设", "推断"):
            return ("assumption", evidence_match.group(2).strip())
        return ("verify", evidence_match.group(2).strip())
    zh_source_match = re.match(r'^(?:来源|证据|参考来源)\s*[:：]\s*(.+)$', text)
    if zh_source_match:
        return ("source", zh_source_match.group(1).strip())
    zh_verify_match = re.match(r'^(?:待验证|需验证|验证项)\s*[:：]\s*(.+)$', text)
    if zh_verify_match:
        return ("verify", zh_verify_match.group(1).strip())
    zh_assumption_match = re.match(r'^(?:假设|推断)\s*[:：]\s*(.+)$', text)
    if zh_assumption_match:
        return ("assumption", zh_assumption_match.group(1).strip())
    return None


def _apply_ppt_meta_line(slide_info, meta):
    if not slide_info or not meta:
        return False
    kind, value = meta
    value = str(value or "").strip()
    if not value:
        return True
    if kind == "type":
        slide_info["slide_type"] = value
    elif kind == "kpi":
        slide_info.setdefault("kpis", []).append(value)
    elif kind == "summary":
        slide_info["summary"] = value
    elif kind == "chart":
        slide_info["chart_type"] = value
    elif kind == "unit":
        slide_info["chart_unit"] = value
    elif kind == "source":
        slide_info.setdefault("sources", []).append(value)
    elif kind == "assumption":
        slide_info.setdefault("assumptions", []).append(value)
    elif kind == "verify":
        slide_info.setdefault("verifications", []).append(value)
    else:
        return False
    return True


def _clean_ppt_report_title(title, content):
    raw_title = (title or "").strip()
    raw_title = re.sub(r'\.pptx$', '', raw_title, flags=re.IGNORECASE).strip()
    headings = re.findall(r'^\s*#\s+(.+?)\s*$', content or "", flags=re.MULTILINE)
    first_heading = headings[0].strip() if headings else ""
    command_like = bool(re.search(r'(帮我|请|生成|制作|做一份|创建|PPT|pptx)', raw_title))
    if command_like:
        cleaned = raw_title
        cleaned = re.sub(r'^(请)?\s*(帮我|帮忙|替我)?\s*(生成|制作|做|创建)?\s*(一份|一个)?\s*', '', cleaned)
        cleaned = re.sub(r'\s*(的)?\s*(PPT|ppt|幻灯片)\s*$', '', cleaned)
        cleaned = re.sub(r'\s*的\s*报告\s*$', ' 报告', cleaned)
        cleaned = cleaned.strip(' ：:，,。')
        cleaned = re.sub(r'^(生成|制作|创建)\s*', '', cleaned)
        cleaned = re.sub(r'\s*(生成|制作)\s*$', '', cleaned)
        cleaned = cleaned.strip(' ：:，,。')
    else:
        cleaned = raw_title
    if (not cleaned or len(cleaned) < 4) and first_heading:
        cleaned = first_heading
    if first_heading and command_like and len(first_heading) > 4 and not re.search(r'(帮我|生成|制作)', first_heading):
        cleaned = first_heading
    cleaned = re.sub(r'\bdeepseek\b', 'DeepSeek', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\bv(\d+)\b', r'V\1', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned or "PPT 报告"


def _outline_page_titles(outline: str) -> list:
    return [
        m.group(1).strip()
        for m in re.finditer(r"(?m)^#\s+(.+?)\s*$", outline or "")
        if m.group(1).strip()
    ]


def _outline_regressed_too_much(old_outline: str, new_outline: str) -> tuple:
    old_titles = _outline_page_titles(old_outline)
    new_titles = _outline_page_titles(new_outline)
    if not new_titles:
        return True, "新大纲没有可识别的页面标题"
    if old_titles and len(new_titles) < max(1, len(old_titles) - 1):
        return True, f"新大纲页数从{len(old_titles)}降到{len(new_titles)}，疑似丢失章节"
    old_keywords = [
        title for title in old_titles
        if re.search(r"(后训练|推理|部署|成本|风险|结论|Benchmark|评测|架构|来源)", title, flags=re.IGNORECASE)
    ]
    missing = []
    new_text = "\n".join(new_titles)
    for title in old_keywords:
        core = re.split(r"[:：]", title, maxsplit=1)[0].strip()
        if core and core not in new_text:
            missing.append(core)
    if len(missing) >= 2:
        return True, f"新大纲疑似丢失关键章节：{', '.join(missing[:4])}"
    return False, ""


def _review_grade(score):
    if score >= 85:
        return "正式通过"
    if score >= PPT_REVIEW_PASS_SCORE:
        return "可生成"
    if score >= PPT_REVIEW_HARD_BLOCK_SCORE:
        return "需改进"
    return "严重不通过"


def _extract_model_mentions(text: str) -> set:
    patterns = [
        r"DeepSeek[-\s]?[A-Za-z0-9.]+", r"GPT[-\s]?[A-Za-z0-9.]+",
        r"Claude\s+[A-Za-z0-9. -]+", r"Opus[-\s]?[A-Za-z0-9.]+",
        r"Sonnet[-\s]?[A-Za-z0-9.]+", r"Gemini[-\s]?[A-Za-z0-9.]+",
        r"Llama[-\s]?[A-Za-z0-9.]+", r"Qwen[-\s]?[A-Za-z0-9.]+",
        r"Kimi[-\s]?[A-Za-z0-9.]+", r"Doubao[-\s]?[A-Za-z0-9.]+",
    ]
    found = set()
    for pat in patterns:
        for match in re.findall(pat, text, flags=re.IGNORECASE):
            cleaned = re.sub(r"\s+", " ", match).strip(" ,;:，。：（）()")
            if cleaned:
                found.add(cleaned.lower())
    return found


def _ppt_review_next_action(action: str, score: float, round_num: int, max_rounds: int) -> dict:
    action = action or "pass"
    if score >= 85:
        return {"code": "pass", "label": "通过审核，进入最终大纲保存",
                "detail": "内容质量已达高分门槛，下一步进入渲染准备。"}
    if round_num >= max_rounds:
        return {"code": "stop_or_gate", "label": "已到最大审核轮次，进入门禁判断",
                "detail": "系统将按最终分数判断是否继续渲染或阻断。"}
    if action == "refine_information":
        return {"code": "refine_information", "label": "补齐来源与证据标记",
                "detail": "下一步会根据审核反馈重写大纲，为关键数字、benchmark、日期补充 [SOURCE]/[VERIFY]；如后续仍低于门槛，应回到 Step 2 补充资料。"}
    if action == "refine_structure":
        return {"code": "refine_structure", "label": "调整结构与叙事",
                "detail": "下一步会重写页面结构、页型和要点组织，再进入下一轮审核。"}
    return {"code": action, "label": "按审核建议优化大纲",
            "detail": "下一步会根据问题和建议重写大纲，然后进入下一轮审核。"}


def _apply_ppt_content_guardrails(outline: str, review_data: dict) -> dict:
    review_data = dict(review_data or {})
    issues = list(review_data.get("issues") or [])
    suggestions = list(review_data.get("suggestions") or [])
    score = float(review_data.get("total_score", review_data.get("score", 0)) or 0)
    action = review_data.get("action", "pass") or "pass"
    text = outline or ""
    numeric_lines = [
        line for line in text.splitlines()
        if re.search(r"\d", line)
        and not re.search(r"\[(?:SOURCE|VERIFY)\]", line, flags=re.IGNORECASE)
        and not re.match(r"^\s*(?:#|\[TYPE\]|\[summary\])", line, flags=re.IGNORECASE)
    ]
    source_markers = len(re.findall(r"\[(?:SOURCE|VERIFY)\s*(?:[:：][^\]]*)?\]", text, flags=re.IGNORECASE))
    slide_count = len([b for b in re.split(r"\n---\n", text) if b.strip()])
    if numeric_lines and source_markers < max(3, min(slide_count, 8)):
        issues.append(f"关键数字/日期/benchmark 来源标记不足：{len(numeric_lines)}行数字缺少[SOURCE]/[VERIFY]，总来源标记仅{source_markers}个")
        suggestions.append("为发布日期、参数量、Benchmark、API定价、部署效率等精确数字补充[SOURCE]或[VERIFY]")
        score = min(score, 82)
        action = "refine_information"
    if re.search(r"(TOP\s*5|Top5|业界TOP5|业界\s*TOP\s*5)", text, flags=re.IGNORECASE):
        model_mentions = _extract_model_mentions(text)
        if len(model_mentions) < 6:
            issues.append(f"TOP5对比不完整：只识别到{len(model_mentions)}个模型/系列，缺少明确的5个竞品清单和版本")
            suggestions.append("增加一页对比口径说明，列出与5个竞品的版本、模式、指标来源")
            score = min(score, 80)
            action = "refine_structure"
    leaked_markers = re.findall(r"(?:页面类型|关键指标|总结|来源)\s*[:：]", text)
    if leaked_markers:
        issues.append("大纲中混入中文元信息标签，可能渲染为可见正文")
        suggestions.append("统一改为内部DSL：[TYPE]、[KPI]、[summary]、[SOURCE]/[VERIFY]")
        score = min(score, 84)
        action = "refine_structure"
    placeholder_terms = [
        "方案A", "方案B", "优势明确", "落地成本可控", "扩展能力强", "依赖治理体系",
        "Benchmark profile", "Native PowerPoint chart", "Reading notes", "Metric profile",
        "Capability radar", "System control plane", "Executive takeaway",
    ]
    hits = [term for term in placeholder_terms if term.lower() in text.lower()]
    if hits:
        issues.append(f"存在模板占位词或渲染标签：{', '.join(hits[:5])}")
        suggestions.append("删除占位词，替换为与当前主题相关的真实标题和说明")
        score = min(score, 70)
        action = "refine_structure"
    placeholder_patterns = [r"\bX%", r"\$X\b", r"\bXX\s*(?:并发|concurrent|requests?)", r"\[待补充\]"]
    pattern_hits = [pat for pat in placeholder_patterns if re.search(pat, text, flags=re.IGNORECASE)]
    if pattern_hits:
        issues.append("大纲中存在未替换的数值占位符（如 X%、$X、XX 并发请求或待补充）")
        suggestions.append("将占位符替换为带 [SOURCE] 的具体数值；无法确认时改成带 [VERIFY] 的完整待验证表述")
        score = min(score, 68)
        action = "refine_information"
    if re.search(r"\.\.\.|…", text):
        issues.append("大纲中存在省略号截断文本，最终PPT可能不可读")
        suggestions.append("补全被截断文本，或改写为更短但完整的句子")
        score = min(score, 78)
        action = "refine_structure"
    review_data["total_score"] = round(score, 1)
    review_data["issues"] = issues
    review_data["suggestions"] = suggestions
    review_data["action"] = action if issues else action
    return review_data


def _flatten_slide_items(slide_info):
    items = []
    for bullet in slide_info.get("bullets", []) or []:
        if isinstance(bullet, str):
            items.append(bullet)
    for section in slide_info.get("sections", []) or []:
        if isinstance(section, dict):
            items.append(section.get("title", ""))
            for item in section.get("items", []) or []:
                if isinstance(item, str):
                    items.append(item)
    for kpi in slide_info.get("kpis", []) or []:
        items.append(str(kpi))
    return items


def _clean_text_list(items):
    cleaned = []
    for item in items or []:
        text = str(item or "").strip()
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned


def _extract_slide_visual_data(slide_info):
    visual_data = []
    chart_type = slide_info.get("chart_type", "")
    chart_unit = slide_info.get("chart_unit", "")
    for section in slide_info.get("sections", []) or []:
        if not isinstance(section, dict):
            continue
        items = section.get("items", []) or []
        if not items:
            continue
        table_rows = []
        for item in items:
            if isinstance(item, str) and "|" in item:
                cells = [c.strip() for c in item.split("|") if c.strip()]
                if len(cells) >= 2:
                    table_rows.append(cells)
        if table_rows and len(table_rows) >= 2:
            columns = table_rows[0]
            rows = []
            for row in table_rows[1:]:
                if all(set(c) <= set("-=: ") for c in row):
                    continue
                row_dict = {}
                for ci, col_name in enumerate(columns):
                    row_dict[col_name] = row[ci] if ci < len(row) else ""
                rows.append(row_dict)
            if rows:
                visual_data.append({
                    "chart_type": chart_type or "table",
                    "chart_unit": chart_unit,
                    "columns": columns,
                    "rows": rows,
                    "source_section": section.get("title", ""),
                })
    return visual_data


# ===========================================================================
#  Search Wrapper Functions
# ===========================================================================

def _format_ppt_search_debug_log(info_result: dict) -> str:
    if not common_search_researcher.is_initialized():
        common_search_researcher.init_search_researcher(_refs)
    return common_search_researcher.format_search_debug_log(info_result)


def _merge_collected_info_append_only(original_info, addition_info, label):
    original_info = original_info or ""
    addition_info = addition_info or ""
    if not addition_info.strip():
        return original_info
    return (
        f"{original_info.rstrip()}\n\n"
        f"---\n\n# {label}\n\n"
        f"{addition_info.strip()}\n"
    )


def _review_needs_targeted_information(review_result):
    history = review_result.get("review_history", []) if review_result else []
    if not history:
        return False
    last = history[-1]
    return last.get("action") == "refine_information" and float(last.get("score") or 0) < 85


def _build_targeted_info_query(query, intent, review_result):
    history = review_result.get("review_history", []) if review_result else []
    last = history[-1] if history else {}
    problems = list(last.get("issues", []) or []) + list(last.get("suggestions", []) or [])
    focus = "；".join(str(p) for p in problems[:6])
    topic = intent.get("topic", query)
    return (
        f"{topic} 补充证据 来源 benchmark 技术报告 "
        f"{' '.join(intent.get('focus_areas', []) or [])}\n"
        f"定向补充目标：{focus}\n"
        "请优先查找能支撑精确数字、发布日期、模型参数、benchmark、训练/部署细节的来源。"
    )


# ===========================================================================
#  LLM Call Functions
# ===========================================================================

def _can_call_llm() -> bool:
    """Check if LLM is available."""
    try:
        load_llm_config = _refs.get("load_llm_config")
        if not load_llm_config:
            return False
        cfg = load_llm_config()
        return bool(cfg.get("llm_url") and cfg.get("llm_model"))
    except Exception:
        return False


def _call_llm_raw(system_prompt: str, user_msg: str, temperature: float = 0.5,
                  max_tokens: int = 4096, timeout_seconds: Optional[int] = None) -> Optional[str]:
    """Generic LLM call returning raw text."""
    try:
        load_llm_config = _refs.get("load_llm_config")
        if not load_llm_config:
            return None
        cfg = load_llm_config()
        llm_url = cfg.get("llm_url", "")
        llm_api_key = cfg.get("llm_api_key", "")
        llm_model = cfg.get("llm_model", "")
        if not llm_url or not llm_model:
            return None

        # 使用 app.py 的 build_chat_completions_url 以正确处理各种 API 路径
        build_fn = _refs.get("build_chat_completions_url")
        if build_fn:
            chat_url = build_fn(llm_url)
        else:
            # fallback: 简单拼接
            chat_url = llm_url.rstrip("/")
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
        _ppt_thinking = get_thinking_limit("ppt_generation", 0)
        if _ppt_thinking > 0:
            body["enable_thinking"] = True
            body["thinking_budget"] = _ppt_thinking

        resp = requests.post(chat_url, json=body, headers=headers,
                             timeout=timeout_seconds or LLM_REQ_TIMEOUT_NORMAL_SECONDS)
        resp.raise_for_status()
        data = resp.json()
        choices = data.get("choices", [{}])
        first_choice = choices[0] if choices else {}
        answer = first_choice.get("message", {}).get("content", "")
        if not answer:
            finish_reason = first_choice.get("finish_reason", "")
            usage = data.get("usage", {})
            _log(
                f"LLM 返回空内容: finish_reason={finish_reason}, "
                f"model={llm_model}, prompt_tokens={usage.get('prompt_tokens','?')}, "
                f"completion_tokens={usage.get('completion_tokens','?')}"
            )
        return answer.strip() if answer else None
    except requests.exceptions.Timeout as e:
        _log(f"LLM 调用超时: {e}")
        return None
    except Exception as e:
        _log(f"LLM 调用失败: {e}")
        return None


def _call_llm_raw_detailed(system_prompt: str, user_msg: str, temperature: float = 0.5,
                           max_tokens: int = 4096, timeout_seconds: Optional[int] = None) -> dict:
    """LLM call with diagnostics for pipeline artifact debugging."""
    meta = {
        "ok": False, "error_type": "", "error_message": "",
        "status_code": None, "model": "",
        "input_chars": len(system_prompt or "") + len(user_msg or ""),
        "system_prompt_chars": len(system_prompt or ""),
        "user_msg_chars": len(user_msg or ""),
        "max_tokens": max_tokens,
        "timeout_seconds": timeout_seconds or LLM_REQ_TIMEOUT_NORMAL_SECONDS,
    }
    try:
        load_llm_config = _refs.get("load_llm_config")
        if not load_llm_config:
            meta["error_type"] = "config_missing"
            meta["error_message"] = "load_llm_config not available"
            return meta
        cfg = load_llm_config()
        llm_url = cfg.get("llm_url", "")
        llm_api_key = cfg.get("llm_api_key", "")
        llm_model = cfg.get("llm_model", "")
        meta["model"] = llm_model
        if not llm_url or not llm_model:
            meta["error_type"] = "config_missing"
            meta["error_message"] = "llm_url or llm_model is empty"
            return meta

        # 使用 app.py 的 build_chat_completions_url 以正确处理各种 API 路径
        build_fn = _refs.get("build_chat_completions_url")
        if build_fn:
            chat_url = build_fn(llm_url)
        else:
            # fallback: 简单拼接
            chat_url = llm_url.rstrip("/")
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
        _ppt_thinking = get_thinking_limit("ppt_generation", 0)
        if _ppt_thinking > 0:
            body["enable_thinking"] = True
            body["thinking_budget"] = _ppt_thinking

        resp = requests.post(chat_url, json=body, headers=headers,
                             timeout=timeout_seconds or LLM_REQ_TIMEOUT_NORMAL_SECONDS)
        meta["status_code"] = resp.status_code
        if not resp.ok:
            meta["error_type"] = "http_error"
            meta["error_message"] = resp.text[:1000]
            _log(f"LLM 详细调用 HTTP 失败: {resp.status_code} {meta['error_message'][:200]}")
            return meta

        data = resp.json()
        choices = data.get("choices", [{}])
        first_choice = choices[0] if choices else {}
        answer = first_choice.get("message", {}).get("content", "")
        finish_reason = first_choice.get("finish_reason", "")
        usage = data.get("usage", {})
        meta["finish_reason"] = finish_reason
        meta["usage"] = usage
        if not answer:
            meta["error_type"] = "empty_response"
            reason_hint = f"finish_reason={finish_reason}" if finish_reason else "no finish_reason"
            prompt_tokens = usage.get("prompt_tokens", "?")
            completion_tokens = usage.get("completion_tokens", "?")
            meta["error_message"] = (
                f"{reason_hint}, prompt_tokens={prompt_tokens}, "
                f"completion_tokens={completion_tokens}\n"
                f"{json.dumps(data, ensure_ascii=False)[:800]}"
            )
            _log(
                f"LLM 返回空内容: {reason_hint}, model={meta.get('model','')}, "
                f"input_chars={meta.get('input_chars',0)}, "
                f"prompt_tokens={prompt_tokens}, completion_tokens={completion_tokens}"
            )
            return meta
        meta["ok"] = True
        meta["content"] = answer.strip()
        meta["output_chars"] = len(meta["content"])
        return meta
    except requests.exceptions.Timeout as e:
        meta["error_type"] = "timeout"
        meta["error_message"] = str(e)
        _log(f"LLM 详细调用超时: {e}")
        return meta
    except Exception as e:
        meta["error_type"] = type(e).__name__
        meta["error_message"] = str(e)
        _log(f"LLM 详细调用失败: {e}")
        return meta


def _parse_review_json(raw: str) -> dict:
    if not raw:
        return {}
    json_match = re.search(r'\{[\s\S]*\}', raw)
    if not json_match:
        return {}
    text = json_match.group()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass

    # Truncated review JSON often loses the closing arrays/object. Recover the
    # score and action so the pipeline can continue with a conservative review.
    recovered = {}
    score_match = re.search(r'"total_score"\s*:\s*([0-9]+(?:\.[0-9]+)?)', text)
    if score_match:
        recovered["total_score"] = float(score_match.group(1))
    action_match = re.search(r'"action"\s*:\s*"([^"]+)"', text)
    if action_match:
        recovered["action"] = action_match.group(1)
    recovered.setdefault("issues", ["内容审核输出被截断，已按保守结果继续。"])
    recovered.setdefault("suggestions", ["建议增大审核输出 token 或简化审核 JSON。"])
    return recovered


# ===========================================================================
#  Core Pipeline Functions (Steps 1-4)
# ===========================================================================


def _analyze_ppt_intent(query: str, template: str, on_progress=None) -> dict:
    """Step 1: Analyze user intent, extract topic, audience, scenario, pages."""
    if on_progress:
        on_progress({"step": 1, "status": "running", "message": "正在分析主题意图..."})

    intent_prompt = (
        "你是PPT策划专家。请分析用户的PPT需求，提取关键信息。\n"
        "请严格输出以下JSON格式，不要输出其他内容：\n"
        '{"topic": "主题", "audience": "目标受众", "scenario": "使用场景", '
        '"estimated_slides": 10, "focus_areas": ["重点1", "重点2"], '
        '"complexity": "simple|medium|complex", "language": "zh"}'
    )

    result = _call_llm_raw(
        intent_prompt,
        f"用户请求：{query}\n模板风格：{template}\n\n请分析以上PPT需求。",
        temperature=0.3, max_tokens=1024,
    )

    default_intent = {
        "topic": query[:80], "audience": "通用", "scenario": "汇报展示",
        "estimated_slides": 10, "focus_areas": [], "complexity": "medium", "language": "zh",
    }

    if not result:
        if on_progress:
            on_progress({"step": 1, "status": "done", "data": {"intent": default_intent}})
        return default_intent

    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            intent = json.loads(json_match.group())
            intent.setdefault("topic", query[:80])
            intent.setdefault("estimated_slides", 10)
            intent.setdefault("focus_areas", [])
            intent.setdefault("complexity", "medium")
            if on_progress:
                on_progress({"step": 1, "status": "done", "data": {"intent": intent}})
            return intent
    except (json.JSONDecodeError, ValueError):
        pass

    if on_progress:
        on_progress({"step": 1, "status": "done", "data": {"intent": default_intent}})
    return default_intent



def _collect_ppt_information(query: str, intent: dict, project_ids: list,
                             use_web_search: bool, max_rounds: int = 5,
                             on_progress=None, pipeline_id: str = "",
                             forced_queries: list = None,
                             platforms: dict = None,
                             search_mode: str = "balanced") -> dict:
    """Step 2: Delegate information collection to the common search researcher."""
    if not common_search_researcher.is_initialized():
        common_search_researcher.init_search_researcher(_refs)
    return common_search_researcher.collect_information(
        query=query,
        intent=intent,
        project_ids=project_ids,
        use_web_search=use_web_search,
        max_rounds=max_rounds,
        on_progress=on_progress,
        run_id=pipeline_id,
        forced_queries=forced_queries,
        platforms=platforms,
        mode=search_mode,
        cancel_check=lambda: _is_pipeline_cancelled(pipeline_id),
    )


def _distill_collected_info(query: str, intent: dict, collected_info: str,
                            on_progress=None) -> dict:
    """Step 2.5: Deduplicate and organize collected information."""
    if on_progress:
        on_progress({"step": 2.5, "status": "running",
                     "message": "正在整理收集的信息并删除重复内容..."})

    topic = intent.get("topic", query)
    distill_prompt = (
        "你是研究资料整理专家。请对以下原始信息做去重、归类和轻量整理，目标是服务后续PPT结构规划。\n\n"
        "重要原则：当前模型支持大上下文，不要为了压缩而删除有用信息；除明显重复、广告噪音、"
        "导航噪音外，尽量保留原文中的技术细节、数据、日期、版本、假设、限制和不同来源的差异。\n\n"
        "要求：\n"
        "1. 合并重复信息，但保留不同来源对同一主题的差异说法\n"
        "2. 按来源分类标注：【知识库】或【联网】\n"
        "3. 删除明显重复段落、网页导航、营销口号、无关评论\n"
        "4. 保留具体数字、技术细节、对比数据\n"
        "5. 不做强压缩；输出长度可接近原始信息，只需结构化整理\n"
        "6. 如果信息不足，标注缺失的关键话题\n"
        "7. 如果存在 benchmark、成本、性能保持率、模型对比等可视化数据，必须整理为 Markdown 表格，放入\"可视化数据包\"；每个单元格只放一个数值，单位写在表题或备注中\n\n"
        "输出格式：\n"
        "# 信息整理与去重报告\n\n"
        "## 核心事实\n- 【来源类型】事实内容\n...\n\n"
        "## 关键数据\n- 【来源类型】数据内容\n...\n\n"
        "## 可视化数据包\n"
        "### 图表：标题（type: grouped_bar | benchmark_table | kpi_bar | timeline | architecture）\n"
        "| 指标 | 对象A | 对象B | 对象C |\n"
        "|---|---:|---:|---:|\n"
        "| 指标名 | 数值 | 数值 | 数值 |\n"
        "- 单位：%\n"
        "- 来源/状态：[SOURCE] 或 [VERIFY]\n\n"
        "## 技术细节\n- 【来源类型】技术细节\n...\n\n"
        "## 观点、争议与来源差异\n- 【来源类型】观点内容\n...\n\n"
        "## 缺失话题\n- 缺失内容\n...\n"
    )

    raw_for_model = collected_info[:PPT_INFO_ORGANIZE_MAX_CHARS]
    user_msg = (
        f"PPT主题：{topic}\n目标受众：{intent.get('audience', '通用')}\n\n"
        f"原始收集信息（共 {len(collected_info)} 字，本次输入 {len(raw_for_model)} 字）：\n"
        f"{raw_for_model}\n\n请整理以上信息，只删除重复和噪音，不要过度压缩。"
    )

    call_meta = _call_llm_raw_detailed(
        distill_prompt, user_msg, temperature=0.3,
        max_tokens=LLM_MAX_TOKENS, timeout_seconds=LLM_REQ_TIMEOUT_MAX_SECONDS,
    )
    result = call_meta.get("content") if call_meta.get("ok") else None
    diagnostics = {k: v for k, v in call_meta.items() if k != "content"}

    # Retry with shorter input if first attempt failed and input was large
    if not result and len(raw_for_model) > 150000:
        first_err_type = diagnostics.get("error_type", "")
        first_err_msg = diagnostics.get("error_message", "")[:200]
        _log(f"Step 2.5 首次失败({first_err_type})，输入{len(raw_for_model)}字，用120K字重试")
        if on_progress:
            on_progress({"step": 2.5, "status": "running",
                         "message": f"整理失败({first_err_type})，缩减输入重试中..."})
        retry_input = collected_info[:120000]
        retry_msg = (
            f"PPT主题：{topic}\n目标受众：{intent.get('audience', '通用')}\n\n"
            f"原始收集信息（共 {len(collected_info)} 字，本次输入 {len(retry_input)} 字，已缩减）：\n"
            f"{retry_input}\n\n请整理以上信息，只删除重复和噪音，不要过度压缩。"
        )
        call_meta = _call_llm_raw_detailed(
            distill_prompt, retry_msg, temperature=0.3,
            max_tokens=LLM_MAX_TOKENS, timeout_seconds=LLM_REQ_TIMEOUT_MAX_SECONDS,
        )
        result = call_meta.get("content") if call_meta.get("ok") else None
        diagnostics = {k: v for k, v in call_meta.items() if k != "content"}
        diagnostics["retried"] = True
        diagnostics["first_attempt_error"] = first_err_msg

    if not result:
        fallback = collected_info[:PPT_INFO_ORGANIZE_MAX_CHARS]
        err_type = diagnostics.get("error_type", "unknown")
        err_msg = diagnostics.get("error_message", "")
        _log(f"Step 2.5 信息整理失败: error_type={err_type}, "
             f"collected_info_len={len(collected_info)}, error_message={err_msg[:300]}")
        friendly_msg = f"LLM整理失败（{err_type}），使用原始信息"
        if err_type == "timeout":
            friendly_msg = f"LLM整理超时（{diagnostics.get('timeout_seconds', '?')}s），使用原始信息"
        elif err_type == "config_missing":
            friendly_msg = "LLM配置缺失，使用原始信息"
        elif err_type == "empty_response":
            friendly_msg = "LLM返回空内容，使用原始信息"
        if on_progress:
            on_progress({"step": 2.5, "status": "done", "data": {
                "distilled": False, "length": len(fallback),
                "message": friendly_msg, "error_type": err_type,
                "error_message": err_msg[:500], "diagnostics": diagnostics,
            }})
        return {"distilled_info": fallback, "distilled": False,
                "length": len(fallback), "diagnostics": diagnostics}

    if on_progress:
        on_progress({"step": 2.5, "status": "done", "data": {
            "distilled": True, "length": len(result),
            "message": f"整理完成，{len(result)} 字",
            "diagnostics": {k: v for k, v in call_meta.items() if k != "content"},
        }})

    return {"distilled_info": result, "distilled": True,
            "length": len(result),
            "diagnostics": {k: v for k, v in call_meta.items() if k != "content"}}


def _plan_ppt_structure(query: str, intent: dict, collected_info: str,
                        template: str, target_slides: int = 0,
                        on_progress=None, planning_feedback: str = "") -> dict:
    """Step 3: Plan PPT structure based on collected info and intent."""
    if on_progress:
        on_progress({"step": 3, "status": "running", "message": "正在规划PPT结构..."})

    if not target_slides:
        target_slides = intent.get("estimated_slides", 10)
    min_required_slides = _min_required_slide_count(intent)

    # Inject mode context into structure planning
    mode_name = intent.get("mode", "briefing")
    mode_guidance = {
        "pyramid": "沟通模式：金字塔结论先行。先给出结论页，然后按MECE展开论证。每页标题是断言而非标签。",
        "narrative": "沟通模式：故事叙述。按情境→冲突→解决的弧线组织页面。封面设悬念，中间展开冲突，结尾揭晓答案。",
        "briefing": "沟通模式：中性简报。每页独立成章，信息完整。标题中性可扫描，不追求论证弧线。",
    }.get(mode_name, "沟通模式：结论先行，逐层论证。")

    # Load full chart catalog for LLM to select from
    chart_catalog = _load_chart_catalog()
    chart_catalog_section = (
        f"\n{chart_catalog}\n"
        if chart_catalog else
        "\n[CHART]: 可选，grouped_bar | benchmark_table | slope | kpi_bar（模板目录加载失败，使用基础列表）\n"
    )

    structure_prompt = (
        "你是PPT结构规划师。请基于用户主题、意图分析和已整理资料，输出一个可直接进入PPT生成阶段的结构化大纲。\n"
        f"{mode_guidance}\n"
        f"目标页数：{target_slides}页，允许误差±1页；复杂技术报告不得少于{min_required_slides}页。\n\n"
        "优先级：\n"
        "1. 页数和页面分隔格式必须正确\n"
        "2. 每页必须包含标题、[TYPE]、[RHYTHM]、[LAYOUT]、要点、[summary]\n"
        "3. 涉及数字、日期、版本、benchmark、价格、比例时必须标注来源或验证标记\n"
        "4. 页面类型、节奏和布局都应服务内容，不要为了凑类型而误标\n\n"
        "输出格式要求：\n"
        "- 只输出PPT大纲，不要输出解释、前言、设计思路或总结说明\n"
        "- 包含标题页、目录页、主体内容页、总结页\n"
        "- 每页一个页面块，页面块之间只能用单独一行 --- 分隔；禁止把 --- 放在标题和正文之间\n"
        "- 每页格式如下：\n"
        "# 第N页：页面标题\n"
        "[TYPE]: 页面类型\n"
        "[RHYTHM]: 页面节奏\n"
        "[LAYOUT]: 布局模式\n"
        "[CHART]: 图表模板名（从下方目录中任选一种，纯文本页可不填）\n"
        "[UNIT]: 可选，% | score | 元/百万token | ms | tokens 等\n"
        "- 要点1\n"
        "- 要点2\n"
        "- 要点3\n"
        "[summary] 本页核心结论\n\n"
        "页面类型只能从以下选项中选择，并按内容选择：\n"
        "- kpi_dashboard：用于开篇总览、关键指标、核心结论前置\n"
        "- comparison_matrix：用于模型、方案、版本、厂商、能力维度对比；必须有真实对比对象或维度标题\n"
        "- timeline：用于发展历程、路线图、版本演进、里程碑\n"
        "- process_flow：用于方法步骤、实施路径、工作流、决策流程\n"
        "- architecture：用于系统架构、技术分层、模块关系、数据流\n"
        "- content_cards：用于观点归纳、风险建议、总结、行动项\n\n"
        "页面节奏 [RHYTHM] 选择规则：\n"
        "- anchor：封面、目录、章节页、结尾页，适合居中强调或单一强结论\n"
        "- dense：信息密集页，适合卡片、多列、表格、benchmark、架构拆解\n"
        "- breathing：低密度页，适合大图、引言、过渡、单一概念解释；至少20%的页面应为 breathing\n"
        "- 封面和结尾必须是 anchor；数据图表页通常是 dense\n\n"
        "布局 [LAYOUT] 选择规则：\n"
        "- full_bleed：封面、结尾、强视觉页\n"
        "- split_left_right：观点+证据、问题+方案、文字+图示\n"
        "- three_column_cards：三类能力、三项建议、三组风险\n"
        "- top_bottom：上结论下证据、上图下说明\n"
        "- center_radiating：中心概念向外展开\n"
        "- z_pattern：叙事型页面，按视觉动线推进\n"
        "- negative_space：低密度过渡页或关键金句页\n"
        "- kpi_grid：多指标总览\n"
        "- comparison_table：多对象对比或benchmark\n"
        "- hero_quote：引言、判断、结论强化\n\n"
        "内容质量要求：\n"
        "- 叙事应自然完整：开篇给结论或背景，主体展开证据和分析，后段给路径/风险，结尾收束行动建议\n"
        "- 每页3-5个要点，每个要点不超过60字\n"
        "- comparison_matrix 页面优先保留 Markdown 表格或逐行指标数据\n"
        "- 数据图表页必须声明 [CHART] 和 [UNIT]，表格行必须持续保留在大纲中，不能只写总结性 bullet\n"
        "- 精确数字、benchmark、日期、版本、成本比例后写 [SOURCE]；无法确认写 [VERIFY] 或不要写\n"
        "- [TYPE]、[RHYTHM]、[LAYOUT]、[CHART]、[UNIT]、[summary] 只用于解析，不得作为可见正文要点\n"
        "- 禁止使用模板占位词作为正文：方案A/方案B、优势明确、落地成本可控、扩展能力强、依赖治理体系、Content、Comparison、Process Flow、Architecture、Performance Trend\n\n"
        "正确格式示例：\n"
        "# 第1页：核心结论总览\n"
        "[TYPE]: kpi_dashboard\n"
        "[RHYTHM]: anchor\n"
        "[LAYOUT]: full_bleed\n"
        "[CHART]: kpi_bar\n"
        "[UNIT]: score\n"
        "- 关键指标A达到xx [SOURCE]\n"
        "- 关键能力B相较上一代提升xx [SOURCE]\n"
        "- 未确认的指标保留验证标记 [VERIFY]\n"
        "[summary] 本页用少量关键指标建立整体判断\n\n"
        "---\n\n"
        "# 第2页：关键能力对比\n"
        "[TYPE]: comparison_matrix\n"
        "[RHYTHM]: dense\n"
        "[LAYOUT]: comparison_table\n"
        "[CHART]: benchmark_table\n"
        "[UNIT]: %\n"
        "| 指标 | 对象A | 对象B | 对象C |\n"
        "|---|---:|---:|---:|\n"
        "| 指标1 | xx [SOURCE] | xx [SOURCE] | xx [VERIFY] |\n"
        "- 对比结论必须来自表格或已整理信息\n"
        "[summary] 本页说明不同对象在关键指标上的差异\n"
    )
    if template in ("huawei_dense", "huawei_keynote", "huawei_standard"):
        structure_prompt += (
            "\n华为风格附加要求：每页用 # 标题 + [TYPE] + [RHYTHM] + [LAYOUT] + [CHART]/[UNIT] + "
            "[KPI] + ### 模块 + - 要点 + [summary] 结构；数据页允许在 ### 模块后输出 Markdown 表格\n"
        )
    structure_prompt += f"\n{chart_catalog_section}\n目标页数：{target_slides}页\n"
    if planning_feedback:
        structure_prompt += f"\n上一次规划反馈：{planning_feedback}\n"

    call_meta = _call_llm_raw_detailed(
        structure_prompt,
        f"主题：{intent.get('topic', query)}\n"
        f"目标受众：{intent.get('audience', '通用')}\n"
        f"场景：{intent.get('scenario', '汇报展示')}\n"
        f"重点方向：{json.dumps(intent.get('focus_areas', []), ensure_ascii=False)}\n\n"
        f"已整理信息（共 {len(collected_info)} 字，"
        f"本次输入 {min(len(collected_info), PPT_STRUCTURE_INPUT_MAX_CHARS)} 字）：\n"
        f"{collected_info[:PPT_STRUCTURE_INPUT_MAX_CHARS]}\n\n请规划PPT大纲结构。",
        temperature=0.5, max_tokens=LLM_MAX_TOKENS,
    )
    result = call_meta.get("content") if call_meta.get("ok") else None
    diagnostics = {k: v for k, v in call_meta.items() if k != "content"}
    _write_log("ppt_pipeline_structure_llm_call", {
        "ok": bool(call_meta.get("ok")),
        "status_code": diagnostics.get("status_code"),
        "error_type": diagnostics.get("error_type"),
        "error_message": diagnostics.get("error_message", "")[:1000],
        "finish_reason": diagnostics.get("finish_reason"),
        "usage": diagnostics.get("usage", {}),
        "model": diagnostics.get("model", ""),
        "input_chars": diagnostics.get("input_chars"),
        "system_prompt_chars": diagnostics.get("system_prompt_chars"),
        "user_msg_chars": diagnostics.get("user_msg_chars"),
        "max_tokens": diagnostics.get("max_tokens"),
        "timeout_seconds": diagnostics.get("timeout_seconds"),
    }, level=("info" if call_meta.get("ok") else "warning"))

    if not result:
        if on_progress:
            on_progress({"step": 3, "status": "failed",
                         "message": "结构规划大模型调用失败，已终止流程。",
                         "data": {"slide_count": 0, "diagnostics": diagnostics}})
        return {"outline": "", "chapters": [], "slide_count": 0,
                "failed": True, "failure_stage": "structure_llm_call",
                "diagnostics": diagnostics}

    page_count = _count_outline_pages(result)
    if on_progress:
        on_progress({"step": 3, "status": "done",
                     "data": {"outline": result[:500], "slide_count": page_count,
                              "diagnostics": diagnostics}})
    return {"outline": result, "chapters": [], "slide_count": page_count,
            "diagnostics": diagnostics}


def _review_ppt_content(title: str, outline: str, template: str,
                        max_rounds: int = 5, on_progress=None):
    """Step 4: Content quality review loop.

    Returns: {"content": str, "review_history": [...], "final_score": float}
    """
    current_outline = outline
    best_outline = outline
    best_score = 0.0
    best_round = 0
    review_history = []
    final_score = 0.0

    review_system_prompt = (
        "你是PPT内容质量审核专家。请严格按照JSON格式评估以下PPT大纲的质量。\n"
        "重要约定：大纲中的 [TYPE]、[KPI]、[summary]、[SOURCE]、[VERIFY] 是内部渲染DSL，"
        "供解析器生成版式和证据附录使用，不是最终PPT可见正文；不要因为这些DSL标记本身扣分。\n"
        "如果看到中文元信息（页面类型：、关键指标：、总结：、来源：），"
        "应建议改回标准DSL格式：[TYPE]、[KPI]、[summary]、[SOURCE]，而不是把它们当正文保留。\n"
        "如果大纲中包含 Markdown 表格、[CHART]、[UNIT] 或可视化数据包，"
        "请把它们视为结构化图表数据；审核时必须检查它们是否被保留且口径清晰。\n"
        "评估维度（每项0-20分，总分100）：\n"
        "1. 信息准确性：数据、事实是否准确，来源是否可信\n"
        "2. 章节完整性：是否覆盖主题的关键方面，有无遗漏\n"
        "3. 受众匹配度：内容深度和表述是否适合目标受众\n"
        "4. 数据可信度：引用的数据、指标是否有明确来源\n"
        "5. 叙事逻辑：内容组织是否有清晰的逻辑线索\n\n"
        "硬性问题：如果大纲含模板占位词作为正文（方案A/方案B、优势明确、落地成本可控、"
        "扩展能力强、依赖治理体系、Content、Comparison、Process Flow、Architecture、Performance Trend），"
        "或精确数字、benchmark、发布日期没有 [SOURCE]/[VERIFY]，必须扣分并要求重写。\n\n"
        "如果总分 < 85，请给出修改建议，并标注 action 字段：\n"
        "- 'refine_information'：需要补充更多信息（回退到Step2）\n"
        "- 'refine_structure'：需要调整结构和内容（回退到Step3）\n\n"
        "请严格输出以下JSON格式，不要输出其他内容：\n"
        '{"accuracy": 0-20, "completeness": 0-20, "audience_fit": 0-20, '
        '"credibility": 0-20, "narrative": 0-20, "total_score": 0-100, '
        '"issues": ["问题1", "问题2"], "suggestions": ["建议1", "建议2"], '
        '"action": "pass" | "refine_information" | "refine_structure"}'
    )

    refine_system_prompt = (
        "你是PPT内容策划师。请根据审核反馈修改PPT大纲。\n"
        "不要输出解释或说明，只输出修改后的完整大纲内容。"
        "统一使用内部DSL：[TYPE]、[KPI]、[summary]、[SOURCE]、[VERIFY]；不要输出“页面类型：”“关键指标：”“总结：”“来源：”这类中文元信息正文。"
        "必须保留已有 Markdown 表格、[CHART]、[UNIT] 和可视化数据包；如需缩短正文，只压缩解释文字，不得删除或改写表格数值。"
        "禁止保留模板占位词正文；精确数字、benchmark、日期、版本、成本比例必须用 [SOURCE] 或 [VERIFY] 标注。"
        "除非审核反馈明确要求删除页面，否则必须保留原大纲的所有主要章节和页数，不得只重写前半部分或丢失目录中承诺的章节。"
    )
    if template in ("huawei_dense", "huawei_keynote", "huawei_standard"):
        refine_system_prompt += (
            "\n使用华为风格格式：每页用 # 标题 + [TYPE] + [KPI] + ### 模块 + "
            "- 要点 + [summary] 结构，页面之间用 --- 分隔；"
            "数据页允许在 ### 模块后输出 Markdown 表格。"
        )

    for round_num in range(max_rounds):
        if on_progress:
            on_progress({"step": 4, "status": "running",
                         "message": f"内容质量审核中 (轮次 {round_num + 1}/{max_rounds})...",
                         "round": round_num + 1})

        review_outline_input = current_outline[:PPT_REVIEW_OUTLINE_INPUT_CHARS]
        review_call = _call_llm_raw_detailed(
            review_system_prompt,
            f"PPT标题：{title}\n"
            f"页面标题清单：{json.dumps(_outline_page_titles(current_outline), ensure_ascii=False)}\n\n"
            f"大纲内容：\n{review_outline_input}\n\n请评估以上大纲的内容质量。",
            temperature=0.15, max_tokens=LLM_MAX_TOKENS,
        )
        review_result_raw = review_call.get("content", "")

        if not review_result_raw:
            reason = review_call.get("error_type") or "empty_response"
            finish_reason = review_call.get("finish_reason", "")
            usage = review_call.get("usage", {})
            _log(f"内容审核: LLM 审核无可解析内容，reason={reason}, finish_reason={finish_reason}")
            _write_log("ppt_pipeline_content_review_llm_empty", {
                "reason": reason,
                "finish_reason": finish_reason,
                "usage": usage,
                "model": review_call.get("model", ""),
                "error_message": review_call.get("error_message", "")[:500],
                "max_tokens": review_call.get("max_tokens"),
            }, level="warning")
            if on_progress:
                on_progress({"step": 4, "status": "done",
                             "message": "内容审核模型未返回可解析内容，跳过内容审核并继续。",
                             "data": {"final_score": 0, "rounds_used": 0, "skipped": True,
                                      "reason": reason, "finish_reason": finish_reason}})
            return {"content": current_outline, "review_history": [],
                    "final_score": 0.0, "skipped": True,
                    "skip_reason": reason, "finish_reason": finish_reason}

        review_data = _parse_review_json(review_result_raw)
        if not review_data:
            _write_log("ppt_pipeline_content_review_parse_fallback", {
                "finish_reason": review_call.get("finish_reason", ""),
                "usage": review_call.get("usage", {}),
                "model": review_call.get("model", ""),
                "raw_preview": review_result_raw[:800],
            }, level="warning")
            review_data = {
                "total_score": 70,
                "issues": ["内容审核 JSON 解析失败，已使用保守默认分继续。"],
                "suggestions": ["建议检查审核模型输出格式或增加 max_tokens。"],
                "action": "pass",
            }
        elif review_call.get("finish_reason") == "length":
            _write_log("ppt_pipeline_content_review_truncated_recovered", {
                "finish_reason": review_call.get("finish_reason", ""),
                "usage": review_call.get("usage", {}),
                "model": review_call.get("model", ""),
                "score": review_data.get("total_score"),
                "raw_preview": review_result_raw[:800],
            }, level="warning")

        review_data = _apply_ppt_content_guardrails(current_outline, review_data)
        score = review_data.get("total_score", 0)
        issues = review_data.get("issues", [])
        suggestions = review_data.get("suggestions", [])
        action = review_data.get("action", "pass")
        final_score = score
        if score >= best_score:
            best_score = score
            best_round = round_num + 1
            best_outline = current_outline

        round_record = {
            "round": round_num + 1, "score": score,
            "issues": issues, "suggestions": suggestions, "action": action,
        }
        review_history.append(round_record)
        next_action = _ppt_review_next_action(action, score, round_num + 1, max_rounds)

        if on_progress:
            on_progress({"step": 4, "status": "review_result", "data": {
                "score": score, "issues": issues, "suggestions": suggestions,
                "action": action, "round": round_num + 1, "next_action": next_action,
            }})

        if score >= 85 or round_num == max_rounds - 1:
            break

        # Refine based on feedback
        feedback_text = f"审核得分：{score}/100\n"
        if issues:
            feedback_text += "发现的问题：\n" + "\n".join(f"- {i}" for i in issues) + "\n"
        if suggestions:
            feedback_text += "改进建议：\n" + "\n".join(f"- {s}" for s in suggestions) + "\n"
        feedback_text += f"建议操作：{action}\n"
        page_titles = _outline_page_titles(current_outline)

        if on_progress:
            on_progress({"step": 4, "status": "refining",
                         "message": f"{next_action['label']}：正在根据第{round_num + 1}轮反馈修改大纲...",
                         "round": round_num + 1, "data": {"next_action": next_action, "active_round": round_num + 1}})

        refine_outline_input = current_outline[:PPT_REFINE_OUTLINE_INPUT_CHARS]
        new_outline = _call_llm_raw(
            refine_system_prompt,
            f"原始页面标题清单（必须保留，除非反馈明确要求删除）：\n{json.dumps(page_titles, ensure_ascii=False)}\n\n"
            f"原始大纲：\n{refine_outline_input}\n\n"
            f"审核反馈：\n{feedback_text}\n\n请根据反馈修改后输出完整大纲：",
            temperature=0.2, max_tokens=LLM_MAX_TOKENS,
        )
        if new_outline:
            regressed, reason = _outline_regressed_too_much(current_outline, new_outline)
            if regressed:
                _log(f"内容审核: 第{round_num+1}轮重生成被拒绝：{reason}")
                if on_progress:
                    on_progress({"step": 4, "status": "refine_rejected",
                                 "message": f"重写结果疑似退化，已保留上一版：{reason}",
                                 "round": round_num + 1})
                break
            current_outline = new_outline
        else:
            _log(f"内容审核: 第{round_num+1}轮重生成失败，使用当前大纲")
            break

    if on_progress:
        on_progress({"step": 4, "status": "done", "data": {
            "final_score": best_score or final_score,
            "latest_score": final_score,
            "best_round": best_round,
            "rounds_used": len(review_history),
        }})

    return {
        "content": best_outline,
        "review_history": review_history,
        "final_score": best_score or final_score,
        "latest_score": final_score,
        "best_round": best_round,
        "skipped": False,
    }


def _classify_structure_replan_action(feedback: str) -> dict:
    """Decide whether structure feedback needs targeted information search first."""
    text = (feedback or "").strip()
    if not text:
        return {"action": "edit", "reason": "empty feedback, use structure-only replanning"}

    search_keywords = (
        "补充", "搜索", "资料", "来源", "数据", "benchmark", "基准", "竞品",
        "对比", "最新", "价格", "成本", "案例", "文献", "论文", "官方",
        "报告", "证据", "验证", "引用", "调研", "评测", "排行榜", "leaderboard",
        "模型", "GPT", "Gemini", "Claude", "OpenAI", "Google", "Anthropic",
    )
    rule_action = "search_replan" if any(k.lower() in text.lower() for k in search_keywords) else "edit"

    if not _can_call_llm():
        return {"action": rule_action, "reason": "LLM unavailable, rule fallback"}

    prompt = (
        "你是PPT结构修改意图分类器。判断用户对PPT结构方案的意见是否需要先补充搜索资料。\n"
        "只输出JSON：{\"action\":\"edit\"|\"search_replan\",\"reason\":\"简短原因\"}\n"
        "选择 search_replan：用户要求补充事实、数据、来源、竞品、benchmark、价格、案例、最新信息、验证证据。\n"
        "选择 edit：用户只是要求调整页序、删减、合并、拆分、叙事结构、表达重点或页面布局。"
    )
    answer = _call_llm_raw(
        prompt,
        f"用户意见：\n{text}\n\n请分类。",
        temperature=0,
        max_tokens=1024,
        timeout_seconds=LLM_REQ_TIMEOUT_NORMAL_SECONDS,
    )
    data = _safe_json_loads(answer, {}) if answer else {}
    action = str(data.get("action") or "").strip().lower()
    if action not in ("edit", "search_replan"):
        action = rule_action
    reason = str(data.get("reason") or "classified by rule fallback").strip()
    return {"action": action, "reason": reason[:200]}


# ===========================================================================
#  SSE Pipeline Endpoint
# ===========================================================================

def _register_routes(app):
    """Register PPT pipeline routes on the Flask app."""

    @app.route("/api/v1/ppt-pipeline", methods=["POST"])
    def ppt_pipeline():
        """Six-step PPT generation pipeline via SSE.

        Steps 1-6 are handled entirely by this backend (no Chrys dependency).
        Accepts optional 'reference_pptx' path to extract and follow a reference style.
        """
        data = request.get_json() or {}
        query = data.get("query", "")
        supported_templates = {"default", "huawei_standard"}
        template = str(data.get("template", "default") or "default")
        if template not in supported_templates:
            template = "default"
        reference_pptx = data.get("reference_pptx", "")  # 参考PPTX文件路径
        raw_project_ids = data.get("project_ids", [])
        project_ids = [
            str(pid).split("::", 1)[0]
            for pid in (raw_project_ids if isinstance(raw_project_ids, list) else [raw_project_ids])
            if str(pid or "").strip()
        ]
        use_web_search = data.get("use_web_search", False)
        platforms = data.get("platforms", {"local": bool(data.get("project_ids", [])), "webSearch": bool(use_web_search), "hiDesk": False, "haiwen": False})
        max_search_rounds = min(data.get("max_search_rounds", 5), 5)
        max_content_rounds = data.get("max_content_rounds", 3)
        allow_low_confidence_draft = bool(data.get("allow_low_confidence_draft", False))
        workflow_mode = str(data.get("workflow_mode", "auto")).lower()
        optimization_mode = str(data.get("optimization_mode", "balanced")).lower()
        if optimization_mode not in ("speed", "balanced", "quality"):
            optimization_mode = "balanced"
        manual_mode = workflow_mode == "manual"
        confirm_structure = manual_mode and bool(data.get("confirm_structure", True))
        svg_max_workers = max(1, min(int(data.get("svg_max_workers", 8) or 8), 8))

        if not query:
            return jsonify({"success": False, "message": "query is required"}), 400

        pipeline_id = str(uuid.uuid4())[:8]

        def generate():
            nonlocal query, template, workflow_mode, manual_mode, confirm_structure
            pending_events = []
            all_events = []
            task_dir = ""
            log_prefix = f"[PPT:{pipeline_id}] "
            step_timings = {}  # {step: {"start": ts, "end": ts, "elapsed": sec}}
            pipeline_start = time.time()

            def _start_step(step):
                step_timings[step] = {"start": time.time()}

            def _end_step(step, evt):
                if step in step_timings:
                    step_timings[step]["end"] = time.time()
                    step_timings[step]["elapsed"] = round(step_timings[step]["end"] - step_timings[step]["start"], 1)
                if isinstance(evt, dict):
                    evt.setdefault("data", {})
                    evt["data"]["elapsed_seconds"] = step_timings.get(step, {}).get("elapsed", 0)
                    evt["data"]["timings"] = {str(k): v for k, v in step_timings.items()}

            def on_progress(evt):
                pending_events.append(evt)
                all_events.append(evt)

            def stream_call(func, heartbeat_step=None, heartbeat_message="处理中",
                           heartbeat_data=None):
                event_queue = queue.Queue()
                result_box = {}
                ctx_data = heartbeat_data or {}
                ctx_message = heartbeat_message

                def streamed_progress(evt):
                    # Update heartbeat context from progress events (e.g. current round, query)
                    nonlocal ctx_message, ctx_data
                    if isinstance(evt, dict):
                        if evt.get("hb_message"):
                            ctx_message = evt["hb_message"]
                        if evt.get("hb_data"):
                            ctx_data = {**ctx_data, **evt["hb_data"]}
                    event_queue.put(evt)

                def worker():
                    try:
                        result_box["value"] = func(streamed_progress)
                    except Exception as exc:
                        result_box["error"] = exc
                    finally:
                        event_queue.put(None)

                thread = threading.Thread(target=worker, daemon=True)
                thread.start()
                started_at = time.time()
                last_hb = started_at

                while True:
                    try:
                        evt = event_queue.get(timeout=1.0)
                    except queue.Empty:
                        if heartbeat_step is not None and time.time() - last_hb >= 10:
                            elapsed = int(time.time() - started_at)
                            hb_evt = {
                                "step": heartbeat_step, "status": "running",
                                "message": f"{ctx_message}，已用时{elapsed}秒",
                                "data": {"elapsed_seconds": elapsed, "heartbeat": True, **ctx_data},
                            }
                            all_events.append(hb_evt)
                            yield f"data: {json.dumps(hb_evt, ensure_ascii=False)}\n\n"
                            last_hb = time.time()
                        continue
                    if evt is None:
                        break
                    all_events.append(evt)
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"

                thread.join(timeout=0.1)
                if "error" in result_box:
                    _log(f"{log_prefix}stream_call error step={heartbeat_step} message={heartbeat_message} error={result_box['error']}")
                    raise result_box["error"]
                _log(f"{log_prefix}stream_call done step={heartbeat_step} message={heartbeat_message} elapsed={time.time() - started_at:.2f}s")
                return result_box.get("value")

            def wait_for_resume(stage, payload):
                _pipeline_states[pipeline_id] = {
                    "stage": stage, "action": None,
                    "edited_content": "", "payload": payload,
                    "updated_at": time.time(),
                }
                wait_evt = {
                    "step": payload.get("step", 3), "status": "await_user",
                    "message": payload.get("message", "等待用户确认..."),
                    "data": {**payload, "pipeline_id": pipeline_id, "manual": True},
                }
                all_events.append(wait_evt)
                _log(f"{log_prefix}manual await stage={stage}")
                yield f"data: {json.dumps(wait_evt, ensure_ascii=False)}\n\n"

                last_hb = time.time()
                while True:
                    state = _pipeline_states.get(pipeline_id, {})
                    action = state.get("action")
                    if action:
                        result = {
                            "action": action,
                            "edited_content": state.get("edited_content", ""),
                            "feedback": state.get("feedback", ""),
                            "payload": state.get("payload", {}),
                        }
                        _pipeline_states.pop(pipeline_id, None)
                        _log(f"{log_prefix}manual resume stage={stage} action={action}")
                        _write_log("ppt_pipeline_manual_resume_consumed", {
                            "pipeline_id": pipeline_id,
                            "stage": stage,
                            "action": action,
                            "edited_content_length": len(result.get("edited_content") or ""),
                            "feedback_length": len(result.get("feedback") or ""),
                            "edited_content_preview": (result.get("edited_content") or "")[:500],
                            "feedback_preview": (result.get("feedback") or "")[:500],
                        })
                        return result
                    if time.time() - last_hb >= 10:
                        hb_evt = {
                            "step": payload.get("step", 3), "status": "await_user",
                            "message": "等待结构规划确认中...",
                            "data": {**payload, "pipeline_id": pipeline_id, "manual": True, "heartbeat": True},
                        }
                        all_events.append(hb_evt)
                        yield f"data: {json.dumps(hb_evt, ensure_ascii=False)}\n\n"
                        last_hb = time.time()
                    time.sleep(1)

            try:
                # ── Create task directory ──
                task_dir = _create_ppt_task_dir(pipeline_id, query)
                _save_ppt_text_artifact(task_dir, "query.txt", query)
                all_events.append({"type": "task_dir_created", "task_dir": task_dir})
                _log(f"{log_prefix}start query={query!r} template={template} raw_project_ids={raw_project_ids} project_ids={project_ids} web={bool(use_web_search)} mode={workflow_mode} task_dir={task_dir}")
                _write_log("ppt_pipeline_start", {
                    "pipeline_id": pipeline_id,
                    "query": query,
                    "template": template,
                    "raw_project_ids": raw_project_ids,
                    "project_ids": project_ids,
                    "use_web_search": bool(use_web_search),
                    "workflow_mode": workflow_mode,
                    "task_dir": task_dir,
                })
                _save_ppt_step_artifact(task_dir, 0, "request", {
                    "pipeline_id": pipeline_id,
                    "query": query,
                    "template": template,
                    "raw_project_ids": raw_project_ids,
                    "project_ids": project_ids,
                    "use_web_search": bool(use_web_search),
                    "workflow_mode": workflow_mode,
                    "task_dir": task_dir,
                })

                # ── Step 1: Intent Analysis ──
                _start_step(1)
                # Log the actual LLM config being used for this pipeline run
                try:
                    load_cfg = _refs.get("load_llm_config")
                    if load_cfg:
                        cfg = load_cfg()
                        _write_log("ppt_pipeline_llm_config", {
                            "pipeline_id": pipeline_id,
                            "llm_url": cfg.get("llm_url", ""),
                            "llm_model": cfg.get("llm_model", ""),
                        })
                except Exception:
                    pass
                step1_running = {'step': 1, 'status': 'running', 'message': '正在分析意图...'}
                _log(f"{log_prefix}Step1 start")
                _write_log("ppt_pipeline_step", {"pipeline_id": pipeline_id, "step": 1, "status": "start"})
                yield f"data: {json.dumps(step1_running, ensure_ascii=False)}\n\n"
                intent = yield from stream_call(
                    lambda progress: _analyze_ppt_intent(query, template, on_progress=progress),
                    heartbeat_step=1, heartbeat_message="意图分析中",
                )
                requirement_clarity = _build_ppt_requirement_clarity(query, intent)
                _save_ppt_step_artifact(task_dir, 1, "intent",
                                        {"intent": intent, "query": query, "template": template,
                                         "requirement_clarity": requirement_clarity})
                clarity_msg = ("，需求明确" if requirement_clarity.get("is_clear")
                               else f'，待确认：{"、".join(requirement_clarity.get("missing", []))}')
                step1_evt = {
                    'step': 1, 'status': 'done',
                    'message': f'意图分析完成：主题={intent.get("topic", "")[:40]}，'
                               f'受众={intent.get("audience", "")}，场景={intent.get("scenario", "")}，'
                               f'预计{intent.get("estimated_slides", 10)}页{clarity_msg}',
                    'data': {'intent': intent, 'requirement_clarity': requirement_clarity},
                }
                all_events.append(step1_evt)
                _log(f"{log_prefix}Step1 done intent_topic={intent.get('topic')} audience={intent.get('audience')} slides={intent.get('estimated_slides')}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 1,
                    "status": "done",
                    "intent": intent,
                    "requirement_clarity": requirement_clarity,
                })
                yield f"data: {json.dumps(step1_evt, ensure_ascii=False)}\n\n"

                # 始终等待意图确认（无论初始模式是 auto 还是 manual）
                # 自动推荐 mode 和 visual_style
                default_mode = "briefing"
                default_visual_style = "dark-tech"
                if ppt_executor is not None:
                    try:
                        default_mode = ppt_executor._select_mode(intent)
                        default_visual_style = ppt_executor._select_visual_style(intent, "dark")
                    except Exception:
                        pass

                def _parse_intent_review_payload(review):
                    raw_content = review.get("edited_content")
                    raw_feedback = review.get("feedback", "")
                    parsed = _safe_json_loads(raw_content, None) if isinstance(raw_content, str) else raw_content
                    if isinstance(parsed, dict):
                        options = parsed
                        feedback_text = str(options.get("feedback") or raw_feedback or "").strip()
                    else:
                        options = {}
                        feedback_text = str(raw_content or raw_feedback or "").strip()
                    return options, feedback_text

                def _apply_intent_options(options):
                    nonlocal workflow_mode, manual_mode, confirm_structure, intent, template
                    if not isinstance(options, dict):
                        return
                    new_mode = str(options.get("workflow_mode", workflow_mode)).lower()
                    if new_mode in ("auto", "manual"):
                        workflow_mode = new_mode
                        manual_mode = workflow_mode == "manual"
                        confirm_structure = manual_mode and bool(data.get("confirm_structure", True))
                    for key in ("mode", "visual_style", "content_format"):
                        value = options.get(key)
                        if value:
                            intent[key] = value
                    requested_template = str(options.get("template", template) or "default")
                    if requested_template in supported_templates:
                        template = requested_template

                while True:
                    intent_review = yield from wait_for_resume("intent", {
                        "step": 1, "stage": "intent",
                        "message": "请确认意图分析结果，选择生成模式、风格和内容形式后继续。",
                        "intent": intent, "query": query, "workflow_mode": workflow_mode,
                        "template": template,
                        "template_options": [
                            {"value": "default", "label": "自动匹配"},
                            {"value": "huawei_standard", "label": "华为 16:9"},
                        ],
                        "default_mode": default_mode,
                        "default_visual_style": default_visual_style,
                    })
                    if intent_review.get("action") == "cancel":
                        yield f"data: {json.dumps({'step': 'error', 'message': '用户取消 PPT 生成', 'data': {'reason': 'user_cancelled', 'stage': 'intent'}}, ensure_ascii=False)}\n\n"
                        return
                    if intent_review.get("action") in ("edit", "direct_edit"):
                        edited_intent = _safe_json_loads(intent_review.get("edited_content"), None)
                        if isinstance(edited_intent, dict):
                            intent = {**intent, **edited_intent}
                            _save_ppt_step_artifact(task_dir, "1_manual_edit", "intent",
                                                    {"intent": intent})
                        break  # 编辑后直接继续
                    elif intent_review.get("action") in ("reanalyze", "regenerate"):
                        options, feedback = _parse_intent_review_payload(intent_review)
                        _apply_intent_options(options)
                        preserved_options = {
                            key: intent.get(key)
                            for key in ("mode", "visual_style", "content_format")
                            if intent.get(key)
                        }
                        query = f"{query}\n\n人工补充意见：\n{feedback.strip()}" if feedback.strip() else query
                        reanalyze_evt = {'step': 1, 'status': 'running',
                                         'message': '正在根据人工补充意见重新分析意图...',
                                         'data': {'stage': 'intent', 'manual_feedback': feedback,
                                                  'intent_options': options}}
                        all_events.append(reanalyze_evt)
                        yield f"data: {json.dumps(reanalyze_evt, ensure_ascii=False)}\n\n"
                        intent = yield from stream_call(
                            lambda progress: _analyze_ppt_intent(query, template, on_progress=progress),
                            heartbeat_step=1, heartbeat_message="意图重新分析中",
                        )
                        intent = {**intent, **preserved_options}
                        _apply_intent_options(options)
                        requirement_clarity = _build_ppt_requirement_clarity(query, intent)
                        _save_ppt_step_artifact(task_dir, "1_manual_reanalyze", "intent",
                                                {"intent": intent, "query": query,
                                                 "manual_feedback": feedback,
                                                 "intent_options": options,
                                                 "requirement_clarity": requirement_clarity})
                        step1_manual_evt = {'step': 1, 'status': 'done',
                                            'message': '人工补充意见后的意图分析完成',
                                            'data': {'intent': intent,
                                                     'intent_options': options,
                                                     'requirement_clarity': requirement_clarity}}
                        all_events.append(step1_manual_evt)
                        yield f"data: {json.dumps(step1_manual_evt, ensure_ascii=False)}\n\n"
                        break  # 补充意见后直接继续，不再二次确认
                    else:
                        # continue：解析用户选择的模式、风格、内容形式
                        intent_options = intent_review.get("edited_content") or intent_review.get("feedback") or ""
                        if intent_options:
                            try:
                                opts = json.loads(intent_options) if isinstance(intent_options, str) else intent_options
                                _apply_intent_options(opts)
                                # 用户覆盖的 mode / visual_style
                                _log(f"{log_prefix}Intent confirmed: workflow={workflow_mode}, template={template}, mode={intent.get('mode')}, visual_style={intent.get('visual_style')}, format={opts.get('content_format')}")
                            except (json.JSONDecodeError, ValueError) as e:
                                _log(f"{log_prefix}Failed to parse intent_options: {e}")
                        break  # 继续下一步

                _save_ppt_step_artifact(task_dir, 0, "request", {
                    "pipeline_id": pipeline_id,
                    "query": query,
                    "template": template,
                    "reference_pptx": reference_pptx,
                    "raw_project_ids": raw_project_ids,
                    "project_ids": project_ids,
                    "use_web_search": use_web_search,
                    "workflow_mode": workflow_mode,
                    "task_dir": task_dir,
                })

                _end_step(1, step1_evt)
                for evt in pending_events:
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                pending_events.clear()

                # ── Extract reference PPTX style if provided ──
                reference_style = None
                if reference_pptx and os.path.isfile(reference_pptx):
                    try:
                        from ppt_style_extractor import extract_pptx_style, extract_content
                        ref_start_evt = {'step': 1, 'status': 'running',
                                          'message': f'正在提取参考PPT样式: {os.path.basename(reference_pptx)}...',
                                          'data': {'reference_pptx': reference_pptx}}
                        all_events.append(ref_start_evt)
                        yield f"data: {json.dumps(ref_start_evt, ensure_ascii=False)}\n\n"

                        reference_style = extract_pptx_style(reference_pptx)
                        ref_done_evt = {'step': 1, 'status': 'done',
                                        'message': f'参考PPT样式提取完成: {reference_style.get("slide_count", "?")}页, '
                                                   f'{reference_style.get("theme", "?")}主题',
                                        'data': {'reference_style': {k: v for k, v in reference_style.items()
                                                                      if k not in ("colors_detail",)}}}
                        all_events.append(ref_done_evt)
                        yield f"data: {json.dumps(ref_done_evt, ensure_ascii=False)}\n\n"

                        # Also extract text content from reference as additional source
                        ref_content = extract_content(reference_pptx)
                        if ref_content:
                            _save_ppt_text_artifact(task_dir, "step0_reference_content.md", ref_content)
                            _log(f"{log_prefix}Reference content extracted: {len(ref_content)} chars")
                    except Exception as e:
                        _log(f"{log_prefix}Reference style extraction failed: {e}")

                # ── Step 2: Information Collection ──
                _start_step(2)
                step2_running = {'step': 2, 'status': 'running', 'message': '正在收集信息...'}
                _log(f"{log_prefix}Step2 start")
                _write_log("ppt_pipeline_step", {"pipeline_id": pipeline_id, "step": 2, "status": "start"})
                yield f"data: {json.dumps(step2_running, ensure_ascii=False)}\n\n"
                info_result = yield from stream_call(
                    lambda progress: _collect_ppt_information(
                        query, intent, project_ids, use_web_search, max_search_rounds,
                        on_progress=progress, pipeline_id=pipeline_id,
                        platforms=platforms, search_mode=optimization_mode),
                    heartbeat_step=2, heartbeat_message="信息收集 · 启动中",
                    heartbeat_data={"round": 1, "max_rounds": max_search_rounds},
                )
                _save_ppt_step_artifact(task_dir, 2, "info", {
                    "round_details": info_result.get("round_details", []),
                    "sources": info_result.get("sources", []),
                    "quality_score": info_result.get("quality_score", 0),
                    "rounds_used": info_result.get("rounds_used", 0),
                    "collected_info_preview": info_result.get("collected_info", "")[:3000],
                })
                search_debug_path = _save_ppt_text_artifact(
                    task_dir, "step2_search_debug.md",
                    _format_ppt_search_debug_log(info_result))

                # Build round summaries
                round_summaries = []
                for rd in info_result.get("round_details", []):
                    kb_count = len(rd.get("kb_results", []))
                    web_count = len(rd.get("web_results", []))
                    queries = rd.get("queries", [])
                    web_links = [f"{r['title']}({r['url']})" for r in rd.get("web_results", [])[:3]]
                    new_count = rd.get("new_results_count", rd.get("results_count", 0))
                    cumulative_count = rd.get("cumulative_results_count", rd.get("results_count", 0))
                    web_diag = rd.get("web_diagnostics", {}) or {}
                    query_expansion = rd.get("query_expansion", {}) or {}
                    summary = (f"轮次{rd['round']}: 搜索[{', '.join(queries[:2])}] "
                               f"→ 知识库{kb_count}条 + 联网{web_count}条, "
                               f"新增{new_count}条/累计{cumulative_count}条, "
                               f"质量{rd.get('quality', '-')}分")
                    if query_expansion:
                        summary += f"\n  查询策略: {query_expansion.get('method', '-')}"
                        if query_expansion.get("missing_topics"):
                            summary += f"，缺口改写自: {'; '.join(query_expansion.get('missing_topics', [])[:3])}"
                        if query_expansion.get("fallback_queries") and query_expansion.get("method") == "rules_fallback":
                            summary += f"\n  规则补充查询: {'; '.join(query_expansion.get('fallback_queries', [])[:3])}"
                    summary += (
                        f"\n  联网诊断: 调用{web_diag.get('search_called', 0)}次"
                        f"，原始{web_diag.get('raw_count', 0)}条"
                        f"，重复{web_diag.get('duplicate_count', 0)}条"
                        f"，无URL{web_diag.get('no_url_count', 0)}条"
                        f"，抓取失败{web_diag.get('fetch_failed_count', 0)}条"
                        f"，保留{web_diag.get('kept_count', web_count)}条"
                    )
                    if rd.get("skipped_queries"):
                        summary += f"\n  跳过重复关键词: {', '.join(rd.get('skipped_queries', [])[:3])}"
                    if web_links:
                        summary += f"\n  来源: {'; '.join(web_links)}"
                    round_summaries.append(summary)

                step2_evt = {
                    'step': 2, 'status': 'done',
                    'message': f'信息收集完成：共{info_result["rounds_used"]}轮，'
                               f'质量{info_result["quality_score"]}分，'
                               f'{len(info_result["sources"])}个来源',
                    'data': {
                        'total_results': info_result.get('total_results', 0),
                        'final_quality': info_result['quality_score'],
                        'rounds_used': info_result['rounds_used'],
                        'sources': info_result['sources'][:10],
                        'round_summaries': round_summaries,
                        'summary': info_result.get('summary', '')[:300],
                        'round_details': info_result.get('round_details', []),
                        'collected_info_length': info_result.get('collected_info_length', 0),
                        'search_debug_path': search_debug_path,
                    },
                }
                all_events.append(step2_evt)
                _end_step(2, step2_evt)
                _log(f"{log_prefix}Step2 done quality={info_result.get('quality_score')} rounds={info_result.get('rounds_used')} sources={len(info_result.get('sources', []))}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 2,
                    "status": "done",
                    "quality_score": info_result.get("quality_score"),
                    "rounds_used": info_result.get("rounds_used"),
                    "sources_count": len(info_result.get("sources", [])),
                    "search_debug_path": search_debug_path,
                })
                yield f"data: {json.dumps(step2_evt, ensure_ascii=False)}\n\n"

                for evt in pending_events:
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                pending_events.clear()

                # ── Step 2.5: Info Distillation ──
                _start_step(2.5)
                step25_running = {'step': 2.5, 'status': 'running',
                                  'message': '正在整理收集的信息并删除重复内容...'}
                _log(f"{log_prefix}Step2.5 start collected_chars={len(info_result.get('collected_info', ''))}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 2.5,
                    "status": "start",
                    "collected_info_length": len(info_result.get("collected_info", "")),
                })
                yield f"data: {json.dumps(step25_running, ensure_ascii=False)}\n\n"
                distill_result = yield from stream_call(
                    lambda progress: _distill_collected_info(
                        query, intent, info_result["collected_info"], on_progress=progress),
                    heartbeat_step=2.5, heartbeat_message="信息整理中",
                )
                distilled_info = distill_result.get("distilled_info", "")
                _save_ppt_text_artifact(task_dir, "step25_distilled_info.md", distilled_info)
                _save_ppt_step_artifact(task_dir, 2.5, "distill", {
                    "distilled": distill_result.get("distilled", False),
                    "length": distill_result.get("length", 0),
                    "original_length": len(info_result.get("collected_info", "")),
                    "diagnostics": distill_result.get("diagnostics", {}),
                    "preview": distilled_info[:2000],
                })
                step25_evt = {
                    'step': 2.5, 'status': 'done',
                    'message': f'信息整理完成：{len(distilled_info)}字'
                               f'（原始{len(info_result.get("collected_info", ""))}字）',
                    'data': {
                        'distilled': distill_result.get("distilled", False),
                        'length': distill_result.get("length", 0),
                        'original_length': len(info_result.get("collected_info", "")),
                        'retention_ratio': round(len(distilled_info) / max(len(info_result.get("collected_info", "")), 1) * 100, 1),
                        'compression_ratio': round(len(distilled_info) / max(len(info_result.get("collected_info", "")), 1) * 100, 1),
                        'diagnostics': distill_result.get("diagnostics", {}),
                    },
                }
                all_events.append(step25_evt)
                _end_step(2.5, step25_evt)
                _log(f"{log_prefix}Step2.5 done distilled={distill_result.get('distilled')} chars={len(distilled_info)}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 2.5,
                    "status": "done",
                    "distilled": distill_result.get("distilled", False),
                    "length": len(distilled_info),
                    "diagnostics": distill_result.get("diagnostics", {}),
                })
                yield f"data: {json.dumps(step25_evt, ensure_ascii=False)}\n\n"

                for evt in pending_events:
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                pending_events.clear()

                # ── Step 3: Structure Planning ──
                _start_step(3)
                step3_running = {'step': 3, 'status': 'running', 'message': '正在规划PPT结构...'}
                _log(f"{log_prefix}Step3 start input_chars={len((distilled_info if distilled_info else info_result['collected_info']) or '')} expected_slides={intent.get('estimated_slides', 10)}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 3,
                    "status": "start",
                    "input_chars": len((distilled_info if distilled_info else info_result["collected_info"]) or ""),
                    "expected_slides": intent.get("estimated_slides", 10),
                })
                yield f"data: {json.dumps(step3_running, ensure_ascii=False)}\n\n"
                structure_input = distilled_info if distilled_info else info_result["collected_info"]
                structure_result = yield from stream_call(
                    lambda progress: _plan_ppt_structure(
                        query, intent, structure_input, template,
                        intent.get("estimated_slides", 10), on_progress=progress),
                    heartbeat_step=3, heartbeat_message="结构规划 · LLM生成大纲中",
                    heartbeat_data={"target_slides": intent.get("estimated_slides", 10)},
                )
                expected_slides = max(_safe_int(intent.get("estimated_slides"), 10), 1)
                min_required_slides = _min_required_slide_count(intent)
                if structure_result.get("failed"):
                    diagnostics = structure_result.get("diagnostics", {})
                    _save_ppt_step_artifact(task_dir, 3, "structure", {
                        "failed": True,
                        "failure_stage": structure_result.get("failure_stage", "structure_llm_call"),
                        "expected_slides": expected_slides,
                        "min_required_slides": min_required_slides,
                        "diagnostics": diagnostics,
                    })
                    _write_log("ppt_pipeline_step", {
                        "pipeline_id": pipeline_id,
                        "step": 3,
                        "status": "failed",
                        "reason": "structure_llm_call_failed",
                        "expected_slides": expected_slides,
                        "min_required_slides": min_required_slides,
                        "diagnostics": diagnostics,
                    }, level="error")
                    error_type = diagnostics.get("error_type") or "unknown"
                    status_code = diagnostics.get("status_code")
                    block_message = (
                        f"结构规划失败：大模型调用失败（{error_type}"
                        f"{', HTTP ' + str(status_code) if status_code else ''}），流程已终止。"
                    )
                    yield f"data: {json.dumps(_build_ppt_block_event(3, block_message), ensure_ascii=False)}\n\n"
                    yield f"data: {json.dumps({'step': 'error', 'message': block_message, 'data': {'reason': 'structure_llm_call_failed', 'diagnostics': diagnostics}}, ensure_ascii=False)}\n\n"
                    return
                actual_slide_count = _safe_int(structure_result.get("slide_count"), 0)

                # Retry if too few slides
                if actual_slide_count < min_required_slides:
                    yield f"data: {json.dumps({'step': 3, 'status': 'refining', 'message': f'结构页数不足：规划{actual_slide_count}页，低于最低{min_required_slides}页，正在重规划...'}, ensure_ascii=False)}\n\n"
                    retry_feedback = (
                        f"上一次只生成{actual_slide_count}页，低于最低{min_required_slides}页。"
                        f"请严格输出约{expected_slides}页，至少{min_required_slides}页；"
                        "技术报告必须拆出架构、训练、上下文机制、评测、部署效率、风险与来源。")
                    retry_structure = yield from stream_call(
                        lambda progress: _plan_ppt_structure(
                            query, intent, structure_input, template, expected_slides,
                            on_progress=progress, planning_feedback=retry_feedback),
                        heartbeat_step=3, heartbeat_message="结构重规划中",
                    )
                    if retry_structure.get("failed"):
                        diagnostics = retry_structure.get("diagnostics", {})
                        _save_ppt_step_artifact(task_dir, "3_retry_failed", "structure", {
                            "failed": True,
                            "failure_stage": retry_structure.get("failure_stage", "structure_llm_call"),
                            "expected_slides": expected_slides,
                            "min_required_slides": min_required_slides,
                            "previous_slide_count": actual_slide_count,
                            "diagnostics": diagnostics,
                        })
                        _write_log("ppt_pipeline_step", {
                            "pipeline_id": pipeline_id,
                            "step": 3,
                            "status": "failed",
                            "reason": "structure_retry_llm_call_failed",
                            "expected_slides": expected_slides,
                            "min_required_slides": min_required_slides,
                            "previous_slide_count": actual_slide_count,
                            "diagnostics": diagnostics,
                        }, level="error")
                        error_type = diagnostics.get("error_type") or "unknown"
                        status_code = diagnostics.get("status_code")
                        block_message = (
                            f"结构重规划失败：大模型调用失败（{error_type}"
                            f"{', HTTP ' + str(status_code) if status_code else ''}），流程已终止。"
                        )
                        yield f"data: {json.dumps(_build_ppt_block_event(3, block_message), ensure_ascii=False)}\n\n"
                        yield f"data: {json.dumps({'step': 'error', 'message': block_message, 'data': {'reason': 'structure_retry_llm_call_failed', 'diagnostics': diagnostics}}, ensure_ascii=False)}\n\n"
                        return
                    retry_slide_count = _safe_int(retry_structure.get("slide_count"), 0)
                    if retry_slide_count > actual_slide_count:
                        structure_result = retry_structure
                        actual_slide_count = retry_slide_count

                if actual_slide_count < min_required_slides:
                    block_message = (f"结构规划失败：预计{expected_slides}页，"
                                     f"最低要求{min_required_slides}页，"
                                     f"但最终只有{actual_slide_count}页。")
                    yield f"data: {json.dumps(_build_ppt_block_event(3, block_message), ensure_ascii=False)}\n\n"
                    yield f"data: {json.dumps({'step': 'error', 'message': block_message, 'data': {'reason': 'structure_too_short'}}, ensure_ascii=False)}\n\n"
                    return

                # Parse page plans
                outline_full = structure_result.get("outline", "")
                page_plans = _extract_ppt_page_plans(outline_full)
                type_counts = {}
                for page in page_plans:
                    page_type = page.get("type") or "unknown"
                    type_counts[page_type] = type_counts.get(page_type, 0) + 1
                source_marker_count = sum(page.get("source_count", 0) for page in page_plans)
                structure_warnings = _build_structure_warnings(
                    actual_slide_count, expected_slides, min_required_slides, page_plans)

                _save_ppt_text_artifact(task_dir, "step3_outline.md", outline_full)
                _save_ppt_step_artifact(task_dir, 3, "structure", {
                    "slide_count": structure_result["slide_count"],
                    "page_plans": page_plans, "expected_slides": expected_slides,
                    "min_required_slides": min_required_slides,
                    "type_counts": type_counts,
                    "source_marker_count": source_marker_count,
                    "warnings": structure_warnings,
                    "diagnostics": structure_result.get("diagnostics", {}),
                })
                warning_msg = (f"，风险{len(structure_warnings)}项"
                               if structure_warnings else "，结构门槛通过")
                step3_evt = {
                    'step': 3, 'status': 'done',
                    'message': f'结构规划完成：目标{expected_slides}页，'
                               f'实际{actual_slide_count}页，'
                               f'最低门槛{min_required_slides}页{warning_msg}',
                    'data': {
                        'slide_count': actual_slide_count,
                        'expected_slides': expected_slides,
                        'min_required_slides': min_required_slides,
                        'page_plans': page_plans, 'type_counts': type_counts,
                        'source_marker_count': source_marker_count,
                        'warnings': structure_warnings,
                        'outline_artifact': os.path.join(task_dir, "step3_outline.md"),
                        'diagnostics': structure_result.get("diagnostics", {}),
                    },
                }
                all_events.append(step3_evt)
                _end_step(3, step3_evt)
                _log(f"{log_prefix}Step3 done slides={actual_slide_count} expected={expected_slides} warnings={len(structure_warnings)}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 3,
                    "status": "done",
                    "slide_count": actual_slide_count,
                    "expected_slides": expected_slides,
                    "min_required_slides": min_required_slides,
                    "warnings": structure_warnings,
                    "outline_artifact": os.path.join(task_dir, "step3_outline.md"),
                    "diagnostics": structure_result.get("diagnostics", {}),
                })
                yield f"data: {json.dumps(step3_evt, ensure_ascii=False)}\n\n"

                for evt in pending_events:
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                pending_events.clear()

                # ── Structure confirmation (manual mode) ──
                if confirm_structure:
                    replan_count = 0
                    while True:
                        user_decision = yield from wait_for_resume("structure_review", {
                            "step": 3,
                            "message": "结构规划已完成，请确认是否继续、输入意见重规划或取消。",
                            "slide_count": actual_slide_count,
                            "expected_slides": expected_slides,
                            "min_required_slides": min_required_slides,
                            "page_plans": page_plans, "type_counts": type_counts,
                            "source_marker_count": source_marker_count,
                            "warnings": structure_warnings,
                            "outline": outline_full,
                            "replan_count": replan_count,
                        })
                        action = user_decision.get("action")
                        if action == "cancel":
                            yield f"data: {json.dumps({'step': 'error', 'message': '用户在结构规划确认阶段取消生成。', 'data': {'reason': 'user_cancelled_at_structure'}}, ensure_ascii=False)}\n\n"
                            return
                        edited_payload = (user_decision.get("edited_content") or "").strip()
                        if action == "edit" and _count_outline_pages(edited_payload) >= 2:
                            action = "direct_edit"
                        if action == "direct_edit":
                            outline_full = edited_payload
                            structure_result = {"outline": outline_full,
                                                "slide_count": _count_outline_pages(outline_full)}
                            actual_slide_count = _safe_int(structure_result.get("slide_count"), 0)
                            page_plans = _extract_ppt_page_plans(outline_full)
                            type_counts = {}
                            for p in page_plans:
                                pt = p.get("type") or "unknown"
                                type_counts[pt] = type_counts.get(pt, 0) + 1
                            source_marker_count = sum(p.get("source_count", 0) for p in page_plans)
                            structure_warnings = _build_structure_warnings(
                                actual_slide_count, expected_slides, min_required_slides, page_plans)
                            _save_ppt_text_artifact(
                                task_dir, f"step3_outline_manual_edit{replan_count + 1}.md",
                                outline_full)
                            _save_ppt_step_artifact(task_dir, f"3_manual_edit{replan_count + 1}", "structure", {
                                "slide_count": actual_slide_count,
                                "page_plans": page_plans,
                                "expected_slides": expected_slides,
                                "min_required_slides": min_required_slides,
                                "type_counts": type_counts,
                                "source_marker_count": source_marker_count,
                                "warnings": structure_warnings,
                                "manual_direct_edit": True,
                            })
                            proceed_evt = {
                                "step": 3, "status": "done",
                                "message": "结构规划已按人工编辑确认，继续进入后续流程。",
                                "data": {"confirmed": True, "slide_count": actual_slide_count,
                                         "manual_direct_edit": True},
                            }
                            all_events.append(proceed_evt)
                            yield f"data: {json.dumps(proceed_evt, ensure_ascii=False)}\n\n"
                            break
                        if action not in ("edit", "search_replan", "smart_replan"):
                            proceed_evt = {
                                "step": 3, "status": "done",
                                "message": "结构规划已确认，继续进入内容审核。",
                                "data": {"confirmed": True, "slide_count": actual_slide_count},
                            }
                            all_events.append(proceed_evt)
                            yield f"data: {json.dumps(proceed_evt, ensure_ascii=False)}\n\n"
                            break

                        replan_count += 1
                        feedback = (user_decision.get("edited_content") or "").strip()
                        if not feedback:
                            feedback = "用户要求优化结构，但未提供具体意见；请提升叙事连贯性、页型多样性和来源标记密度。"
                        _write_log("ppt_pipeline_structure_feedback_received", {
                            "pipeline_id": pipeline_id,
                            "action": action,
                            "feedback": feedback,
                            "feedback_length": len(feedback),
                            "use_web_search": bool(use_web_search),
                            "project_ids": project_ids,
                        })
                        if action == "smart_replan":
                            intent_route = _classify_structure_replan_action(feedback)
                            action = intent_route.get("action", "edit")
                            _write_log("ppt_pipeline_structure_feedback_classified", {
                                "pipeline_id": pipeline_id,
                                "feedback": feedback,
                                "route_action": action,
                                "route_reason": intent_route.get("reason", ""),
                                "use_web_search": bool(use_web_search),
                            })
                            classify_evt = {
                                "step": 3, "status": "routing",
                                "message": "已分析修改意见，选择"
                                           + ("补充资料后重规划" if action == "search_replan" else "直接重规划")
                                           + "。",
                                "data": {
                                    "feedback": feedback,
                                    "route_action": action,
                                    "route_reason": intent_route.get("reason", ""),
                                },
                            }
                            all_events.append(classify_evt)
                            yield f"data: {json.dumps(classify_evt, ensure_ascii=False)}\n\n"
                        if action == "search_replan":
                            targeted_intent = {
                                **intent,
                                "focus_areas": list(intent.get("focus_areas") or []) + [feedback],
                            }
                            forced_queries = common_search_researcher.build_targeted_feedback_queries(
                                intent.get("topic") or query,
                                feedback,
                                targeted_intent,
                                max_queries=4,
                            )
                            _write_log("ppt_pipeline_structure_targeted_refine_start", {
                                "pipeline_id": pipeline_id,
                                "feedback": feedback,
                                "forced_queries": forced_queries,
                                "use_web_search": bool(use_web_search),
                                "project_ids": project_ids,
                            })
                            search_evt = {
                                "step": 2, "status": "targeted_refine",
                                "message": "根据人工意见执行定向补充搜索，并用于重新规划结构...",
                                "data": {
                                    "manual_feedback": feedback,
                                    "stage": "structure_review",
                                    "forced_queries": forced_queries,
                                    "web_enabled": bool(use_web_search),
                                },
                            }
                            all_events.append(search_evt)
                            yield f"data: {json.dumps(search_evt, ensure_ascii=False)}\n\n"
                            manual_info = yield from stream_call(
                                lambda progress: _collect_ppt_information(
                                    f"{query}\n\n人工定向补充：{feedback}",
                                    targeted_intent, project_ids, use_web_search,
                                    min(max_search_rounds, 3), on_progress=progress,
                                    pipeline_id=pipeline_id, forced_queries=forced_queries,
                                    platforms=platforms, search_mode=optimization_mode),
                                heartbeat_step=2, heartbeat_message="人工定向补充搜索中",
                            )
                            manual_round_queries = [
                                q
                                for rd in (manual_info.get("round_details", []) or [])
                                for q in (rd.get("queries", []) or [])
                            ]
                            _write_log("ppt_pipeline_structure_targeted_refine_result", {
                                "pipeline_id": pipeline_id,
                                "feedback": feedback,
                                "forced_queries": forced_queries,
                                "actual_queries": manual_round_queries,
                                "sources_count": len(manual_info.get("sources", []) or []),
                                "collected_info_length": len(manual_info.get("collected_info", "") or ""),
                                "quality_score": manual_info.get("quality_score", 0),
                                "rounds_used": manual_info.get("rounds_used", 0),
                                "use_web_search": bool(use_web_search),
                            })
                            _save_ppt_step_artifact(task_dir, f"2_manual_structure_refine{replan_count}", "targeted_info", {
                                "feedback": feedback,
                                "forced_queries": forced_queries,
                                "actual_queries": manual_round_queries,
                                "sources": manual_info.get("sources", []),
                                "quality_score": manual_info.get("quality_score", 0),
                                "round_details": manual_info.get("round_details", []),
                            })
                            structure_input = _merge_collected_info_append_only(
                                structure_input,
                                manual_info.get("collected_info", ""),
                                "Manual structure-review targeted information",
                            )
                            _save_ppt_text_artifact(
                                task_dir, f"step2_manual_structure_refine{replan_count}.md",
                                structure_input)
                        replan_evt = {
                            "step": 3, "status": "refining",
                            "message": f"根据用户意见重新规划结构（第{replan_count}次）...",
                            "data": {"feedback": feedback, "replan_count": replan_count},
                        }
                        all_events.append(replan_evt)
                        yield f"data: {json.dumps(replan_evt, ensure_ascii=False)}\n\n"
                        structure_result = yield from stream_call(
                            lambda progress: _plan_ppt_structure(
                                query, intent, structure_input, template, expected_slides,
                                on_progress=progress, planning_feedback=feedback),
                            heartbeat_step=3, heartbeat_message="根据用户意见重规划中",
                        )
                        actual_slide_count = _safe_int(structure_result.get("slide_count"), 0)
                        outline_full = structure_result.get("outline", "")
                        page_plans = _extract_ppt_page_plans(outline_full)
                        type_counts = {}
                        for p in page_plans:
                            pt = p.get("type") or "unknown"
                            type_counts[pt] = type_counts.get(pt, 0) + 1
                        source_marker_count = sum(p.get("source_count", 0) for p in page_plans)
                        structure_warnings = _build_structure_warnings(
                            actual_slide_count, expected_slides, min_required_slides, page_plans)
                        _save_ppt_text_artifact(
                            task_dir, f"step3_outline_user_replan{replan_count}.md", outline_full)
                        _save_ppt_step_artifact(task_dir, f"3_user_replan{replan_count}", "structure", {
                            "slide_count": structure_result.get("slide_count"),
                            "page_plans": page_plans,
                            "expected_slides": expected_slides,
                            "min_required_slides": min_required_slides,
                            "type_counts": type_counts,
                            "source_marker_count": source_marker_count,
                            "warnings": structure_warnings,
                            "user_feedback": feedback,
                        })
                        replan_done_evt = {
                            "step": 3, "status": "done",
                            "message": f"用户意见重规划完成：目标{expected_slides}页，"
                                       f"实际{actual_slide_count}页，"
                                       f"来源标记{source_marker_count}条",
                            "data": {
                                "slide_count": actual_slide_count,
                                "expected_slides": expected_slides,
                                "min_required_slides": min_required_slides,
                                "page_plans": page_plans, "type_counts": type_counts,
                                "source_marker_count": source_marker_count,
                                "warnings": structure_warnings,
                                "replan_count": replan_count,
                            },
                        }
                        all_events.append(replan_done_evt)
                        yield f"data: {json.dumps(replan_done_evt, ensure_ascii=False)}\n\n"

                # ── Step 4: Content Review ──
                title = _clean_ppt_report_title(query, structure_result["outline"])
                if manual_mode:
                    # Manual mode already asks the user to review the full page structure.
                    # Avoid a second confirmation step for the same outline.
                    review_result = {
                        "content": structure_result["outline"],
                        "review_history": [],
                        "final_score": 100.0,
                        "latest_score": 100.0,
                        "best_round": 0,
                        "skipped": True,
                        "manual_structure_confirmed": True,
                    }
                    step4_skipped = {
                        "step": 4,
                        "status": "skipped",
                        "message": "人工模式已完成结构规划审核，跳过后续内容审核。",
                        "data": {"reason": "manual_structure_review_confirmed"},
                    }
                    all_events.append(step4_skipped)
                    _write_log("ppt_pipeline_step", {
                        "pipeline_id": pipeline_id,
                        "step": 4,
                        "status": "skipped",
                        "manual": True,
                        "reason": "manual_structure_review_confirmed",
                    })
                    yield f"data: {json.dumps(step4_skipped, ensure_ascii=False)}\n\n"
                elif False and manual_mode:
                    # Manual mode: run review loop with human confirmation after each round
                    _start_step(4)
                    step4_running = {'step': 4, 'status': 'running', 'message': '正在审核内容质量（人工模式）...'}
                    _log(f"{log_prefix}Step4 start manual")
                    _write_log("ppt_pipeline_step", {"pipeline_id": pipeline_id, "step": 4, "status": "start", "manual": True})
                    yield f"data: {json.dumps(step4_running, ensure_ascii=False)}\n\n"
                    
                    current_outline = structure_result["outline"]
                    best_outline = current_outline
                    best_score = 0.0
                    review_history = []
                    
                    for round_num in range(max_content_rounds):
                        # Run review scoring
                        review_result_raw = _call_llm_raw(
                            "你是PPT内容质量审核专家。请严格按照JSON格式评估以下PPT大纲的质量。\n"
                            "评估维度（每项0-20分，总分100）：\n"
                            "1. 信息准确性：数据、事实是否准确\n"
                            "2. 章节完整性：是否覆盖主题关键方面\n"
                            "3. 受众匹配度：内容深度是否适合目标受众\n"
                            "4. 数据可信度：引用数据是否有明确来源\n"
                            "5. 叙事逻辑：内容组织是否有清晰逻辑\n\n"
                            "硬性问题：精确数字、benchmark、日期没有 [SOURCE]/[VERIFY] 必须扣分。\n\n"
                            "请严格输出JSON：\n"
                            '{"accuracy":0-20,"completeness":0-20,"audience_fit":0-20,'
                            '"credibility":0-20,"narrative":0-20,"total_score":0-100,'
                            '"issues":["问题1"],"suggestions":["建议1"],'
                            '"action":"pass"|"refine_information"|"refine_structure"}',
                            f"PPT标题：{title}\n页面标题清单：{json.dumps(_outline_page_titles(current_outline), ensure_ascii=False)}\n\n"
                            f"大纲内容：\n{current_outline[:PPT_REVIEW_OUTLINE_INPUT_CHARS]}\n\n请评估以上内容质量。",
                            temperature=0.15, max_tokens=LLM_MAX_TOKENS,
                        )
                        
                        try:
                            json_match = re.search(r'\{[\s\S]*\}', review_result_raw or '')
                            review_data = json.loads(json_match.group()) if json_match else {"total_score": 70, "issues": [], "suggestions": [], "action": "pass"}
                        except (json.JSONDecodeError, ValueError):
                            review_data = {"total_score": 70, "issues": [], "suggestions": [], "action": "pass"}
                        
                        score = review_data.get("total_score", 0)
                        if score >= best_score:
                            best_score = score
                            best_outline = current_outline
                        review_history.append({
                            "round": round_num + 1, "score": score,
                            "issues": review_data.get("issues", []),
                            "suggestions": review_data.get("suggestions", []),
                            "action": review_data.get("action", "pass"),
                        })
                        
                        review_evt = {
                            "step": 4, "status": "review_result",
                            "message": f"第{round_num+1}轮审核：{score}分",
                            "data": {
                                "round": round_num + 1, "score": score,
                                "issues": review_data.get("issues", []),
                                "suggestions": review_data.get("suggestions", []),
                                "action": review_data.get("action", "pass"),
                            }
                        }
                        yield f"data: {json.dumps(review_evt, ensure_ascii=False)}\n\n"
                        
                        # Wait for user confirmation
                        user_decision = yield from wait_for_resume("content_review", {
                            "step": 4, "stage": "content_review",
                            "message": f"第{round_num+1}轮审核完成：{score}分。请确认通过、输入修改意见、或取消。",
                            "round": round_num + 1, "score": score,
                            "issues": review_data.get("issues", []),
                            "suggestions": review_data.get("suggestions", []),
                            "action": review_data.get("action", "pass"),
                            "outline": current_outline[:2000],
                        })
                        
                        action = user_decision.get("action")
                        if action == "cancel":
                            yield f"data: {json.dumps({'step': 'error', 'message': '用户在内容审核阶段取消生成。', 'data': {'reason': 'user_cancelled_at_content_review'}}, ensure_ascii=False)}\n\n"
                            return
                        
                        if action in ("approve", "confirm", "pass", "continue") or score >= 85:
                            break

                        if action == "search_replan":
                            feedback = (user_decision.get("edited_content") or user_decision.get("feedback") or "").strip()
                            if not feedback:
                                feedback = "用户要求补充更多信息以提升内容质量。"
                            srch_evt = {
                                "step": 2, "status": "targeted_refine",
                                "message": "根据人工审核意见执行定向补充搜索，并用于重新审核内容...",
                                "data": {"manual_feedback": feedback, "stage": "content_review"},
                            }
                            all_events.append(srch_evt)
                            yield f"data: {json.dumps(srch_evt, ensure_ascii=False)}\n\n"
                            manual_info = yield from stream_call(
                                lambda progress: _collect_ppt_information(
                                    f"{query}\n\n人工定向补充：{feedback}",
                                    intent, project_ids, use_web_search,
                                    min(max_search_rounds, 3), on_progress=progress,
                                    platforms=platforms),
                                heartbeat_step=2, heartbeat_message="人工定向补充搜索中",
                            )
                            _save_ppt_step_artifact(task_dir, "4_manual_targeted_info", "targeted_info", {
                                "query": feedback,
                                "round_details": manual_info.get("round_details", []),
                                "sources": manual_info.get("sources", []),
                                "quality_score": manual_info.get("quality_score", 0),
                            })
                            merged_ci = _merge_collected_info_append_only(
                                info_result.get("collected_info", ""),
                                manual_info.get("collected_info", ""),
                                "Manual content-review targeted information",
                            )
                            merged_src = list(dict.fromkeys(
                                (info_result.get("sources", []) or [])
                                + (manual_info.get("sources", []) or [])))
                            info_result = {
                                **info_result,
                                "collected_info": merged_ci,
                                "collected_info_length": len(merged_ci),
                                "sources": merged_src,
                            }
                            structure_input = merged_ci
                            _save_ppt_text_artifact(task_dir, f"step2_manual_content_refine{round_num}.md", merged_ci)
                            re_distill_evt = {
                                "step": 2.5, "status": "running",
                                "message": "基于补充资料重新整理信息...",
                                "data": {"manual_refine": True},
                            }
                            all_events.append(re_distill_evt)
                            yield f"data: {json.dumps(re_distill_evt, ensure_ascii=False)}\n\n"
                            distill_result = yield from stream_call(
                                lambda progress: _distill_collected_info(
                                    query, intent, merged_ci, on_progress=progress),
                                heartbeat_step=2.5, heartbeat_message="补充资料整理中",
                            )
                            distilled_info = distill_result.get("distilled_info", "")
                            _save_ppt_text_artifact(task_dir, f"step25_manual_content_refine{round_num}.md", distilled_info)
                            structure_input = distilled_info if distilled_info else merged_ci
                            re_plan_evt = {
                                "step": 3, "status": "refining",
                                "message": "基于补充证据重新规划结构...",
                                "data": {"manual_refine": True},
                            }
                            all_events.append(re_plan_evt)
                            yield f"data: {json.dumps(re_plan_evt, ensure_ascii=False)}\n\n"
                            structure_result = yield from stream_call(
                                lambda progress: _plan_ppt_structure(
                                    query, intent, structure_input, template, expected_slides,
                                    on_progress=progress,
                                    planning_feedback=f"用户审核意见：{feedback}。请据此优化结构并保留所有关键章节。"),
                                heartbeat_step=3, heartbeat_message="补充资料后重规划中",
                            )
                            actual_slide_count = _safe_int(structure_result.get("slide_count"), 0)
                            outline_full = structure_result.get("outline", "")
                            page_plans = _extract_ppt_page_plans(outline_full)
                            type_counts = {}
                            for p in page_plans:
                                pt = p.get("type") or "unknown"
                                type_counts[pt] = type_counts.get(pt, 0) + 1
                            source_marker_count = sum(p.get("source_count", 0) for p in page_plans)
                            structure_warnings = _build_structure_warnings(
                                actual_slide_count, expected_slides, min_required_slides, page_plans)
                            _save_ppt_text_artifact(
                                task_dir, f"step3_outline_manual_content_refine{round_num}.md", outline_full)
                            _save_ppt_step_artifact(task_dir, f"4_manual_content_replan{round_num}", "structure", {
                                "slide_count": actual_slide_count, "page_plans": page_plans,
                                "expected_slides": expected_slides,
                                "min_required_slides": min_required_slides,
                                "type_counts": type_counts,
                                "source_marker_count": source_marker_count,
                                "warnings": structure_warnings,
                                "user_feedback": feedback,
                            })
                            srch_done_evt = {
                                "step": 4, "status": "refining",
                                "message": f"人工审核后补充完成：实际{actual_slide_count}页，来源标记{source_marker_count}条，将重新审核。",
                                "data": {"slide_count": actual_slide_count, "source_marker_count": source_marker_count},
                            }
                            all_events.append(srch_done_evt)
                            yield f"data: {json.dumps(srch_done_evt, ensure_ascii=False)}\n\n"
                            current_outline = structure_result.get("outline", "")
                            title = _clean_ppt_report_title(query, current_outline)
                            re_review_evt = {
                                "step": 4, "status": "running",
                                "message": "补充资料后重新进入内容审核...",
                                "data": {"manual_refine": True},
                            }
                            all_events.append(re_review_evt)
                            yield f"data: {json.dumps(re_review_evt, ensure_ascii=False)}\n\n"
                            continue

                        # User provided feedback - refine outline
                        feedback = (user_decision.get("edited_content") or user_decision.get("feedback") or "").strip()
                        if not feedback:
                            feedback = "用户要求优化内容，请提升信息准确性和完整性。"
                        
                        refine_evt = {
                            "step": 4, "status": "refining",
                            "message": f"正在根据第{round_num+1}轮反馈修改大纲...",
                            "data": {"feedback": feedback}
                        }
                        yield f"data: {json.dumps(refine_evt, ensure_ascii=False)}\n\n"
                        
                        new_outline = _call_llm_raw(
                            "你是PPT内容策划师。请根据审核反馈修改PPT大纲。\n"
                            "不要输出解释或说明，只输出修改后的完整大纲内容。\n"
                            "统一使用内部DSL：[TYPE]、[KPI]、[summary]、[SOURCE]、[VERIFY]。\n"
                            "必须保留已有 Markdown 表格、[CHART]、[UNIT] 和可视化数据包。",
                            f"原始大纲：\n{current_outline[:PPT_REFINE_OUTLINE_INPUT_CHARS]}\n\n"
                            + "审核反馈：\n得分：" + str(score) + "/100\n问题：" + "\n".join(f"- {i}" for i in review_data.get("issues", [])) + "\n"
                            f"用户意见：{feedback}\n\n请根据反馈修改后输出完整大纲：",
                            temperature=0.2, max_tokens=LLM_MAX_TOKENS,
                        )
                        if new_outline:
                            regressed, reason = _outline_regressed_too_much(current_outline, new_outline)
                            if not regressed:
                                current_outline = new_outline
                            else:
                                _log(f"内容审核: 第{round_num+1}轮重写被拒绝：{reason}")
                    
                    review_result = {
                        "content": best_outline,
                        "review_history": review_history,
                        "final_score": best_score,
                        "latest_score": review_history[-1]["score"] if review_history else 0,
                        "best_round": 1,
                        "skipped": False,
                    }
                    step4_manual_evt = {
                        'step': 4, 'status': 'done',
                        'message': f'manual 模式内容审核完成：{len(review_history)}轮，最终{best_score}分',
                        'data': {'final_score': best_score, 'rounds_used': len(review_history)},
                    }
                    all_events.append(step4_manual_evt)
                    yield f"data: {json.dumps(step4_manual_evt, ensure_ascii=False)}\n\n"
                else:
                    if _is_pipeline_cancelled(pipeline_id):
                        yield f"data: {json.dumps({'step': 'error', 'message': '????? PPT ??', 'data': {'reason': 'user_cancelled', 'stage': 'step4'}}, ensure_ascii=False)}\n\n"
                        return
                    _start_step(4)
                    step4_running = {'step': 4, 'status': 'running', 'message': '正在审核内容质量...'}
                    _log(f"{log_prefix}Step4 start")
                    _write_log("ppt_pipeline_step", {"pipeline_id": pipeline_id, "step": 4, "status": "start", "manual": False})
                    yield f"data: {json.dumps(step4_running, ensure_ascii=False)}\n\n"
                    review_result = yield from stream_call(
                        lambda progress: _review_ppt_content(
                            title, structure_result["outline"], template,
                            max_content_rounds, on_progress=progress),
                        heartbeat_step=4, heartbeat_message="内容审核 · 评估中",
                        heartbeat_data={"max_rounds": max_content_rounds},
                    )

                final_outline = review_result["content"]
                _save_ppt_text_artifact(task_dir, "step4_final_outline.md", final_outline)
                _save_ppt_step_artifact(task_dir, 4, "review", {
                    "final_score": review_result.get("final_score", 0),
                    "latest_score": review_result.get("latest_score",
                                                     review_result.get("final_score", 0)),
                    "best_round": review_result.get("best_round", 0),
                    "rounds_used": len(review_result.get("review_history", [])),
                    "review_history": review_result.get("review_history", []),
                    "skipped": review_result.get("skipped", False),
                })

                # Build review summary
                review_summaries = []
                review_rounds = []
                for rh in review_result.get("review_history", []):
                    issues_str = ("; ".join(rh.get("issues", [])[:3])
                                  if rh.get("issues") else "无问题")
                    review_summaries.append(
                        f"轮次{rh['round']}: {rh['score']}分, "
                        f"{rh.get('action', 'pass')}, 问题: {issues_str}")
                    review_rounds.append({
                        "round": rh.get("round"), "score": rh.get("score"),
                        "action": rh.get("action", "pass"),
                        "issues": rh.get("issues", [])[:5],
                        "suggestions": rh.get("suggestions", [])[:5],
                    })

                review_score = float(review_result.get("final_score") or 0)
                latest_review_score = float(
                    review_result.get("latest_score", review_score) or 0)
                best_review_round = int(review_result.get("best_round") or 0)
                review_skipped_for_gate = bool(review_result.get("skipped", False))
                review_gate = {
                    "grade": "审核跳过" if review_skipped_for_gate else _review_grade(review_score),
                    "hard_block_score": PPT_REVIEW_HARD_BLOCK_SCORE,
                    "pass_score": PPT_REVIEW_PASS_SCORE,
                    "allow_low_confidence_draft": allow_low_confidence_draft,
                    "will_continue": (
                        True if review_skipped_for_gate else (
                            review_score >= PPT_REVIEW_HARD_BLOCK_SCORE
                            and (review_score >= PPT_REVIEW_PASS_SCORE
                                 or allow_low_confidence_draft)
                        )
                    ),
                }
                step4_evt = {
                    'step': 4, 'status': 'done',
                    'message': (f'内容审核完成：采用第{best_review_round}轮最佳稿 '
                                f'{review_score:g}分，最后一轮{latest_review_score:g}分，'
                                f'{review_gate["grade"]}（共'
                                f'{len(review_result["review_history"])}轮，'
                                f'正式门槛{PPT_REVIEW_PASS_SCORE}分）'),
                    'data': {
                        'final_score': review_score,
                        'latest_score': latest_review_score,
                        'best_round': best_review_round,
                        'grade': review_gate["grade"],
                        'rounds_used': len(review_result['review_history']),
                        'skipped': review_result.get('skipped', False),
                        'review_summaries': review_summaries,
                        'review_rounds': review_rounds,
                        'gate': review_gate,
                        'final_outline_artifact': os.path.join(
                            task_dir, "step4_final_outline.md"),
                    },
                }
                all_events.append(step4_evt)
                _end_step(4, step4_evt)
                _log(f"{log_prefix}Step4 done score={review_score} latest={latest_review_score} gate={review_gate.get('grade')}")
                _write_log("ppt_pipeline_step", {
                    "pipeline_id": pipeline_id,
                    "step": 4,
                    "status": "done",
                    "final_score": review_score,
                    "latest_score": latest_review_score,
                    "gate": review_gate,
                    "rounds_used": len(review_result.get("review_history", [])),
                    "final_outline_artifact": os.path.join(task_dir, "step4_final_outline.md"),
                })
                yield f"data: {json.dumps(step4_evt, ensure_ascii=False)}\n\n"

                for evt in pending_events:
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                pending_events.clear()

                # ── Targeted information refine (if review requests it) ──
                if ((not manual_mode)
                        and _review_needs_targeted_information(review_result)):
                    targeted_query = _build_targeted_info_query(
                        query, intent, review_result)
                    targeted_start_evt = {
                        'step': 2, 'status': 'targeted_refine',
                        'message': '内容审核要求补充信息：回到 Step 2 定向搜索证据与来源...',
                        'data': {
                            'reason': 'refine_information',
                            'targeted_query': targeted_query,
                            'previous_review_score': review_score,
                            'append_only': True,
                        },
                    }
                    all_events.append(targeted_start_evt)
                    yield f"data: {json.dumps(targeted_start_evt, ensure_ascii=False)}\n\n"

                    targeted_info_result = yield from stream_call(
                        lambda progress: _collect_ppt_information(
                            targeted_query, intent, project_ids, use_web_search,
                            min(max_search_rounds, 3), on_progress=progress,
                                    platforms=platforms),
                        heartbeat_step=2, heartbeat_message="定向补充信息中",
                    )
                    _save_ppt_step_artifact(task_dir, "2_refine1", "targeted_info", {
                        "query": targeted_query,
                        "round_details": targeted_info_result.get("round_details", []),
                        "sources": targeted_info_result.get("sources", []),
                        "quality_score": targeted_info_result.get("quality_score", 0),
                        "rounds_used": targeted_info_result.get("rounds_used", 0),
                        "collected_info_preview": targeted_info_result.get("collected_info", "")[:3000],
                    })

                    merged_collected_info = _merge_collected_info_append_only(
                        info_result.get("collected_info", ""),
                        targeted_info_result.get("collected_info", ""),
                        "Step 2 定向补充信息（refine_information）",
                    )
                    merged_sources = list(dict.fromkeys(
                        (info_result.get("sources", []) or [])
                        + (targeted_info_result.get("sources", []) or [])))
                    merged_round_details = (info_result.get("round_details", []) or []) + [
                        {**rd, "targeted_refine": True} for rd in (targeted_info_result.get("round_details", []) or [])
                    ]
                    info_result = {
                        **info_result,
                        "collected_info": merged_collected_info,
                        "collected_info_length": len(merged_collected_info),
                        "sources": merged_sources,
                        "round_details": merged_round_details,
                        "quality_score": max(
                            float(info_result.get("quality_score") or 0),
                            float(targeted_info_result.get("quality_score") or 0)),
                        "rounds_used": int(info_result.get("rounds_used") or 0) + int(targeted_info_result.get("rounds_used") or 0),
                    }
                    _save_ppt_text_artifact(
                        task_dir, "step2_collected_info_merged_refine1.md",
                        merged_collected_info)

                    # Re-distill
                    step25_refine_evt = {
                        'step': 2.5, 'status': 'running',
                        'message': '正在基于追加资料重新整理信息（保留旧资料，仅追加合并）...',
                        'data': {'append_only': True, 'merged_length': len(merged_collected_info)},
                    }
                    all_events.append(step25_refine_evt)
                    yield f"data: {json.dumps(step25_refine_evt, ensure_ascii=False)}\n\n"
                    distill_result = yield from stream_call(
                        lambda progress: _distill_collected_info(
                            query, intent, merged_collected_info, on_progress=progress),
                        heartbeat_step=2.5, heartbeat_message="追加资料整理中",
                    )
                    distilled_info = distill_result.get("distilled_info", "")
                    _save_ppt_text_artifact(
                        task_dir, "step25_distilled_info_refine1.md", distilled_info)
                    _save_ppt_step_artifact(task_dir, "2_5_refine1", "distill", {
                        "distilled": distill_result.get("distilled", False),
                        "length": distill_result.get("length", 0),
                        "original_length": len(merged_collected_info),
                        "append_only": True,
                        "diagnostics": distill_result.get("diagnostics", {}),
                        "preview": distilled_info[:2000],
                    })

                    # Re-plan structure
                    structure_input = (distilled_info if distilled_info
                                       else merged_collected_info)
                    structure_refine_evt = {
                        'step': 3, 'status': 'refining',
                        'message': '基于追加证据重新规划结构...',
                        'data': {'reason': 'refine_information', 'append_only': True},
                    }
                    all_events.append(structure_refine_evt)
                    yield f"data: {json.dumps(structure_refine_evt, ensure_ascii=False)}\n\n"
                    structure_result = yield from stream_call(
                        lambda progress: _plan_ppt_structure(
                            query, intent, structure_input, template, expected_slides,
                            on_progress=progress,
                            planning_feedback="上一轮内容审核要求补齐来源证据。"
                                              "请使用追加资料，为关键数字和benchmark"
                                              "保留[SOURCE]/[VERIFY]。"),
                        heartbeat_step=3, heartbeat_message="追加资料结构规划中",
                    )
                    actual_slide_count = _safe_int(structure_result.get("slide_count"), 0)
                    outline_full = structure_result.get("outline", "")
                    page_plans = _extract_ppt_page_plans(outline_full)
                    type_counts = {}
                    for page in page_plans:
                        page_type = page.get("type") or "unknown"
                        type_counts[page_type] = type_counts.get(page_type, 0) + 1
                    source_marker_count = sum(page.get("source_count", 0) for page in page_plans)
                    structure_warnings = _build_structure_warnings(actual_slide_count, expected_slides, min_required_slides, page_plans)
                    _save_ppt_text_artifact(
                        task_dir, "step3_outline_refine1.md", outline_full)
                    _save_ppt_step_artifact(task_dir, "3_refine1", "structure", {
                        "slide_count": structure_result.get("slide_count"),
                        "page_plans": page_plans,
                        "expected_slides": expected_slides,
                        "min_required_slides": min_required_slides,
                        "type_counts": type_counts,
                        "source_marker_count": source_marker_count,
                        "warnings": structure_warnings,
                        "outline_artifact": os.path.join(task_dir, "step3_outline_refine1.md"),
                    })

                    # Re-review
                    title = _clean_ppt_report_title(query, outline_full)
                    review_refine_evt = {
                        'step': 4, 'status': 'running',
                        'message': '追加资料后重新进入内容审核...',
                        'data': {'reason': 'refine_information'},
                    }
                    all_events.append(review_refine_evt)
                    yield f"data: {json.dumps(review_refine_evt, ensure_ascii=False)}\n\n"
                    review_result = yield from stream_call(
                        lambda progress: _review_ppt_content(
                            title, outline_full, template, max_content_rounds,
                            on_progress=progress),
                        heartbeat_step=4, heartbeat_message="追加资料后内容审核中",
                    )
                    final_outline = review_result["content"]
                    _save_ppt_text_artifact(
                        task_dir, "step4_final_outline.md", final_outline)
                    _save_ppt_text_artifact(
                        task_dir, "step4_final_outline_refine1.md", final_outline)

                    review_score = float(review_result.get("final_score") or 0)
                    latest_review_score = float(
                        review_result.get("latest_score", review_score) or 0)
                    best_review_round = int(review_result.get("best_round") or 0)
                    review_skipped_for_gate = bool(review_result.get("skipped", False))
                    review_gate = {
                        "grade": "审核跳过" if review_skipped_for_gate else _review_grade(review_score),
                        "hard_block_score": PPT_REVIEW_HARD_BLOCK_SCORE,
                        "pass_score": PPT_REVIEW_PASS_SCORE,
                        "allow_low_confidence_draft": allow_low_confidence_draft,
                        "will_continue": (
                            True if review_skipped_for_gate else (
                                review_score >= PPT_REVIEW_HARD_BLOCK_SCORE
                                and (review_score >= PPT_REVIEW_PASS_SCORE
                                     or allow_low_confidence_draft)
                            )
                        ),
                    }
                    step4_refine_done_evt = {
                        'step': 4, 'status': 'done',
                        'message': (f'追加资料后内容审核完成：采用第{best_review_round}轮'
                                    f'最佳稿 {review_score:g}分'),
                        'data': {
                            'final_score': review_score,
                            'latest_score': latest_review_score,
                            'best_round': best_review_round,
                            'grade': review_gate["grade"],
                            'rounds_used': len(
                                review_result.get('review_history', [])),
                            'skipped': review_result.get('skipped', False),
                            'gate': review_gate,
                            'refine_information_round': 1,
                        },
                    }
                    all_events.append(step4_refine_done_evt)
                    yield f"data: {json.dumps(step4_refine_done_evt, ensure_ascii=False)}\n\n"

                # ── Review gate checks ──
                review_skipped = bool(review_result.get("skipped", False))
                if review_skipped:
                    skip_reason = review_result.get("skip_reason") or "content_review_skipped"
                    finish_reason = review_result.get("finish_reason", "")
                    skip_message = "内容审核未完成：模型未返回可解析审核结果，已降级使用结构规划结果继续生成。"
                    skip_evt = {
                        "step": 4,
                        "status": "done",
                        "message": skip_message,
                        "data": {
                            "review_score": review_score,
                            "reason": skip_reason,
                            "finish_reason": finish_reason,
                            "degraded_continue": True,
                        },
                    }
                    all_events.append(skip_evt)
                    _write_log("ppt_pipeline_content_review_degraded_continue", {
                        "pipeline_id": pipeline_id,
                        "review_score": review_score,
                        "reason": skip_reason,
                        "finish_reason": finish_reason,
                        "manual": bool(manual_mode),
                        "final_outline_artifact": os.path.join(task_dir, "step4_final_outline.md"),
                    }, level="warning")
                    yield f"data: {json.dumps(skip_evt, ensure_ascii=False)}\n\n"

                elif review_score < PPT_REVIEW_HARD_BLOCK_SCORE:
                    block_message = (f"内容审核严重不通过：{review_score:g}分，"
                                     f"低于{PPT_REVIEW_HARD_BLOCK_SCORE}分硬门槛，"
                                     f"已停止生成。")
                    yield f"data: {json.dumps(_build_ppt_block_event(4, block_message, {'review_score': review_score, 'reason': 'content_review_failed'}), ensure_ascii=False)}\n\n"
                    yield f"data: {json.dumps({'step': 'error', 'message': block_message, 'data': {'reason': 'content_review_failed', 'review_score': review_score}}, ensure_ascii=False)}\n\n"
                    return

                if ((not review_skipped)
                        and review_score < PPT_REVIEW_PASS_SCORE
                        and not allow_low_confidence_draft):
                    # Ask user: continue as draft or stop
                    user_decision = yield from wait_for_resume("content_review_below_pass", {
                        "step": 4, "stage": "content_review_below_pass",
                        "message": f"内容审核得分 {review_score:g} 分，未达正式门槛 {PPT_REVIEW_PASS_SCORE} 分。是否以当前质量继续生成？",
                        "review_score": review_score,
                        "pass_score": PPT_REVIEW_PASS_SCORE,
                        "best_round": best_review_round,
                        "total_rounds": round_num + 1,
                    })
                    action = user_decision.get("action")
                    if action == "cancel":
                        cancel_msg = f"内容审核未达标（{review_score:g}分），用户选择终止。"
                        yield f"data: {json.dumps(_build_ppt_block_event(4, cancel_msg, {'review_score': review_score}), ensure_ascii=False)}\n\n"
                        yield f"data: {json.dumps({'step': 'error', 'message': cancel_msg, 'data': {'reason': 'user_cancelled_below_pass', 'review_score': review_score}}, ensure_ascii=False)}\n\n"
                        return
                    # User chose to continue — proceed with draft quality
                    _log(f"内容审核未达标（{review_score:g}分），用户选择继续以草稿质量生成")
                    _write_log("ppt_pipeline_content_review_below_pass_user_continue", {
                        "pipeline_id": pipeline_id,
                        "review_score": review_score,
                        "pass_score": PPT_REVIEW_PASS_SCORE,
                        "best_round": best_review_round,
                        "total_rounds": round_num + 1,
                    }, level="warning")

                # ── Step 5-6: Call ppt_executor to generate SVGs and export PPTX ──
                if ppt_executor is None:
                    yield f"data: {json.dumps({'step': 'error', 'message': 'ppt_executor 模块未加载，无法渲染 PPT', 'data': {'reason': 'executor_missing'}}, ensure_ascii=False)}\n\n"
                    return

                if _is_pipeline_cancelled(pipeline_id):
                    yield f"data: {json.dumps({'step': 'error', 'message': '????? PPT ??', 'data': {'reason': 'user_cancelled', 'stage': 'step5'}}, ensure_ascii=False)}\n\n"
                    return

                _start_step(5)
                # Inject SVG concurrency setting into intent for executor
                if "svg_max_workers" not in intent:
                    intent["svg_max_workers"] = svg_max_workers

                ppt_evt = {
                    'step': 5, 'status': 'running',
                    'message': 'Executor: 开始生成 SVG 并导出 PPTX...',
                    'data': {'task_dir': task_dir, 'review_score': review_score},
                }
                all_events.append(ppt_evt)
                yield f"data: {json.dumps(ppt_evt, ensure_ascii=False)}\n\n"

                executor_result = yield from stream_call(
                    lambda progress: ppt_executor.generate_ppt(
                        final_outline=final_outline,
                        intent=intent,
                        template=template,
                        task_dir=task_dir,
                        reference_style=reference_style,
                        on_progress=progress,
                        cancel_check=lambda: _is_pipeline_cancelled(pipeline_id),
                    ),
                    heartbeat_step=5,
                    heartbeat_message="Executor: rendering pages",
                )

                _save_ppt_pipeline_log(task_dir, all_events, {
                    "query": query, "template": template,
                    "workflow_mode": workflow_mode, "task_dir": task_dir,
                    "review_score": review_score,
                    "pipeline_id": pipeline_id,
                    "stage": "complete",
                    "executor_ok": executor_result.get("ok") if executor_result else False,
                    "executor_pptx_path": executor_result.get("pptx_path", "") if executor_result else "",
                    "executor_svg_count": executor_result.get("svg_count", 0) if executor_result else 0,
                })

                if executor_result and executor_result.get("ok"):
                    _end_step(5, {})  # Mark step 5 done
                    pptx_path = executor_result.get("pptx_path", "")
                    total_elapsed = round(time.time() - pipeline_start, 1)
                    timing_text = ", ".join(
                        f"Step{k}: {v['elapsed']}s"
                        for k, v in sorted(step_timings.items(), key=lambda x: str(x[0]))
                        if v.get("elapsed")
                    )
                    done_evt = {
                        'step': 6, 'status': 'done',
                        'message': f'PPT 生成完成！总耗时 {total_elapsed} 秒',
                        'data': {
                            'pptx_path': pptx_path,
                            'svg_count': executor_result.get("svg_count", 0),
                            'total_pages': executor_result.get("total_pages", 0),
                            'project_path': executor_result.get("project_path", task_dir),
                            'total_elapsed': total_elapsed,
                            'step_timings': {str(k): v for k, v in step_timings.items()},
                            'timing_summary': timing_text,
                        },
                    }
                else:
                    error_msg = (executor_result or {}).get("error", "Executor 返回空")
                    done_evt = {
                        'step': 'error',
                        'message': f'PPT 生成失败: {error_msg}',
                        'data': {'error': error_msg},
                    }

                all_events.append(done_evt)
                _write_log("ppt_pipeline_executor_done", {
                    "pipeline_id": pipeline_id,
                    "ok": executor_result.get("ok") if executor_result else False,
                })
                yield f"data: {json.dumps(done_evt, ensure_ascii=False)}\n\n"
                return

            except Exception as e:
                import traceback
                tb_str = traceback.format_exc()
                _log(f"PPT 流水线异常: {e}\n{tb_str}")
                _write_log("ppt_pipeline_error", {
                    "pipeline_id": pipeline_id,
                    "error_type": type(e).__name__,
                    "error": str(e),
                    "traceback": tb_str,
                }, level="error")
                error_data = {
                    'error_type': type(e).__name__,
                    'error_detail': str(e)[:500],
                }
                error_evt = {
                    'step': 'error',
                    'message': f'流水线异常: {type(e).__name__}: {str(e)[:300]}',
                    'data': error_data,
                }
                all_events.append(error_evt)
                yield f"data: {json.dumps(error_evt, ensure_ascii=False)}\n\n"
                try:
                    _save_ppt_pipeline_log(task_dir, all_events, {
                        "query": query, "template": template,
                        "error": str(e)[:500],
                        "error_type": type(e).__name__,
                    })
                except Exception:
                    pass

        return Response(generate(), mimetype='text/event-stream',
                        headers={'Cache-Control': 'no-cache',
                                 'X-Accel-Buffering': 'no'})

    @app.route("/api/v1/ppt-pipeline/resume-task", methods=["POST"])
    def ppt_pipeline_resume_task():
        """Resume an interrupted persisted task from the latest usable artifact.

        This resumes from the rendering phase when a task directory already has
        step4_final_outline.md or a step3 outline artifact.
        """
        data = request.get_json() or {}
        task_dir = _find_ppt_task_dir(
            task_dir=str(data.get("task_dir") or ""),
            pipeline_id=str(data.get("pipeline_id") or ""),
        )
        if not task_dir:
            return jsonify({"success": False, "message": "task_dir or pipeline_id not found"}), 404
        if ppt_executor is None:
            return jsonify({"success": False, "message": "ppt_executor module not loaded"}), 500

        request_artifact = _read_ppt_json_artifact(os.path.join(task_dir, "step0_request.json"), {})
        intent_artifact = _read_ppt_json_artifact(os.path.join(task_dir, "step1_intent.json"), {})
        intent = intent_artifact.get("intent") if isinstance(intent_artifact, dict) else {}
        if not isinstance(intent, dict):
            intent = {}
        # Resume path: carry over svg concurrency setting
        if "svg_max_workers" not in intent:
            intent["svg_max_workers"] = max(1, min(int(data.get("svg_max_workers", 8) or 8), 8))

        outline_path = _latest_ppt_artifact(task_dir, [
            "step4_final_outline*.md",
            "step3_outline*.md",
        ])
        final_outline = _read_ppt_text_artifact(outline_path) if outline_path else ""
        if not final_outline.strip():
            return jsonify({
                "success": False,
                "message": "No usable outline artifact found. Resume is supported after Step 3/4 has produced an outline.",
                "task_dir": task_dir,
            }), 400

        query = request_artifact.get("query") or _read_ppt_text_artifact(os.path.join(task_dir, "query.txt"))
        template = data.get("template") or request_artifact.get("template") or "default"
        task_name_parts = os.path.basename(task_dir).split("_")
        pipeline_id = (
            data.get("pipeline_id")
            or (task_name_parts[1] if len(task_name_parts) >= 2 else "")
            or str(uuid.uuid4())[:8]
        )
        log_prefix = f"[PPT:{pipeline_id}:resume] "

        def generate_resume():
            all_events = []
            started_at = time.time()

            def emit_event(evt):
                all_events.append(evt)
                return f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"

            yield emit_event({
                "step": 5,
                "status": "running",
                "message": f"正在从已保存任务继续渲染：{os.path.basename(task_dir)}",
                "data": {
                    "task_dir": task_dir,
                    "outline_artifact": outline_path,
                    "resume_from": "step4" if "step4_" in os.path.basename(outline_path) else "step3",
                },
            })
            _write_log("ppt_pipeline_resume_task_start", {
                "pipeline_id": pipeline_id,
                "task_dir": task_dir,
                "outline_artifact": outline_path,
                "template": template,
                "query": (query or "")[:200],
            })
            # Log LLM config for this pipeline run
            try:
                load_cfg = _refs.get("load_llm_config")
                if load_cfg:
                    cfg = load_cfg()
                    _write_log("ppt_pipeline_llm_config", {
                        "pipeline_id": pipeline_id,
                        "llm_url": cfg.get("llm_url", ""),
                        "llm_model": cfg.get("llm_model", ""),
                    })
            except Exception:
                pass

            event_queue = queue.Queue()
            result_box = {}

            def on_progress(evt):
                event_queue.put(evt)

            def worker():
                try:
                    result_box["value"] = ppt_executor.generate_ppt(
                        final_outline=final_outline,
                        intent=intent,
                        template=template,
                        task_dir=task_dir,
                        reference_style=None,
                        on_progress=on_progress,
                        cancel_check=lambda: _is_pipeline_cancelled(pipeline_id),
                    )
                except Exception as exc:
                    result_box["error"] = exc
                finally:
                    event_queue.put(None)

            thread = threading.Thread(target=worker, daemon=True)
            thread.start()
            last_hb = time.time()
            while True:
                try:
                    evt = event_queue.get(timeout=1.0)
                except queue.Empty:
                    if time.time() - last_hb >= 10:
                        elapsed = int(time.time() - started_at)
                        yield emit_event({
                            "step": 5,
                            "status": "running",
                            "message": f"继续渲染中，已用时{elapsed}秒",
                            "data": {"elapsed_seconds": elapsed, "heartbeat": True, "task_dir": task_dir},
                        })
                        last_hb = time.time()
                    continue
                if evt is None:
                    break
                yield emit_event(evt)

            thread.join(timeout=0.1)
            if "error" in result_box:
                error_msg = str(result_box["error"])
                _write_log("ppt_pipeline_resume_task_error", {
                    "pipeline_id": pipeline_id,
                    "task_dir": task_dir,
                    "error": error_msg[:500],
                }, level="error")
                yield emit_event({
                    "step": "error",
                    "message": f"继续任务失败: {error_msg[:300]}",
                    "data": {"task_dir": task_dir, "error": error_msg[:500]},
                })
                return

            executor_result = result_box.get("value") or {}
            total_elapsed = round(time.time() - started_at, 1)
            if executor_result.get("ok"):
                done_evt = {
                    "step": 6,
                    "status": "done",
                    "message": f"继续任务完成！总耗时 {total_elapsed} 秒",
                    "data": {
                        "task_dir": task_dir,
                        "pptx_path": executor_result.get("pptx_path", ""),
                        "svg_count": executor_result.get("svg_count", 0),
                        "total_pages": executor_result.get("total_pages", 0),
                        "project_path": executor_result.get("project_path", task_dir),
                        "total_elapsed": total_elapsed,
                        "resumed": True,
                    },
                }
            else:
                done_evt = {
                    "step": "error",
                    "message": f"继续任务失败: {executor_result.get('error', 'Executor 返回空')}",
                    "data": {"task_dir": task_dir, "executor_result": executor_result},
                }

            yield emit_event(done_evt)
            _save_ppt_pipeline_log(task_dir, all_events, {
                "query": query,
                "template": template,
                "workflow_mode": request_artifact.get("workflow_mode", ""),
                "task_dir": task_dir,
                "pipeline_id": pipeline_id,
                "stage": "resumed_complete" if executor_result.get("ok") else "resumed_error",
                "executor_ok": executor_result.get("ok"),
                "executor_pptx_path": executor_result.get("pptx_path", ""),
                "executor_svg_count": executor_result.get("svg_count", 0),
                "resumed": True,
            })

        return Response(generate_resume(), mimetype='text/event-stream',
                        headers={'Cache-Control': 'no-cache',
                                 'X-Accel-Buffering': 'no'})


    @app.route("/api/v1/ppt-pipeline/cancel", methods=["POST"])
    def ppt_pipeline_cancel():
        """Cancel a running pipeline. Frontend calls this when user clicks Cancel."""
        data = request.get_json() or {}
        pipeline_id = data.get("pipeline_id", "")
        if not pipeline_id:
            return jsonify({"success": False, "message": "pipeline_id required"}), 400
        _cancel_pipeline(pipeline_id)
        return jsonify({"success": True, "pipeline_id": pipeline_id})

    @app.route("/api/v1/ppt-pipeline/tasks", methods=["GET"])
    def ppt_pipeline_tasks():
        """List recent persisted PPT tasks and whether they can be resumed."""
        limit = _safe_int(request.args.get("limit"), 20)
        limit = max(1, min(limit, 50))
        tasks_base = _get_ppt_tasks_base_dir()
        tasks = []

        for name in os.listdir(tasks_base):
            task_dir = os.path.join(tasks_base, name)
            if not os.path.isdir(task_dir):
                continue

            request_artifact = _read_ppt_json_artifact(os.path.join(task_dir, "step0_request.json"), {})
            pipeline_log = _read_ppt_json_artifact(os.path.join(task_dir, "pipeline_log.json"), {})
            summary = pipeline_log.get("summary", {}) if isinstance(pipeline_log, dict) else {}
            outline_path = _latest_ppt_artifact(task_dir, [
                "step4_final_outline*.md",
                "step3_outline*.md",
            ])
            pptx_candidates = list(Path(task_dir).glob("*.pptx"))
            pptx_path = str(pptx_candidates[0]) if pptx_candidates else summary.get("executor_pptx_path", "")
            task_name_parts = name.split("_")
            pipeline_id = (
                request_artifact.get("pipeline_id")
                or summary.get("pipeline_id")
                or (task_name_parts[1] if len(task_name_parts) >= 2 else "")
            )
            query = request_artifact.get("query") or _read_ppt_text_artifact(os.path.join(task_dir, "query.txt"))
            resumable = bool(outline_path)
            if outline_path and summary.get("stage") in ("resumed_error", "error"):
                resumable = True
            tasks.append({
                "pipeline_id": pipeline_id,
                "task_dir": os.path.abspath(task_dir),
                "name": name,
                "query": (query or "")[:300],
                "template": request_artifact.get("template", "default"),
                "workflow_mode": request_artifact.get("workflow_mode", ""),
                "updated_at": datetime.fromtimestamp(os.path.getmtime(task_dir)).isoformat(),
                "resumable": resumable,
                "resume_from": ("step4" if outline_path and "step4_" in os.path.basename(outline_path)
                                else "step3" if outline_path else ""),
                "outline_artifact": outline_path,
                "pptx_path": pptx_path,
                "status": "completed" if pptx_path else "resumable" if resumable else "incomplete",
            })

        tasks.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
        return jsonify({"success": True, "data": tasks[:limit]})

    @app.route("/api/v1/ppt-pipeline/resume", methods=["POST"])
    def ppt_pipeline_resume():
        """Resume a paused pipeline (for manual mode)."""
        data = request.get_json() or {}
        pipeline_id = data.get("pipeline_id", "")
        action = data.get("action", "continue")
        edited_content = data.get("edited_content", "")
        feedback = data.get("feedback", "")

        if pipeline_id not in _pipeline_states:
            return jsonify({"success": False, "message": "pipeline not found"}), 404

        state = _pipeline_states[pipeline_id]
        state["action"] = action
        state["edited_content"] = edited_content
        state["feedback"] = feedback
        _write_log("ppt_pipeline_manual_resume_submitted", {
            "pipeline_id": pipeline_id,
            "stage": state.get("stage"),
            "action": action,
            "edited_content_length": len(edited_content or ""),
            "feedback_length": len(feedback or ""),
            "edited_content_preview": (edited_content or "")[:500],
            "feedback_preview": (feedback or "")[:500],
        })
        return jsonify({"success": True, "data": {
            "pipeline_id": pipeline_id, "action": action}})


# ===========================================================================
#  Public API: register_ppt_pipeline_routes
# ===========================================================================

def register_ppt_pipeline_routes(app, app_refs):
    """Register PPT pipeline routes on the Flask app.

    Args:
        app: Flask application instance.
        app_refs: Dict of references from app.py, including:
            - load_llm_config, _search_project, _do_web_search,
              _fetch_web_content, _get_current_project, _log, etc.
    """
    global ppt_executor
    _refs.update(app_refs)

    # Initialize ppt_executor with app references
    try:
        import ppt_executor as _executor_module
        _executor_module.init_executor(app_refs)
        ppt_executor = _executor_module
        _log("ppt_executor initialized successfully")
    except ImportError as e:
        _log(f"ppt_executor import failed: {e} — Chrys fallback will be used")
    except Exception as e:
        _log(f"ppt_executor init failed: {e}")

    # Provide _do_web_search_with_diagnostics if not already in refs
    if "_do_web_search_with_diagnostics" not in _refs:
        def _do_web_search_with_diagnostics_adapter(query, max_results=40):
            fn = _refs.get("_do_web_search")
            if not fn:
                return [], {"engine": "none", "raw_count": 0, "filtered_count": 0}
            try:
                results, engine, diagnostics = fn(query, max_results=max_results)
                return results or [], {
                    "engine": engine,
                    "raw_count": diagnostics.get("raw_count", len(results or [])),
                    "filtered_count": diagnostics.get("kept_count", len(results or [])),
                    "error": "",
                    "filter": {},
                }
            except Exception as e:
                _log(f"Web search adapter error: {e}")
                return [], {"engine": "error", "raw_count": 0,
                            "filtered_count": 0, "error": str(e)[:200]}
        _refs["_do_web_search_with_diagnostics"] = _do_web_search_with_diagnostics_adapter

    common_search_researcher.init_search_researcher(_refs)

    _register_routes(app)
    _log("PPT pipeline routes registered successfully.")
