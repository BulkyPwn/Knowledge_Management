"""
用户上下文模块 — 从 Electron 前端写入的 app_state.json 中读取当前用户信息

数据流:
  Electron (App.jsx handleLogin) → writeMemoryFile → ~/.SSSC_AI/app_state.json
  Python 后端 → user_context.get_current_user() → 读取该文件

使用方式:
    from user_context import get_current_user_id, get_current_user_name

    uid = get_current_user_id()
    name = get_current_user_name()
"""

import json
import os
import time
import threading

_APP_STATE_FILE = os.path.join(os.path.expanduser("~"), ".SSSC_AI", "app_state.json")

# 缓存：避免每次写日志都读文件
_cache_lock = threading.Lock()
_cached_user_name = ""
_cached_ts = 0.0
_CACHE_TTL_SECONDS = 10  # 10 秒刷新一次


def _read_username_from_file():
    """从 app_state.json 读取用户名。优先 memoryUserInfo.name，其次 memoryLoginConfig.username。"""
    try:
        if not os.path.exists(_APP_STATE_FILE):
            return ""
        with open(_APP_STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
        user_info = state.get("memoryUserInfo", {})
        name = user_info.get("name", "")
        if name:
            return name
        login_cfg = state.get("memoryLoginConfig", {})
        return login_cfg.get("username", "")
    except (json.JSONDecodeError, IOError):
        return ""


def get_current_user_name():
    """获取当前登录用户名（带缓存），未登录返回空字符串"""
    global _cached_user_name, _cached_ts
    with _cache_lock:
        now = time.time()
        if now - _cached_ts < _CACHE_TTL_SECONDS:
            return _cached_user_name
        _cached_user_name = _read_username_from_file()
        _cached_ts = now
        return _cached_user_name


def get_current_user_id():
    """获取当前用户标识

    优先使用 Flask 请求上下文中通过 JWT 解析出的 g.current_user（emp_no）；
    无请求上下文或未认证时，降级读取本地 app_state.json（兼容过渡期）。
    """
    try:
        from flask import g, has_request_context
        if has_request_context() and getattr(g, "current_user", None):
            emp_no = g.current_user.get("emp_no") if isinstance(g.current_user, dict) else None
            if emp_no:
                return emp_no
    except Exception:
        pass
    return _read_username_from_file()


def flush_user_cache():
    """强制刷新用户缓存（登录/登出后调用）"""
    global _cached_user_name, _cached_ts
    with _cache_lock:
        _cached_user_name = _read_username_from_file()
        _cached_ts = time.time()
