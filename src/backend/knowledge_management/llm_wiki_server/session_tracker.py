"""
会话跟踪模块 — 记录用户登录/登出事件，用于计算使用时长和活跃度

输出: 与性能日志同目录的 sessions_{session_id}.jsonl

使用方式:
    from session_tracker import record_login, record_logout

    record_login("zhangsan")
    record_logout("zhangsan")
"""

import json
import os
import time
import threading
from datetime import datetime
from pathlib import Path

from perf_tracker import _LOGS_DIR, _PERF_SESSION_ID

_SESSIONS_FILE = None
_SESSIONS_LOCK = threading.Lock()


def _get_sessions_file():
    global _SESSIONS_FILE
    if _SESSIONS_FILE is None:
        os.makedirs(_LOGS_DIR, exist_ok=True)
        _SESSIONS_FILE = os.path.join(_LOGS_DIR, f"sessions_{_PERF_SESSION_ID}.jsonl")
    return _SESSIONS_FILE


def record_login(user_id: str):
    """记录登录事件"""
    if not user_id:
        return
    entry = {
        "event": "login",
        "user_id": user_id,
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    }
    _write(entry)


def record_logout(user_id: str):
    """记录登出事件"""
    if not user_id:
        return
    entry = {
        "event": "logout",
        "user_id": user_id,
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    }
    _write(entry)


def _write(entry: dict):
    with _SESSIONS_LOCK:
        try:
            with open(_get_sessions_file(), "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            pass
