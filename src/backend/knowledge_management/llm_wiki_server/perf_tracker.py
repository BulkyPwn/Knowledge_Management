"""
性能统计跟踪器 — 记录导入、查询等操作各步骤的耗时、模型名等数据

输出格式: JSONL (每行一个 JSON 对象)，保存在 logs/ 目录下，与 run.log 同目录。
文件名: perf_{session_id}.jsonl

用法:
    from perf_tracker import track_step

    with track_step("import_file_copy", model="deepseek-v4") as step:
        ... do work ...
        step.set_detail("file_count", 5)

    # 输出示例:
    # {"timestamp":"2026-06-17 10:30:01","operation":"import_file","step":"copy","duration_ms":123.4,"model":"deepseek-v4","details":{"file_count":5}}
"""

import json
import os
import time
import threading
from datetime import datetime
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Dict, Any


# ── 用户上下文（延迟导入避免循环依赖） ──
def _get_current_user():
    """读取当前用户名，与 user_context.py 逻辑一致"""
    try:
        app_state_file = os.path.join(os.path.expanduser("~"), ".SSSC_AI", "app_state.json")
        if not os.path.exists(app_state_file):
            return ""
        import json as _json
        with open(app_state_file, "r", encoding="utf-8") as f:
            state = _json.load(f)
        user_info = state.get("memoryUserInfo", {})
        return user_info.get("name", "") or state.get("memoryLoginConfig", {}).get("username", "")
    except Exception:
        return ""


# ── 日志目录：优先使用 LLM_WIKI_LOG_DIR 环境变量（与 run.log 同目录） ──
# - 打包模式：Electron 传入安装目录，与 run.log 同目录
# - 开发模式：回退到 app.py 同级 logs/ 目录
_ENV_LOG_DIR = os.environ.get("LLM_WIKI_LOG_DIR", "")
if _ENV_LOG_DIR:
    _LOGS_DIR = _ENV_LOG_DIR
else:
    _LOCAL_DIR = str(Path(__file__).resolve().parent)
    _LOGS_DIR = os.path.join(_LOCAL_DIR, "logs")
_PERF_SESSION_ID = datetime.now().strftime('%Y%m%d_%H%M%S')
_PERF_FILE = None
_PERF_LOCK = threading.Lock()

# 最大文件大小 2MB，自动轮换
_PERF_MAX_SIZE = 2 * 1024 * 1024
_PERF_FILE_PART = 0


def _get_perf_file():
    """获取当前性能日志文件路径，必要时轮换"""
    global _PERF_FILE, _PERF_FILE_PART
    os.makedirs(_LOGS_DIR, exist_ok=True)
    if _PERF_FILE is None:
        _PERF_FILE = os.path.join(_LOGS_DIR, f"perf_{_PERF_SESSION_ID}.jsonl")
        return _PERF_FILE
    try:
        if os.path.exists(_PERF_FILE) and os.path.getsize(_PERF_FILE) >= _PERF_MAX_SIZE:
            _PERF_FILE_PART += 1
            _PERF_FILE = os.path.join(_LOGS_DIR, f"perf_{_PERF_SESSION_ID}_{_PERF_FILE_PART:02d}.jsonl")
    except OSError:
        pass
    return _PERF_FILE


def record_step(
    operation: str,
    step: str,
    duration_ms: float,
    model: str = "",
    success: bool = True,
    error: str = "",
    **details,
):
    """直接记录一个步骤的耗时统计。

    参数:
        operation: 操作类型，如 "import_file", "import_folder", "chat_query", "agent_chat"
        step: 步骤名称，如 "copy", "mermaid_process", "llm_call", "search"
        duration_ms: 耗时（毫秒）
        model: 使用的模型名
        success: 是否成功
        error: 错误信息（失败时）
        **details: 额外详情（如 file_count, query_length 等）
    """
    entry = {
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3],
        "operation": operation,
        "step": step,
        "duration_ms": round(duration_ms, 2),
    }
    # 自动附带 user_id
    user = _get_current_user()
    if user:
        entry["user_id"] = user
    if model:
        entry["model"] = model
    if not success:
        entry["success"] = False
        if error:
            entry["error"] = error[:500]
    if details:
        entry["details"] = details

    with _PERF_LOCK:
        try:
            filepath = _get_perf_file()
            with open(filepath, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            pass  # 静默失败，不影响主流程


class _StepTracker:
    """步骤耗时追踪器，支持上下文管理器"""

    def __init__(self, operation: str, step: str, model: str = ""):
        self.operation = operation
        self.step = step
        self.model = model
        self._start = 0.0
        self._details: Dict[str, Any] = {}
        self._success = True
        self._error = ""

    def set_detail(self, key: str, value: Any):
        """设置额外详情"""
        self._details[key] = value

    def set_error(self, error: str):
        """标记失败"""
        self._success = False
        self._error = error

    def __enter__(self):
        self._start = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        duration_ms = (time.perf_counter() - self._start) * 1000
        if exc_type is not None:
            self._success = False
            self._error = str(exc_val)[:500]
        record_step(
            self.operation,
            self.step,
            duration_ms,
            model=self.model,
            success=self._success,
            error=self._error,
            **self._details,
        )
        # 不抑制异常
        return False


@contextmanager
def track_step(operation: str, step: str, model: str = ""):
    """上下文管理器，自动记录步骤耗时。

    用法:
        with track_step("import_file", "copy", model="deepseek-v4") as tracker:
            do_work()
            tracker.set_detail("file_size_mb", 5.2)
    """
    tracker = _StepTracker(operation, step, model)
    tracker.__enter__()
    try:
        yield tracker
    finally:
        tracker.__exit__(None, None, None)


# ============================================================
#  统计聚合 — 供可视化 API 使用
# ============================================================

def list_perf_files():
    """列出所有性能日志文件（按修改时间倒序）"""
    try:
        files = [f for f in os.listdir(_LOGS_DIR) if f.startswith("perf_") and f.endswith(".jsonl")]
    except OSError:
        return []
    out = []
    for fname in files:
        fpath = os.path.join(_LOGS_DIR, fname)
        try:
            st = os.stat(fpath)
            out.append({
                "name": fname,
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
            })
        except OSError:
            continue
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _iter_perf_records(files=None):
    """迭代读取 perf 日志记录"""
    if files is None:
        files = list_perf_files()
    for finfo in files:
        fpath = os.path.join(_LOGS_DIR, finfo["name"])
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def aggregate_perf_stats(operation_filter: str = ""):
    """聚合性能统计数据，按 operation + step 分组。

    返回:
        {
          "groups": [
            {"operation": "...", "step": "...", "count": N, "avg_ms": ..,
             "min_ms": .., "max_ms": .., "total_ms": .., "success_count": ..,
             "fail_count": .., "models": {...}},
            ...
          ],
          "totals": {"count": N, "success": N, "fail": N, "total_ms": ..},
          "operations": {"import_file": N, ...},
          "time_range": {"start": "...", "end": "..."}
        }
    """
    groups = {}  # key: (operation, step)
    totals = {"count": 0, "success": 0, "fail": 0, "total_ms": 0.0}
    operations = {}
    ts_min, ts_max = None, None

    for rec in _iter_perf_records():
        if operation_filter:
            if rec.get("operation") != operation_filter:
                continue
        op = rec.get("operation", "")
        step = rec.get("step", "")
        dur = float(rec.get("duration_ms", 0) or 0)
        success = rec.get("success", True)
        model = rec.get("model", "")
        ts = rec.get("timestamp", "")

        key = (op, step)
        g = groups.setdefault(key, {
            "operation": op, "step": step,
            "count": 0, "total_ms": 0.0, "min_ms": None,
            "max_ms": 0.0, "success_count": 0, "fail_count": 0,
            "models": {},
        })
        g["count"] += 1
        g["total_ms"] += dur
        g["min_ms"] = dur if g["min_ms"] is None else min(g["min_ms"], dur)
        g["max_ms"] = max(g["max_ms"], dur)
        if success:
            g["success_count"] += 1
        else:
            g["fail_count"] += 1
        if model:
            g["models"][model] = g["models"].get(model, 0) + 1

        totals["count"] += 1
        totals["total_ms"] += dur
        if success:
            totals["success"] += 1
        else:
            totals["fail"] += 1
        operations[op] = operations.get(op, 0) + 1

        if ts:
            ts_min = ts if ts_min is None or ts < ts_min else ts_min
            ts_max = ts if ts_max is None or ts > ts_max else ts_max

    group_list = []
    for g in groups.values():
        g["avg_ms"] = round(g["total_ms"] / g["count"], 2) if g["count"] else 0
        g["total_ms"] = round(g["total_ms"], 2)
        g["min_ms"] = round(g["min_ms"], 2) if g["min_ms"] is not None else 0
        g["max_ms"] = round(g["max_ms"], 2)
        group_list.append(g)
    # 按总耗时倒序
    group_list.sort(key=lambda x: x["total_ms"], reverse=True)
    totals["total_ms"] = round(totals["total_ms"], 2)

    return {
        "groups": group_list,
        "totals": totals,
        "operations": operations,
        "time_range": {"start": ts_min or "", "end": ts_max or ""},
    }


def recent_perf_records(limit: int = 200, operation_filter: str = ""):
    """读取最近的 N 条原始记录（按时间倒序）"""
    records = []
    for rec in _iter_perf_records():
        if operation_filter and rec.get("operation") != operation_filter:
            continue
        records.append(rec)
    records.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    return records[:limit]
