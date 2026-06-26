from flask import Flask, request, jsonify, render_template, g
from flask_cors import CORS
import os
import json
import re
import time
import requests

# JWT 支持（用于本地签发与校验）
try:
    import jwt as pyjwt
except ImportError:
    pyjwt = None
    print("[WARN] PyJWT not installed, W3 OAuth login will be unavailable")
import threading
import traceback
import uuid
import hashlib
import logging
import html as html_lib
import subprocess
import shutil
import tempfile
from urllib.parse import urlparse, unquote
from pathlib import Path
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Optional

import math
import numpy as np
from ppt_pipeline import register_ppt_pipeline_routes
from concurrent.futures import ThreadPoolExecutor, as_completed

from llm_wiki_client import LLMWikiClient, set_import_progress, get_import_progress, clear_import_progress
from wiki_manager import WikiManager
from haiwen_client import HaiwenClient
from perf_tracker import track_step, record_step, aggregate_perf_stats, recent_perf_records, list_perf_files
from user_context import get_current_user_id, flush_user_cache
from session_tracker import record_login, record_logout

# 确保 knowledge_management 父目录在 sys.path 中（neo4j / common_kb_sync 均依赖此路径）
import sys as _sys
_kb_mgmt_path = str(Path(__file__).resolve().parent.parent)
if _kb_mgmt_path not in _sys.path:
    _sys.path.insert(0, _kb_mgmt_path)

# 导入公共知识库同步模块
try:
    from common_kb_sync import (
        check_local_kb,
        check_server_reachable,
        check_server_auth,
        download_directory,
        download_selected_items,
        list_remote_tree,
        run_full_sync,
        load_config as load_common_kb_config,
        save_config as save_common_kb_config,
        list_servers,
        get_sync_progress,
        delete_server_config,
    )
    HAS_COMMON_KB_SYNC = True
except ImportError:
    HAS_COMMON_KB_SYNC = False

try:
    _neo4j_path = str(Path(__file__).resolve().parent.parent / "neo4j_integration")
    if _neo4j_path not in _sys.path:
        _sys.path.insert(0, _neo4j_path)
    from neo4j_integration.neo4j_routes import neo4j_bp as _neo4j_bp
    _HAS_NEO4J = True
except ImportError:
    _neo4j_bp = None
    _HAS_NEO4J = False

app = Flask(__name__)
CORS(app)

# ============================================================
#  OAuth 2.0 / JWT 配置（W3 统一认证）
# ============================================================

OAUTH_CONFIG = {
    "authorize_url": "https://login.huawei.com/oauth2/authorize",
    "token_url": "https://login.huawei.com/oauth2/token",
    "userinfo_url": "https://login.huawei.com/oauth2/userinfo",
}

# 数据目录（与下方 _get_data_dir 保持一致：{_LOCAL_DIR}/config）
_WIKI_SERVER_DATA_DIR = str(Path(__file__).resolve().parent / "config")
try:
    os.makedirs(_WIKI_SERVER_DATA_DIR, exist_ok=True)
except Exception:
    pass

# ---- JWT 密钥 ----
JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    _jwt_secret_file = os.path.join(_WIKI_SERVER_DATA_DIR, "jwt_secret.json")
    if os.path.exists(_jwt_secret_file):
        try:
            with open(_jwt_secret_file, "r", encoding="utf-8") as f:
                JWT_SECRET = json.load(f).get("secret")
        except Exception:
            JWT_SECRET = None
    if not JWT_SECRET:
        JWT_SECRET = os.urandom(64).hex()
        try:
            os.makedirs(os.path.dirname(_jwt_secret_file), exist_ok=True)
            with open(_jwt_secret_file, "w", encoding="utf-8") as f:
                json.dump({"secret": JWT_SECRET}, f)
        except Exception as e:
            print(f"[WARN] Failed to persist JWT secret: {e}")

JWT_EXPIRY_HOURS = 8
JWT_REFRESH_GRACE_HOURS = 1


def _read_oauth_client_id():
    """从 ~/.SSSC_AI/oauth_config.json 读取 client_id（用于 W3 token 校验）"""
    try:
        cfg_path = os.path.join(os.path.expanduser("~"), ".SSSC_AI", "oauth_config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                return json.load(f).get("client_id", "")
    except Exception:
        pass
    return ""


# ============================================================
#  日志系统配置
# ============================================================

# 设置控制台日志格式
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
_logger = logging.getLogger('wiki-server')

# 禁用 Flask/Werkzeug 正常 200 请求日志，仅打印非 200 状态
_werkzeug_logger = logging.getLogger('werkzeug')
class Non200Filter(logging.Filter):
    def filter(self, record):
        return '" 200 ' not in record.getMessage()
_werkzeug_logger.addFilter(Non200Filter())


def _log(msg: str, level: str = "info"):
    """控制台实时日志输出（用于调试和错误追踪）"""
    if level == "error":
        _logger.error(msg)
    elif level == "warning":
        _logger.warning(msg)
    else:
        _logger.info(msg)


if _HAS_NEO4J and _neo4j_bp is not None:
    app.register_blueprint(_neo4j_bp)

_LOCAL_DIR = str(Path(__file__).resolve().parent)

# 海问思答客户端（全局单例）
_haiwen_client = HaiwenClient()


def _get_active_base_dir():
    project = _get_current_project()
    if project and project.get("path"):
        return project["path"]
    raise RuntimeError("No active knowledge base project")


def _get_wiki_dir():
    return os.path.join(_get_active_base_dir(), "wiki")


def _get_raw_dir():
    return os.path.join(_get_active_base_dir(), "raw")


def _get_schema_dir():
    return os.path.join(_get_active_base_dir(), "schema")


def _get_logs_dir():
    p = os.path.join(_LOCAL_DIR, "logs")
    os.makedirs(p, exist_ok=True)
    return p


def _get_data_dir():
    p = os.path.join(_LOCAL_DIR, "config")
    os.makedirs(p, exist_ok=True)
    return p


def _get_wiki_manager():
    return WikiManager(_get_wiki_dir())


def _safe_kb_dir(fn):
    try:
        return fn()
    except RuntimeError:
        return None

LLM_WIKI_API_BASE = os.environ.get("LLM_WIKI_API_BASE", "http://127.0.0.1:19828")
LLM_WIKI_API_TOKEN = os.environ.get("LLM_WIKI_API_TOKEN")

client = LLMWikiClient(
    base_url=LLM_WIKI_API_BASE,
    token=LLM_WIKI_API_TOKEN,
)
client.set_data_dir(_get_data_dir())

_initial_token = LLM_WIKI_API_TOKEN
if not _initial_token:
    _token_file = os.path.join(_get_data_dir(), "backend_token.json")
    if os.path.exists(_token_file):
        try:
            with open(_token_file, "r", encoding="utf-8") as f:
                _saved = json.load(f)
            if _saved.get("token"):
                client.set_token(_saved["token"])
        except (json.JSONDecodeError, IOError):
            pass
# 同步 token 到 llm-wiki 后端 — 放在后台线程避免阻塞 Flask 启动
def _sync_token_to_backend():
    if not client.token:
        return
    try:
        app_token = client._read_app_state_token()
        if not app_token:
            client._write_token_to_app_state(client.token)
    except Exception:
        pass
    try:
        client.reload_llm_wiki_config()
    except Exception:
        pass

threading.Thread(target=_sync_token_to_backend, daemon=True).start()


def load_schema():
    schema_file = os.path.join(_get_schema_dir(), "schema.json")
    if os.path.exists(schema_file):
        with open(schema_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return get_default_schema()


def get_default_schema():
    return {
        "version": "1.0",
        "structure": {
            "raw": "Raw material storage directory, model read-only",
            "wiki": "Markdown pages, model read-write",
            "schema": "System configuration and rule definitions",
            "logs": "Operation log records",
            "data": "Persistent data directory",
        },
        "naming_convention": {
            "page_title": "Use PascalCase or kebab-case",
            "tags": "Use lowercase, hyphenated",
            "links": "Use [[Page Name]] format",
        },
        "workflow": ["ingest", "query", "lint", "search", "graph"],
        "maintenance": {
            "orphan_pages_check": "Weekly",
            "outdated_check": "Monthly",
            "weak_links_check": "Weekly",
        },
    }


# 日志会话管理：每次启动新建文件，单文件不超1MB，目录不超50个
_log_session_id = datetime.now().strftime('%Y%m%d_%H%M%S')
_log_current_file = None
_log_file_part = 0
_LOG_MAX_SIZE = 1 * 1024 * 1024  # 1MB
_LOG_MAX_FILES = 50

# 用户会话追踪：记录上次操作用户，用于检测登录/登出切换
_last_logged_user = ""


def _get_current_log_file():
    """获取当前日志文件路径，必要时轮换"""
    global _log_current_file, _log_file_part
    if _log_current_file is None:
        _log_current_file = os.path.join(_get_logs_dir(), f"{_log_session_id}.log")
        return _log_current_file
    try:
        if os.path.exists(_log_current_file) and os.path.getsize(_log_current_file) >= _LOG_MAX_SIZE:
            _log_file_part += 1
            _log_current_file = os.path.join(_get_logs_dir(), f"{_log_session_id}_{_log_file_part:02d}.log")
    except OSError:
        pass
    return _log_current_file


def _cleanup_old_logs():
    """清理旧日志文件，保留最新50个"""
    try:
        logs_dir = _get_logs_dir()
        if not os.path.isdir(logs_dir):
            return
        files = sorted(
            [f for f in os.listdir(logs_dir) if f.endswith('.log')],
            key=lambda x: os.path.getmtime(os.path.join(logs_dir, x)),
        )
        while len(files) > _LOG_MAX_FILES:
            old_file = files.pop(0)
            try:
                os.remove(os.path.join(logs_dir, old_file))
            except OSError:
                pass
    except Exception:
        pass


def write_log(action: str, details, level: str = "info"):
    """写入紧凑日志到文件，同时输出到控制台

    格式: YYYY-MM-DD HH:MM:SS action {details_json}
    - 每次启动程序新建日志文件（按启动时间命名）
    - 单文件超过1MB自动轮换
    - 目录超过50个文件自动清理最旧的
    - 自动附带 user_id（从 app_state.json 读取）
    """
    global _last_logged_user

    # 获取当前用户
    current_user = get_current_user_id()

    # 检测用户切换 → 记录登出/登录会话事件
    if current_user != _last_logged_user:
        if _last_logged_user:
            record_logout(_last_logged_user)
        if current_user:
            record_login(current_user)
        _last_logged_user = current_user

    # 将 user_id 注入 details
    if isinstance(details, dict):
        # 避免覆盖调用方显式传入的 user_id
        if "user_id" not in details:
            details = dict(details, user_id=current_user or "anonymous")
    else:
        details = {"value": str(details), "user_id": current_user or "anonymous"}

    log_file = _get_current_log_file()
    time_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    details_str = json.dumps(details, ensure_ascii=False) if isinstance(details, dict) else str(details)
    log_line = f"{time_str} {action} {details_str}"
    if level in ("error", "warning"):
        log_line = f"{time_str} [{level.upper()}] {action} {details_str}"
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(log_line + "\n")
        _cleanup_old_logs()
    except Exception as e:
        _log(f"写入日志文件失败: {e}", "error")

    # 同时输出到控制台
    if level == "error":
        _log(log_line, "error")
    elif level == "warning":
        _log(log_line, "warning")
    else:
        _log(log_line[:2000])


def safe_call_llm_wiki(func, *args, **kwargs):
    """安全调用 llm-wiki 后端。传入 _timeout=N 可临时覆盖 client.timeout（秒）。"""
    saved_timeout = None
    call_timeout = kwargs.pop('_timeout', None)
    if call_timeout is not None:
        saved_timeout = client.timeout
        client.timeout = call_timeout
    func_name = getattr(func, '__name__', str(func))
    try:
        return func(*args, **kwargs)
    except requests.ConnectionError as e:
        err_msg = f"Cannot connect to backend service ({LLM_WIKI_API_BASE}): {e}"
        _log(f"[{func_name}] {err_msg}", "error")
        return {"ok": False, "error": err_msg}
    except requests.Timeout as e:
        err_msg = f"Backend service request timeout ({LLM_WIKI_API_BASE}): {e}"
        _log(f"[{func_name}] {err_msg}", "error")
        return {"ok": False, "error": err_msg}
    except Exception as e:
        err_msg = f"{func_name} failed: {e}"
        _log(f"[{func_name}] {traceback.format_exc()}", "error")
        return {"ok": False, "error": str(e)}
    finally:
        if saved_timeout is not None:
            client.timeout = saved_timeout


def _get_current_project() -> Optional[dict]:
    result = safe_call_llm_wiki(client.list_projects)
    if not result.get("ok", True):
        return None
    projects = result.get("projects", [])
    current = result.get("currentProject")
    if current:
        return current
    if projects:
        return projects[0]
    return None


def _get_project_names_by_ids(project_ids: list) -> dict:
    """根据 project_id 列表查找对应的项目名称"""
    result = safe_call_llm_wiki(client.list_projects)
    name_map = {}
    if result.get("ok"):
        for p in result.get("projects", []):
            pid = p.get("id", "")
            if pid in project_ids:
                name_map[pid] = p.get("name", pid)
    # 对于未查到的 id，直接使用 id 作为名称
    for pid in project_ids:
        if pid not in name_map:
            name_map[pid] = pid
    return name_map


def _get_project_wiki_dir(project_path: str) -> str:
    return os.path.join(project_path, "wiki")


def _get_project_sources_dir(project_path: str) -> str:
    return os.path.join(project_path, "raw", "sources")


def _find_project_id_by_path(project_path: str) -> Optional[str]:
    norm = os.path.abspath(project_path).replace("\\", "/")
    result = safe_call_llm_wiki(client.list_projects)
    if result.get("ok"):
        for p in result.get("projects", []):
            pp = (p.get("path", "") or "").replace("\\", "/")
            if pp and norm.startswith(pp.rstrip("/") + "/") or norm == pp.rstrip("/"):
                return p.get("id")
    local_id = client._read_project_id_file(project_path)
    if local_id:
        return local_id
    return None


# ── 后台 rescan 状态追踪 ──────────────────────────────────────
# key = normpath(project_path), value = {"status": "running"|"done"|"error", "started_at": float, "error": str|None, "ended_at": float|None}
_bg_rescan_states: dict[str, dict] = {}
_bg_rescan_lock = threading.Lock()


def _try_rescan_project(project_path: str, background: bool = False) -> dict:
    """触发 KMA 后端 rescan。

    background=False（默认）：同步阻塞，带重试和指数退避超时，直接返回结果。
    background=True：后台线程执行，立即返回 triggered=True，前端通过 /rescan-progress 轮询进度和队列状态。
    """
    project_id = _find_project_id_by_path(project_path)
    if project_id is None:
        open_result = client.open_project_by_path(project_path)
        if open_result.get("ok") and open_result.get("project_id"):
            project_id = open_result["project_id"]
        else:
            return {"triggered": False, "reason": "project_not_found"}

    # 删除 files-snapshot.json，强制全量重建索引
    snapshot_file = os.path.join(project_path, ".llm-wiki", "files-snapshot.json")
    snapshot_deleted = False
    if os.path.exists(snapshot_file):
        try:
            os.remove(snapshot_file)
            snapshot_deleted = True
        except OSError:
            pass

    if background:
        norm_path = os.path.normpath(project_path).lower()
        now = time.time()
        with _bg_rescan_lock:
            _bg_rescan_states[norm_path] = {"status": "running", "started_at": now, "error": None, "ended_at": None}

        def _bg_rescan():
            try:
                last_error = None
                for attempt in range(3):
                    _timeout = 120 * (attempt + 1) if attempt < 2 else 300
                    rescan_result = safe_call_llm_wiki(client.rescan_sources, project_id, _timeout=_timeout)
                    if rescan_result.get("ok"):
                        with _bg_rescan_lock:
                            _bg_rescan_states[norm_path] = {"status": "done", "started_at": now, "error": None, "ended_at": time.time()}
                        _log(f"[_try_rescan_project bg] 项目 {project_id} rescan 完成，耗时 {time.time()-now:.1f}s", "info")
                        return
                    last_error = rescan_result.get("error", "rescan_failed")
                    err_lower = last_error.lower()
                    if "timeout" not in err_lower and "connect" not in err_lower:
                        break
                    if attempt < 2:
                        _log(f"[_try_rescan_project bg] 第 {attempt+1} 次重试({last_error})，等待 {1.5*(attempt+1)}s...", "warning")
                        time.sleep(1.5 * (attempt + 1))
                with _bg_rescan_lock:
                    _bg_rescan_states[norm_path] = {"status": "error", "started_at": now, "error": last_error, "ended_at": time.time()}
                _log(f"[_try_rescan_project bg] 项目 {project_id} rescan 失败: {last_error}", "warning")
            except Exception as e:
                with _bg_rescan_lock:
                    _bg_rescan_states[norm_path] = {"status": "error", "started_at": now, "error": str(e), "ended_at": time.time()}
                _log(f"[_try_rescan_project bg] 项目 {project_id} rescan 异常: {e}", "error")

        threading.Thread(target=_bg_rescan, daemon=True).start()
        return {"triggered": True, "project_id": project_id, "snapshot_deleted": snapshot_deleted, "background": True}

    # ── 同步模式（保留给需要等待结果的场景） ──
    last_error = None
    for attempt in range(3):
        _timeout = 120 * (attempt + 1) if attempt < 2 else 300
        rescan_result = safe_call_llm_wiki(client.rescan_sources, project_id, _timeout=_timeout)
        if rescan_result.get("ok"):
            return {"triggered": True, "project_id": project_id, "snapshot_deleted": snapshot_deleted, "attempts": attempt + 1}

        last_error = rescan_result.get("error", "rescan_failed")
        err_lower = last_error.lower()
        if "timeout" not in err_lower and "connect" not in err_lower:
            break
        if attempt < 2:
            _log(f"[_try_rescan_project] 第 {attempt + 1} 次 rescan 失败({last_error})，{1.5 * (attempt + 1)}s 后重试...", "warning")
            time.sleep(1.5 * (attempt + 1))

    return {"triggered": False, "reason": "rescan_failed", "error": last_error}


def _activate_project_by_path(project_path: str) -> dict:
    project_id = _find_project_id_by_path(project_path)
    if project_id is None:
        return {"activated": False, "reason": "project_not_found"}
    activate_result = safe_call_llm_wiki(client.activate_project, project_id)
    if activate_result.get("ok") is False:
        return {"activated": False, "reason": "activate_failed", "error": activate_result.get("error")}
    return {"activated": True, "project_id": project_id}


# ============================================================
#  Schema routes
# ============================================================


@app.route("/api/v1/server/schema", methods=["GET"])
def get_server_schema():
    schema = load_schema()
    return jsonify({"success": True, "data": schema})


@app.route("/api/v1/server/schema", methods=["PUT"])
def update_server_schema():
    data = request.get_json()
    schema_file = os.path.join(_get_schema_dir(), "schema.json")
    with open(schema_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    write_log("update_schema", data)
    return jsonify({"success": True, "message": "Schema updated"})


# ============================================================
#  Server health & config routes
# ============================================================


@app.route("/api/v1/server/health", methods=["GET"])
def server_health():
    """非阻塞健康检查：所有后端探测在线程池中并行执行，总超时 ~2s，避免 llm-wiki 未启动时卡住"""
    llm_wiki_health = {"ok": False, "error": "backend not reachable"}
    clip_status = {"ok": False, "error": "backend not reachable"}
    kb_base = None

    def _check_llm_wiki():
        return safe_call_llm_wiki(client.health, _timeout=2)

    def _check_clip():
        return safe_call_llm_wiki(lambda: client._clip_request("GET", "/status"), _timeout=2)

    def _check_kb_config():
        return _safe_kb_dir(_get_active_base_dir)

    executor = ThreadPoolExecutor(max_workers=3)
    future_llm = executor.submit(_check_llm_wiki)
    future_clip = executor.submit(_check_clip)
    future_config = executor.submit(_check_kb_config)
    try:
        llm_wiki_health = future_llm.result(timeout=2)
    except (FutureTimeoutError, Exception):
        pass
    try:
        clip_status = future_clip.result(timeout=2)
    except (FutureTimeoutError, Exception):
        pass
    try:
        kb_base = future_config.result(timeout=2)
    except (FutureTimeoutError, Exception):
        pass
    executor.shutdown(wait=False)

    wiki_dir = os.path.join(kb_base, "wiki") if kb_base else None
    raw_dir = os.path.join(kb_base, "raw") if kb_base else None
    schema_dir = os.path.join(kb_base, "schema") if kb_base else None

    auth_info = {}
    if llm_wiki_health.get("ok", True):
        auth_info = {
            "auth_required": llm_wiki_health.get("authRequired"),
            "auth_configured": llm_wiki_health.get("authConfigured"),
            "token_source": llm_wiki_health.get("tokenSource"),
        }
    return jsonify(
        {
            "success": True,
            "service": "llm_wiki_server",
            "llm_wiki_status": llm_wiki_health,
            "llm_wiki_auth": auth_info,
            "llm_wiki_base_url": LLM_WIKI_API_BASE,
            "clip_server_available": clip_status.get("ok", False),
            "config": {
                "wiki_dir": wiki_dir,
                "raw_dir": raw_dir,
                "schema_dir": schema_dir,
                "logs_dir": _get_logs_dir(),
            },
        }
    )


@app.route("/api/v1/server/config", methods=["GET"])
def server_config():
    llm_cfg = load_llm_config()
    return jsonify(
        {
            "success": True,
            "data": {
                "llm_wiki_api_base": LLM_WIKI_API_BASE,
                "wiki_dir": _safe_kb_dir(_get_wiki_dir),
                "raw_dir": _safe_kb_dir(_get_raw_dir),
                "schema_dir": _safe_kb_dir(_get_schema_dir),
                "logs_dir": _get_logs_dir(),
                "data_dir": _get_data_dir(),
                "llm_config": llm_cfg,
            },
        }
    )


# ============================================================
#  LLM config persistence
#  - 不再使用 llm_config.json，改为从用户主目录下的 models.json 读取
#  - models.json 中存储所有模型配置，knowledge_management.json 中记录当前选中的模型
# ============================================================

def _get_user_config_dir():
    """用户配置目录 ~/.SSSC_AI"""
    return os.path.join(os.path.expanduser("~"), ".SSSC_AI")


def _get_models_json_path():
    return os.path.join(_get_user_config_dir(), "models.json")


def _get_memory_file_path():
    return os.path.join(_get_user_config_dir(), "knowledge_management.json")


def _get_default_model_id():
    """从 models.json 读取默认模型 id"""
    models_path = _get_models_json_path()
    if os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("DEFAULT_MODEL_ID", "")
        except (json.JSONDecodeError, IOError):
            pass
    return ""


def _persist_selected_model_id(model_id: str) -> None:
    """将当前选中的模型 ID 写入 knowledge_management.json。
    前端 writeMemoryFileSync 在 renderer 进程中可能因 getFsRef() 返回 null 而失败，
    因此后端作为权威来源确保 selectedModelConfigId 被持久化。
    """
    memory_path = _get_memory_file_path()
    memory_dir = os.path.dirname(memory_path)
    try:
        os.makedirs(memory_dir, exist_ok=True)
        data = {}
        if os.path.exists(memory_path):
            try:
                with open(memory_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        data["selectedModelConfigId"] = model_id
        with open(memory_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        _log(f"_persist_selected_model_id: written model_id={model_id} to {memory_path}")
    except (IOError, OSError) as e:
        _log(f"_persist_selected_model_id failed: {e}", "error")


def load_llm_config() -> dict:
    """
    从用户主目录的 models.json 和 knowledge_management.json 读取当前选中的模型配置。
    每次都实时读取 JSON 文件，无缓存。
    """
    # 获取当前选中的模型 ID
    selected_id = _get_default_model_id()
    memory_path = _get_memory_file_path()
    memory_mid = ""
    if os.path.exists(memory_path):
        try:
            with open(memory_path, "r", encoding="utf-8") as f:
                memory = json.load(f)
            mid = memory.get("selectedModelConfigId")
            # 仅当 knowledge_management.json 中有非空 selectedModelConfigId 时才覆盖默认值
            # 否则保持使用 DEFAULT_MODEL_ID 作为回退
            if mid:
                selected_id = mid
                memory_mid = mid
        except (json.JSONDecodeError, IOError):
            pass

    _log(f"load_llm_config: default_model_id={_get_default_model_id()}, memory_mid={memory_mid}, resolved_id={selected_id}")

    # 从 models.json 中查找匹配的模型
    models_path = _get_models_json_path()
    if os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                models_data = json.load(f)
            models = models_data.get("MODELS", [])
            for m in models:
                if m.get("id") == selected_id:
                    result = {
                        "llm_url": m.get("url", ""),
                        "llm_api_key": m.get("apiKey", ""),
                        "llm_model": m.get("model", ""),
                        "llm_embedding_model": m.get("embeddingModel", ""),
                    }
                    _log(f"load_llm_config: matched id={selected_id} -> model={result['llm_model']}, url={result['llm_url'][:60]}")
                    return result
            # 未找到匹配模型，回退到第一个模型（记录警告）
            if models:
                _log(f"load_llm_config: selected model '{selected_id}' not found in {len(models)} models, falling back to first model '{models[0].get('id', '')}'", "warning")
                m = models[0]
                return {
                    "llm_url": m.get("url", ""),
                    "llm_api_key": m.get("apiKey", ""),
                    "llm_model": m.get("model", ""),
                    "llm_embedding_model": m.get("embeddingModel", ""),
                }
        except (json.JSONDecodeError, IOError) as e:
            _log(f"load_llm_config: failed to read models.json: {e}", "error")

    _log("load_llm_config: models.json not found, returning empty config", "warning")
    return {"llm_url": "", "llm_api_key": "", "llm_model": "", "llm_embedding_model": ""}


def save_llm_config(config: dict, selected_model_id: str = None) -> None:
    """
    将当前模型配置写回 models.json 中对应的模型条目。
    若传入 selected_model_id，则直接使用该 id（来自前端 selectModelConfig 的同步写入），
    否则从 knowledge_management.json 读取 selectedModelConfigId。
    """
    if selected_model_id:
        selected_id = selected_model_id
    else:
        selected_id = _get_default_model_id()
        memory_path = _get_memory_file_path()
        if os.path.exists(memory_path):
            try:
                with open(memory_path, "r", encoding="utf-8") as f:
                    memory = json.load(f)
                mid = memory.get("selectedModelConfigId")
                # 仅当 memory 中有非空 selectedModelConfigId 时才覆盖默认值
                if mid:
                    selected_id = mid
            except (json.JSONDecodeError, IOError):
                pass

    models_path = _get_models_json_path()
    models_data = {}
    if os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                models_data = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    models = models_data.get("MODELS", [])
    for m in models:
        if m.get("id") == selected_id:
            if "llm_url" in config:
                m["url"] = config["llm_url"]
            if "llm_api_key" in config:
                m["apiKey"] = config["llm_api_key"]
            if "llm_model" in config:
                m["model"] = config["llm_model"]
            if "llm_embedding_model" in config:
                m["embeddingModel"] = config["llm_embedding_model"]
            break

    models_data["MODELS"] = models
    os.makedirs(_get_user_config_dir(), exist_ok=True)
    with open(models_path, "w", encoding="utf-8") as f:
        json.dump(models_data, f, ensure_ascii=False, indent=2)


def build_chat_completions_url(base_url: str) -> str:
    """Build an OpenAI-compatible chat/completions URL.

    Volcengine Ark coding endpoints are rooted at /api/coding/v3 and must not
    receive an extra /v1 segment.
    """
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


@app.route("/api/v1/server/llm-config", methods=["GET"])
def get_llm_config():
    cfg = load_llm_config()
    return jsonify({"success": True, "data": cfg})


@app.route("/api/v1/server/llm-config", methods=["PUT"])
def update_llm_config():
    """
    三种调用模式：
    1. {selected_model_id, set_active: true}          — selectModelConfig：激活模型
    2. {selected_model_id, llm_url, llm_model, ...}   — saveLlmConfig：保存配置
    3. {} 或 {llm_url, llm_model, ...}（无 model_id）  — syncCurrentModelToKmaServer：同步到 app-state
    """
    data = request.get_json() or {}
    selected_model_id = data.pop("selected_model_id", None)
    set_active = data.pop("set_active", False)
    has_config = any(k in data for k in ("llm_url", "llm_api_key", "llm_model", "llm_embedding_model"))

    if set_active and selected_model_id:
        # 模式1：用户切换模型 — 仅持久化 ID，从 models.json 读取配置
        _log(f"update_llm_config: [activate] model_id={selected_model_id}")
        _persist_selected_model_id(selected_model_id)
        cfg = load_llm_config()
        _log(f"update_llm_config: [activate] loaded cfg -> model={cfg.get('llm_model','')}, url={cfg.get('llm_url','')[:60]}")
    elif selected_model_id and has_config:
        # 模式2：用户保存配置 — 更新 models.json 中对应条目
        _log(f"update_llm_config: [save] model_id={selected_model_id}, keys={list(data.keys())}")
        cfg = {
            "llm_url": data.get("llm_url", ""),
            "llm_api_key": data.get("llm_api_key", ""),
            "llm_model": data.get("llm_model", ""),
            "llm_embedding_model": data.get("llm_embedding_model", ""),
        }
        _log(f"update_llm_config: [save] cfg -> model={cfg['llm_model']}, url={cfg['llm_url'][:60]}")
        save_llm_config(cfg, selected_model_id=selected_model_id)
    elif has_config:
        # 模式3：仅同步到 app-state（syncCurrentModelToKmaServer 传入具体值）
        _log(f"update_llm_config: [sync-values] keys={list(data.keys())}")
        cfg = {
            "llm_url": data.get("llm_url", ""),
            "llm_api_key": data.get("llm_api_key", ""),
            "llm_model": data.get("llm_model", ""),
            "llm_embedding_model": data.get("llm_embedding_model", ""),
        }
        _log(f"update_llm_config: [sync-values] cfg -> model={cfg['llm_model']}, url={cfg['llm_url'][:60]}")
    else:
        # 模式3b：空请求 — 从 models.json 读取当前活跃模型，同步到 app-state
        _log("update_llm_config: [sync-active] loading current active model")
        cfg = load_llm_config()
        _log(f"update_llm_config: [sync-active] cfg -> model={cfg.get('llm_model','')}, url={cfg.get('llm_url','')[:60]}")

    sync_result = client.sync_llm_config_to_app_state(
        llm_url=cfg.get("llm_url", ""),
        llm_api_key=cfg.get("llm_api_key", ""),
        llm_model=cfg.get("llm_model", ""),
        llm_embedding_model=cfg.get("llm_embedding_model", ""),
    )
    _log(f"update_llm_config: sync_llm_config_to_app_state result: ok={sync_result.get('ok')}, error={sync_result.get('error', 'none')}")

    if sync_result.get("ok"):
        reload_result = client.reload_llm_wiki_config()
        _log(f"update_llm_config: reload_llm_wiki_config result: ok={reload_result.get('ok')}, error={reload_result.get('error', 'none')}")
    else:
        reload_result = {"ok": False, "error": "skipped (sync failed)"}
        _log(f"update_llm_config: reload skipped because sync failed")

    write_log("update_llm_config", {
        "keys": list(data.keys()),
        "app_state_synced": sync_result.get("ok", False),
        "config_reloaded": reload_result.get("ok", False),
        "sync_error": sync_result.get("error"),
        "reload_error": reload_result.get("error"),
    })

    return jsonify({
        "success": True,
        "data": {
            **cfg,
            "app_state_synced": sync_result.get("ok", False),
            "config_reloaded": reload_result.get("ok", False),
        },
    })


@app.route("/api/v1/server/llm-config/app-state", methods=["GET"])
def get_app_state_llm_config():
    result = client.read_llm_config_from_app_state()
    if result.get("ok"):
        return jsonify({"success": True, "data": result})
    else:
        return jsonify({"success": False, "error": result.get("error", "Unknown error")})


# ============================================================
#  Backend lifecycle management (start / stop / status)
# ============================================================


@app.route("/api/v1/server/backend/status", methods=["GET"])
def backend_status():
    result = client.backend_status()
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/server/backend/start", methods=["POST"])
def start_backend():
    result = client.start_backend()
    write_log("start_backend", {"action": result.get("action"), "ok": result.get("ok")})
    return jsonify({"success": result.get("ok", False), "data": result})


# ============================================================
#  LLM Wiki proxy routes (forwarding to Rust API)
# ============================================================


@app.route("/api/v1/projects", methods=["GET"])
def list_projects():
    result = safe_call_llm_wiki(client.list_projects)
    if result.get("ok") is False:
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 502

    projects = result.get("projects", [])
    filtered = []
    removed = []

    for p in projects:
        proj_path = p.get("path", "")
        if proj_path and os.path.isdir(proj_path):
            filtered.append(p)
        else:
            removed.append({"id": p.get("id"), "name": p.get("name"), "path": proj_path})

    result["projects"] = filtered

    if removed:
        result["_removed"] = removed
        print(f"[projects] Filtered out {len(removed)} projects with nonexistent directories:")
        for r in removed:
            print(f"  - {r['name']} ({r['path']})")

    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/<string:project_id>/files", methods=["GET"])
def list_project_files(project_id: str):
    root = request.args.get("root", "wiki")
    recursive = request.args.get("recursive", "true").lower() == "true"
    max_files = int(request.args.get("maxFiles", 2000))
    result = safe_call_llm_wiki(
        client.list_files,
        project_id,
        root=root,
        recursive=recursive,
        max_files=max_files,
    )
    if result.get("ok") is False:
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 502
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/<string:project_id>/files/content", methods=["GET"])
def get_project_file_content(project_id: str):
    path = request.args.get("path")
    if not path:
        return jsonify({"success": False, "message": "Missing path parameter"}), 400
    result = safe_call_llm_wiki(client.get_file_content, project_id, path)
    if result.get("ok") is False:
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 502
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/<string:project_id>/search", methods=["POST"])
def search_project(project_id: str):
    data = request.get_json() or {}
    query = data.get("query", "")
    top_k = data.get("topK", 10)
    include_content = data.get("includeContent", False)
    if not query:
        return jsonify({"success": False, "message": "query is required"}), 400
    result = safe_call_llm_wiki(
        client.search, project_id, query, top_k=top_k, include_content=include_content
    )
    if result.get("ok") is False:
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 502
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/<string:project_id>/graph", methods=["GET"])
def get_project_graph(project_id: str):
    q = request.args.get("q")
    node_type = request.args.get("nodeType")
    limit = int(request.args.get("limit", 200))
    result = safe_call_llm_wiki(client.get_graph, project_id, q=q, node_type=node_type, limit=limit)
    print(result)
    if result.get("ok") is False:
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 502
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/<string:project_id>/sources/rescan", methods=["POST"])
def rescan_project_sources(project_id: str):
    result = safe_call_llm_wiki(client.rescan_sources, project_id)
    if result.get("ok") is False:
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 502
    return jsonify({"success": True, "data": result})


# ============================================================
#  Aggregated / Convenience routes
# ============================================================


@app.route("/api/v1/projects/<string:project_id>/overview", methods=["GET"])
def project_overview(project_id: str):
    projects_result = safe_call_llm_wiki(client.list_projects)
    if projects_result.get("ok") is False:
        return jsonify(
            {"success": False, "message": projects_result.get("error", "Unknown error")}
        ), 502

    project = None
    for p in projects_result.get("projects", []):
        if p.get("id") == project_id or p.get("path") == project_id:
            project = p
            break
    if project is None:
        return jsonify({"success": False, "message": f"Unknown project: {project_id}"}), 404

    files_result = safe_call_llm_wiki(client.list_files, project_id, root="wiki")
    graph_result = safe_call_llm_wiki(client.get_graph, project_id, limit=50)

    sources_files = safe_call_llm_wiki(client.list_files, project_id, root="sources")
    sources_count = len(sources_files.get("files", []))

    wiki_files = files_result.get("files", [])
    wiki_pages_count = sum(
        1 for f in wiki_files if not f.get("isDir", False) and f.get("name", "").endswith(".md")
    )

    graph_nodes_count = len(graph_result.get("nodes", []))
    graph_edges_count = len(graph_result.get("edges", []))

    return jsonify(
        {
            "success": True,
            "data": {
                "project": project,
                "stats": {
                    "wiki_pages": wiki_pages_count,
                    "source_files": sources_count,
                    "graph_nodes": graph_nodes_count,
                    "graph_edges": graph_edges_count,
                },
            },
        }
    )


# ============================================================
#  Wiki page management routes (local wiki dir)
# ============================================================


@app.route("/api/v1/wiki/pages", methods=["GET"])
def list_wiki_pages():
    pages = _get_wiki_manager().list_pages()
    return jsonify({"success": True, "data": pages, "total": len(pages)})


@app.route("/api/v1/wiki/page/<string:title>", methods=["GET"])
def get_wiki_page(title: str):
    page = _get_wiki_manager().get_page(title)
    if page is None:
        return jsonify({"success": False, "message": "Page not found"}), 404
    return jsonify({"success": True, "data": page})


@app.route("/api/v1/wiki/page", methods=["POST"])
def create_wiki_page():
    data = request.get_json() or {}
    title = data.get("title")
    content = data.get("content", "")
    if not title:
        return jsonify({"success": False, "message": "title is required"}), 400
    filepath = os.path.join(_get_wiki_dir(), f"{title}.md")
    if os.path.exists(filepath):
        return jsonify({"success": False, "message": "Page already exists"}), 409
    result = _get_wiki_manager().create_page(title, content)
    write_log("create_page", {"title": title})
    return jsonify({"success": True, "data": result}), 201


@app.route("/api/v1/wiki/page/<string:title>", methods=["PUT"])
def update_wiki_page(title: str):
    data = request.get_json() or {}
    content = data.get("content", "")
    result = _get_wiki_manager().update_page(title, content)
    if not result.get("success"):
        return jsonify(result), 404
    write_log("update_page", {"title": title})
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/wiki/page/<string:title>", methods=["DELETE"])
def delete_wiki_page(title: str):
    result = _get_wiki_manager().delete_page(title)
    if not result.get("success"):
        return jsonify(result), 404
    write_log("delete_page", {"title": title})
    return jsonify({"success": True, "data": result})


# ============================================================
#  Wiki lint routes
# ============================================================


@app.route("/api/v1/wiki/lint", methods=["GET"])
def lint_wiki():
    issues = _get_wiki_manager().lint()
    write_log("lint", issues)
    return jsonify({"success": True, "data": issues})


# ============================================================
#  Wiki search routes (local)
# ============================================================


@app.route("/api/v1/wiki/search", methods=["GET"])
def search_wiki_pages():
    query = request.args.get("q", "")
    if not query:
        return jsonify({"success": False, "message": "q parameter is required"}), 400
    results = _get_wiki_manager().search_pages(query)
    write_log("search_wiki", {"query": query, "results_count": len(results)})
    return jsonify({"success": True, "data": results, "total": len(results)})


# ============================================================
#  Wiki graph routes (local)
# ============================================================


@app.route("/api/v1/wiki/graph", methods=["GET"])
def get_wiki_graph():
    graph = _get_wiki_manager().build_graph()
    return jsonify({"success": True, "data": graph})


# ============================================================
#  Raw files routes
# ============================================================


@app.route("/api/v1/raw/upload", methods=["POST"])
def upload_raw_file():
    if "file" not in request.files:
        return jsonify({"success": False, "message": "No file uploaded"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "message": "Empty filename"}), 400
    raw_dir = _get_raw_dir()
    filepath = os.path.join(raw_dir, file.filename)
    file.save(filepath)
    metadata = {
        "filename": file.filename,
        "size": os.path.getsize(filepath),
        "uploaded_at": datetime.now().isoformat(),
    }
    write_log("upload_raw", metadata)
    return jsonify({"success": True, "data": metadata})


@app.route("/api/v1/raw/list", methods=["GET"])
def list_raw_files():
    files = []
    raw_dir = _get_raw_dir()
    if not os.path.isdir(raw_dir):
        return jsonify({"success": True, "data": files})
    for item in os.listdir(raw_dir):
        item_path = os.path.join(raw_dir, item)
        if os.path.isfile(item_path):
            stat = os.stat(item_path)
            files.append(
                {
                    "name": item,
                    "size": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                }
            )
    return jsonify({"success": True, "data": files})


# ============================================================
#  Project wiki management (access project wiki via project id)
# ============================================================


@app.route("/api/v1/projects/<string:project_id>/wiki/pages", methods=["GET"])
def list_project_wiki_pages(project_id: str):
    project = _get_current_project()
    if project is None:
        return jsonify({"success": False, "message": "Could not resolve project"}), 404

    wiki_path = _get_project_wiki_dir(project.get("path", ""))
    if not wiki_path or not os.path.exists(wiki_path):
        return jsonify({"success": False, "message": "Wiki directory not found"}), 404

    proj_wiki_mgr = WikiManager(wiki_path)
    pages = proj_wiki_mgr.list_pages()
    return jsonify({"success": True, "data": pages, "total": len(pages)})


@app.route(
    "/api/v1/projects/<string:project_id>/wiki/page/<string:title>", methods=["GET"]
)
def get_project_wiki_page(project_id: str, title: str):
    project = _get_current_project()
    if project is None:
        return jsonify({"success": False, "message": "Could not resolve project"}), 404

    wiki_path = _get_project_wiki_dir(project.get("path", ""))
    proj_wiki_mgr = WikiManager(wiki_path)
    page = proj_wiki_mgr.get_page(title)
    if page is None:
        return jsonify({"success": False, "message": "Page not found"}), 404
    return jsonify({"success": True, "data": page})


@app.route(
    "/api/v1/projects/<string:project_id>/wiki/page/<string:title>", methods=["PUT"]
)
def update_project_wiki_page(project_id: str, title: str):
    data = request.get_json() or {}
    content = data.get("content", "")
    project = _get_current_project()
    if project is None:
        return jsonify({"success": False, "message": "Could not resolve project"}), 404

    wiki_path = _get_project_wiki_dir(project.get("path", ""))
    proj_wiki_mgr = WikiManager(wiki_path)
    result = proj_wiki_mgr.update_page(title, content)
    if not result.get("success"):
        return jsonify(result), 404
    write_log("update_project_wiki_page", {"project_id": project_id, "title": title})
    return jsonify({"success": True, "data": result})


@app.route(
    "/api/v1/projects/<string:project_id>/wiki/page/<string:title>",
    methods=["DELETE"],
)
def delete_project_wiki_page(project_id: str, title: str):
    project = _get_current_project()
    if project is None:
        return jsonify({"success": False, "message": "Could not resolve project"}), 404

    wiki_path = _get_project_wiki_dir(project.get("path", ""))
    proj_wiki_mgr = WikiManager(wiki_path)
    result = proj_wiki_mgr.delete_page(title)
    if not result.get("success"):
        return jsonify(result), 404
    write_log("delete_project_wiki_page", {"project_id": project_id, "title": title})
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/<string:project_id>/wiki/lint", methods=["GET"])
def lint_project_wiki(project_id: str):
    project = _get_current_project()
    if project is None:
        return jsonify({"success": False, "message": "Could not resolve project"}), 404

    wiki_path = _get_project_wiki_dir(project.get("path", ""))
    proj_wiki_mgr = WikiManager(wiki_path)
    issues = proj_wiki_mgr.lint()
    write_log("lint_project_wiki", issues)
    return jsonify({"success": True, "data": issues})


@app.route("/api/v1/projects/<string:project_id>/wiki/graph", methods=["GET"])
def get_project_wiki_graph(project_id: str):
    project = _get_current_project()
    if project is None:
        return jsonify({"success": False, "message": "Could not resolve project"}), 404

    wiki_path = _get_project_wiki_dir(project.get("path", ""))
    proj_wiki_mgr = WikiManager(wiki_path)
    graph = proj_wiki_mgr.build_graph()
    return jsonify({"success": True, "data": graph})


# ============================================================
#  Multi-project combined routes
# ============================================================


@app.route("/api/v1/search", methods=["POST"])
def search_all_projects():
    data = request.get_json() or {}
    query = data.get("query", "")
    top_k = data.get("topK", 10)
    if not query:
        return jsonify({"success": False, "message": "query is required"}), 400

    projects_result = safe_call_llm_wiki(client.list_projects)
    if projects_result.get("ok") is False:
        return jsonify(
            {"success": False, "message": projects_result.get("error", "Unknown error")}
        ), 502

    projects = projects_result.get("projects", [])
    all_results = []
    for p in projects:
        pid = p.get("id", "")
        search_result = safe_call_llm_wiki(
            client.search, pid, query, top_k=top_k, include_content=False
        )
        if search_result.get("ok") is False:
            continue
        if search_result.get("results"):
            all_results.append(
                {
                    "projectId": pid,
                    "projectName": p.get("name", pid),
                    "results": search_result["results"],
                }
            )
    write_log("search_all_projects", {"query": query, "projects_searched": len(projects)})
    return jsonify({"success": True, "data": all_results, "total": len(all_results)})


# ============================================================
#  UI routes
# ============================================================


@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


# ============================================================
#  Knowledge base management routes (file-system level)
# ============================================================


@app.route("/api/v1/projects/create", methods=["POST"])
def create_project():
    data = request.get_json() or {}
    name = data.get("name")
    path = data.get("path")
    if not name or not path:
        return jsonify({"success": False, "message": "name and path are required"}), 400
    result = client.create_project(name, path)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    write_log("create_project", {"name": name, "path": path})
    reg = result.get("backend_registration", {})
    if reg.get("registered"):
        write_log("project_registered", {"path": result.get("path"), "project_id": result.get("project_id")})
    elif reg:
        write_log("project_registration_skipped", {"reason": reg})
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/open", methods=["POST"])
def open_project():
    data = request.get_json() or {}
    path = data.get("path")
    if not path:
        return jsonify({"success": False, "message": "path is required"}), 400
    result = client.open_project_by_path(path)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    write_log("open_project", {"path": path})
    reg = result.get("backend_registration", {})
    if reg.get("registered"):
        write_log("project_registered", {"path": result.get("path")})
    elif reg:
        write_log("project_registration_skipped", {"reason": reg})
    activate = result.get("activate_result")
    if activate:
        if activate.get("ok"):
            write_log("project_activate", {
                "project_id": result.get("project_id"),
                "ok": True,
            })
        else:
            write_log("project_activate_failed", {
                "project_id": result.get("project_id"),
                "error": activate.get("error", str(activate)),
                "body": activate.get("body", ""),
            }, "warning")
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/delete", methods=["POST"])
def delete_project():
    """删除项目（deep=true 时同时删除磁盘文件，否则仅取消注册）"""
    data = request.get_json() or {}
    project_path = data.get("project_path")
    deep = data.get("deep", False)
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400
    result = client.delete_project_by_path(project_path, deep=deep)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    write_log("delete_project", {"project_path": project_path, "deep": deep})
    return jsonify({"success": True, "data": result})


# ============================================================
#  Wiki page listing (file-system level, no auth required)
# ============================================================


@app.route("/api/v1/projects/wiki/summary", methods=["GET"])
def list_project_wiki_summary():
    import os
    project_path = request.args.get("project_path")
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400

    wiki_dir = os.path.join(project_path, "wiki")
    if not os.path.isdir(wiki_dir):
        return jsonify({"success": True, "data": {"pages": [], "stats": {}, "wiki_dir": wiki_dir}})

    pages = []
    stats = {}
    for root, dirs, files in os.walk(wiki_dir):
        for fname in sorted(files):
            if fname.endswith(".md"):
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, wiki_dir).replace("\\", "/")
                parts = rel.split("/")
                category = parts[0] if len(parts) > 1 else "root"

                st = os.stat(fpath)
                size = st.st_size
                mtime = st.st_mtime

                frontmatter = {}
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read(4096)
                    if content.startswith("---"):
                        end = content.find("---", 3)
                        if end > 0:
                            fm_text = content[3:end].strip()
                            for line in fm_text.split("\n"):
                                line = line.strip()
                                if ":" in line:
                                    k, v = line.split(":", 1)
                                    frontmatter[k.strip()] = v.strip()
                except Exception:
                    pass

                page_type = frontmatter.get("type", "unknown")
                title = frontmatter.get("title", fname[:-3])
                tags = frontmatter.get("tags", "")
                sources = frontmatter.get("sources", "")

                stats[page_type] = stats.get(page_type, 0) + 1

                pages.append({
                    "name": fname,
                    "rel_path": rel,
                    "category": category,
                    "page_type": page_type,
                    "title": title,
                    "tags": tags,
                    "sources": sources,
                    "size": size,
                    "modified_at": mtime,
                })

    return jsonify({"success": True, "data": {"pages": pages, "stats": stats, "total": len(pages), "wiki_dir": wiki_dir}})


# ─────────────────────────────────────────────────────────────────────
# URL 导入辅助函数
# ─────────────────────────────────────────────────────────────────────

WEB_CONTENT_MAX_CHARS = int(os.environ.get("WEB_CONTENT_MAX_CHARS", "120000"))
WEB_IMPORT_MIN_CHARS = int(os.environ.get("WEB_IMPORT_MIN_CHARS", "800"))


def _is_http_url(value: str) -> bool:
    """判断字符串是否为 HTTP/HTTPS URL"""
    try:
        parsed = urlparse((value or "").strip())
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except Exception:
        return False


def _mojibake_score(text: str) -> float:
    """Estimate whether Chinese UTF-8 text was decoded as latin-1/cp1252."""
    if not text:
        return 0.0
    sample = text[:4000]
    suspicious = sum(sample.count(ch) for ch in "äåæçèéðï¼ã¢â€œâ€")
    replacements = sample.count("\ufffd")
    cjk = len(re.findall(r"[\u4e00-\u9fff]", sample))
    score = (suspicious + replacements * 3) / max(len(sample), 1)
    if suspicious > 20 and cjk < suspicious:
        score += 0.05
    return score


def _decode_response_text(resp) -> str:
    """Decode HTTP bytes with charset fallback and mojibake repair."""
    raw = resp.content or b""
    candidates = []
    encodings = []

    if resp.encoding:
        encodings.append(resp.encoding)
    if getattr(resp, "apparent_encoding", None):
        encodings.append(resp.apparent_encoding)
    encodings.extend(["utf-8", "utf-8-sig", "gb18030", "big5"])

    for enc in encodings:
        if not enc:
            continue
        try:
            decoded = raw.decode(enc, errors="replace")
            candidates.append((enc, decoded, _mojibake_score(decoded) + decoded.count("\ufffd") / max(len(decoded), 1)))
        except Exception:
            continue

    if not candidates:
        text = resp.text or ""
    else:
        candidates.sort(key=lambda item: item[2])
        text = candidates[0][1]

    repaired = _repair_mojibake(text)
    if _mojibake_score(repaired) < _mojibake_score(text):
        text = repaired
    return text


def _repair_mojibake(text: str) -> str:
    """Repair common latin-1/cp1252 mojibake such as ä»¥å¼... back to UTF-8."""
    if not text or _mojibake_score(text) < 0.02:
        return text
    best = text
    best_score = _mojibake_score(text)
    for enc in ("latin1", "cp1252"):
        try:
            candidate = text.encode(enc, errors="ignore").decode("utf-8", errors="replace")
            score = _mojibake_score(candidate) + candidate.count("\ufffd") / max(len(candidate), 1)
            if score < best_score:
                best = candidate
                best_score = score
        except Exception:
            continue
    return best


def _html_to_text(fragment: str) -> str:
    """Convert HTML to readable text while preserving rough block boundaries."""
    if not fragment:
        return ""
    fragment = re.sub(r"(?i)<br\s*/?>", "\n", fragment)
    fragment = re.sub(r"(?i)</(?:p|div|section|article|main|li|h[1-6]|tr|table|blockquote)>", "\n", fragment)
    fragment = re.sub(r"(?i)<li[^>]*>", "- ", fragment)
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = html_lib.unescape(text)
    text = _repair_mojibake(text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    text = "\n".join(line for line in lines if line)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def _is_low_quality_web_text(text: str) -> bool:
    if not text:
        return True
    stripped = text.strip()
    if len(stripped) < WEB_IMPORT_MIN_CHARS:
        return True
    if _mojibake_score(stripped) >= 0.03:
        return True
    cjk_or_word = len(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", stripped))
    if cjk_or_word / max(len(stripped), 1) < 0.35:
        return True
    return False


def _safe_url_source_filename(url: str) -> str:
    """根据 URL 生成安全的文件名"""
    parsed = urlparse(url)
    host = re.sub(r"[^A-Za-z0-9._-]+", "_", parsed.netloc or "web").strip("_")
    path_tail = unquote((parsed.path or "").rstrip("/").split("/")[-1] or "page")
    stem = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff._-]+", "_", path_tail).strip("._-") or "page"
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    return f"{host}_{stem[:80]}_{digest}.md"


# 付费墙/反爬检测指示词
_PAYWALL_INDICATORS = [
    "client challenge",
    "ad blocker detected",
    "sign in to view",
    "subscribe to read",
    "please enable javascript",
    "checking your browser",
    "enable javascript to continue",
    "verify you are human",
    "access denied",
    "requires subscription",
    "membership required",
    "register to continue",
]


def _is_paywall_content(text: str) -> bool:
    """检测文本是否为付费墙/反爬页面"""
    if not text:
        return False
    lower = text.lower()
    head = lower[:500]
    for indicator in _PAYWALL_INDICATORS:
        if indicator in head:
            return True
    if len(text) < 150:
        link_count = text.count("http")
        if link_count > len(text) / 50:
            return True
    return False


def _extract_text_from_html(html: str) -> str:
    """从 HTML 中提取正文文本，多级降级策略"""
    html = _repair_mojibake(html or "")

    # 策略 0：Trafilatura
    try:
        import trafilatura
        text = trafilatura.extract(html, include_comments=False,
                                    include_tables=True, favor_recall=True)
        if text and len(text.strip()) > 100:
            return _html_to_text(text)
    except ImportError:
        pass
    except Exception:
        pass

    # 移除噪音标签
    for tag in ('script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript'):
        html = re.sub(rf'<{tag}[^>]*>[\s\S]*?</{tag}>', '', html, flags=re.IGNORECASE)

    # 策略 1：article/main 标签
    main_match = re.search(r'<(?:article|main)[^>]*>([\s\S]*?)</(?:article|main)>', html, re.IGNORECASE)
    if main_match:
        text = _html_to_text(main_match.group(1))
        if len(text) > 200:
            return text

    # 策略 2：全文 <p> 段落
    paragraphs = re.findall(r'<p[^>]*>([\s\S]*?)</p>', html, re.IGNORECASE)
    if paragraphs:
        text = '\n'.join(_html_to_text(p) for p in paragraphs)
        if len(text.strip()) > 200:
            return text.strip()

    # 策略 3：常见正文容器
    container_patterns = [
        r'<div[^>]+(?:id|class)=["\'][^"\']*(?:article_content|articleContent|article-content|postBody|post-body|entry-content|RichText|MarkdownBody|Post-RichTextContainer|content-detail|news-text|detail-content)[^"\']*["\'][^>]*>([\s\S]{200,}?)</div>',
        r'<section[^>]+(?:id|class)=["\'][^"\']*(?:content|article|detail)[^"\']*["\'][^>]*>([\s\S]{200,}?)</section>',
    ]
    for pattern in container_patterns:
        matches = re.findall(pattern, html, re.IGNORECASE)
        if matches:
            text = max((_html_to_text(m) for m in matches), key=len, default="")
            if len(text) > 200:
                return text

    # 策略 4：常见 JSON/SEO 字段
    json_texts = []
    for key in ("articleBody", "description", "content", "text"):
        for match in re.findall(rf'"{key}"\s*:\s*"((?:\\.|[^"\\]){{100,}})"', html):
            try:
                json_texts.append(json.loads(f'"{match}"'))
            except Exception:
                json_texts.append(match)
    if json_texts:
        text = _html_to_text("\n\n".join(json_texts))
        if len(text) > 300:
            return text

    meta_desc = re.findall(r'<meta[^>]+(?:name|property)=["\'](?:description|og:description)["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
    if meta_desc:
        text = _html_to_text("\n".join(meta_desc))
        if len(text) > 100:
            return text

    # 策略 4：终极降级
    return _html_to_text(html)


def _fetch_pdf_content(url: str, max_chars: int, timeout: int = 30) -> str:
    pdf_path = ""
    text_path = ""
    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=timeout, stream=True)
        resp.raise_for_status()
        data = resp.content
        if len(data) > 50 * 1024 * 1024:
            return ""
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as pdf_file:
            pdf_file.write(data)
            pdf_path = pdf_file.name
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as text_file:
            text_path = text_file.name

        extractor = """
import sys
pdf_path, text_path = sys.argv[1], sys.argv[2]
try:
    import fitz
    doc = fitz.open(pdf_path)
    try:
        text = "\\n".join(page.get_text("text") for page in doc)
    finally:
        doc.close()
    with open(text_path, "w", encoding="utf-8", errors="ignore") as f:
        f.write(text or "")
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(2)
"""
        proc = subprocess.run(
            [_sys.executable, "-c", extractor, pdf_path, text_path],
            capture_output=True,
            text=True,
            timeout=max(timeout, 30),
        )
        if proc.returncode != 0:
            _log(
                f"PDF subprocess extraction failed {url}: returncode={proc.returncode}, stderr={(proc.stderr or '')[:300]}",
                "warning",
            )
            return ""
        try:
            with open(text_path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read().strip()
        except Exception:
            text = ""
        if len(text) > max_chars:
            text = text[:max_chars] + f"\n\n...(PDF truncated, kept first {max_chars} chars)"
        return text if len(text) > 100 else ""
    except subprocess.TimeoutExpired:
        _log(f"PDF subprocess extraction timeout {url}", "warning")
        return ""
    except Exception as e:
        _log(f"PDF extraction failed {url}: {e}", "warning")
        return ""
    finally:
        for path in (pdf_path, text_path):
            if path:
                try:
                    os.unlink(path)
                except Exception:
                    pass

    """下载 PDF 并提取纯文本"""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return ""
    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=timeout, stream=True)
        resp.raise_for_status()
        data = resp.content
        if len(data) > 50 * 1024 * 1024:
            return ""
        doc = fitz.open(stream=data, filetype="pdf")
        pages_text = []
        for page in doc:
            pages_text.append(page.get_text("text"))
        doc.close()
        text = "\n".join(pages_text).strip()
        if len(text) > max_chars:
            text = text[:max_chars] + f"\n\n...(PDF 已截断，保留前 {max_chars} 字)"
        return text if len(text) > 100 else ""
    except Exception as e:
        _log(f"PDF 提取失败 {url}: {e}", "warning")
        return ""


def _fetch_web_content(url: str, max_chars: int = WEB_CONTENT_MAX_CHARS, timeout: int = 12) -> str:
    """抓取网页正文内容"""
    if not url or not url.startswith("http"):
        return ""

    # PDF 文件
    if url.lower().endswith('.pdf'):
        return _fetch_pdf_content(url, max_chars, timeout=30)

    # 跳过非网页文件
    if any(url.lower().endswith(ext) for ext in ['.doc', '.docx', '.zip', '.pptx']):
        return ""

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "max-age=0",
            "Sec-Ch-Ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
        }
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "")
        if "pdf" in content_type.lower():
            return _fetch_pdf_content(url, max_chars, timeout=30)

        html = _decode_response_text(resp)
        text = _repair_mojibake(_extract_text_from_html(html))

        if _is_paywall_content(text):
            return ""

        if len(text) > max_chars:
            text = text[:max_chars] + f"\n\n...(网页正文已截断，保留前 {max_chars} 字)"

        return text if len(text) > 100 else ""

    except Exception as e:
        _log(f"网页抓取失败 {url}: {e}", "warning")
        return ""


def _import_raw_source_url(project_path: str, url: str, target_subdir: Optional[str] = None, fallback_title: str = "", fallback_content: str = "") -> dict:
    """导入 URL 内容到知识库"""
    url = (url or "").strip()
    if not _is_http_url(url):
        return {"ok": False, "error": f"Invalid URL: '{url}'"}

    content = _fetch_web_content(url, max_chars=WEB_CONTENT_MAX_CHARS)
    used_fallback = False
    fetch_warning = ""
    if _is_low_quality_web_text(content):
        fetch_warning = "Fetched content is empty, too short, or appears garbled."
        content = ""
    if not content and fallback_content:
        fallback = _repair_mojibake(fallback_content.strip())
        if len(fallback) >= WEB_IMPORT_MIN_CHARS:
            content = fallback
            used_fallback = True
            fetch_warning = "Used search-result fallback because full page content was unavailable."
        else:
            fetch_warning = (
                f"Full page content unavailable and fallback is too short "
                f"({len(fallback)} chars < {WEB_IMPORT_MIN_CHARS})."
            )
    if not content:
        _log(f"URL 导入失败 - 无法获取高质量网页内容: {url}; {fetch_warning}", "error")
        return {"ok": False, "error": f"Failed to fetch complete readable web content: '{url}'. {fetch_warning}"}

    sources_root = os.path.join(project_path, "raw", "sources")
    dest_dir = os.path.join(sources_root, target_subdir or "url_imports")
    filename = _safe_url_source_filename(url)
    dest_path = os.path.join(dest_dir, filename)
    title_line = f"# {fallback_title}\n\n" if fallback_title else "# 网页资料\n\n"
    markdown = (
        f"{title_line}"
        f"- URL: {url}\n"
        f"- Imported At: {datetime.now().isoformat()}\n"
        f"- Fetch Status: {'fallback' if used_fallback else 'ok'}\n"
        f"- Content Chars: {len(content)}\n"
        + (f"- Warning: {fetch_warning}\n" if fetch_warning else "")
        + (f"- Source: search import (fallback)\n\n" if used_fallback else "\n")
        + "---\n\n"
        f"{content.strip()}\n"
    )

    try:
        os.makedirs(dest_dir, exist_ok=True)
        with open(dest_path, "w", encoding="utf-8") as f:
            f.write(markdown)
        relative_path = os.path.relpath(dest_path, sources_root)
        return {
            "ok": True,
            "source": url,
            "source_type": "url",
            "destination": dest_path.replace("\\", "/"),
            "relative_path": relative_path.replace("\\", "/"),
            "filename": filename,
            "size": os.path.getsize(dest_path),
            "content_length": len(content),
            "imported_at": datetime.now().isoformat(),
        }
    except Exception as e:
        _log(f"_import_raw_source_url failed for {url}: {traceback.format_exc()}", "error")
        return {"ok": False, "error": str(e)}


# ============================================================
#  Raw source management routes (file-system level)
# ============================================================


@app.route("/api/v1/projects/sources", methods=["GET"])
def list_project_sources():
    project_path = request.args.get("project_path")
    subdir = request.args.get("subdir")
    recursive = request.args.get("recursive", "true").lower() == "true"
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400
    result = client.list_raw_sources(project_path, subdir=subdir or None, recursive=recursive)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/sources", methods=["DELETE"])
def delete_project_source():
    project_path = request.args.get("project_path")
    rel_path = request.args.get("rel_path")
    delete_type = request.args.get("type", "file")
    if not project_path or not rel_path:
        return jsonify({"success": False, "message": "project_path and rel_path are required"}), 400
    if delete_type == "folder":
        result = client.delete_raw_source_folder(project_path, rel_path)
        if not result.get("ok"):
            return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
        write_log("delete_raw_source_folder", {"project_path": project_path, "rel_path": rel_path})
    else:
        result = client.delete_raw_source(project_path, rel_path)
        if not result.get("ok"):
            return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
        write_log("delete_raw_source", {"project_path": project_path, "rel_path": rel_path})
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/sources/import-file", methods=["POST"])
def import_raw_source_file():
    data = request.get_json() or {}
    project_path = data.get("project_path")
    source_file_path = data.get("source_file_path")
    target_subdir = data.get("target_subdir")
    # 前端可传 import_task_id 用于轮询预处理实时进度；未传则生成一个，便于后端自洽记录
    import_task_id = data.get("import_task_id") or str(uuid.uuid4())
    if not project_path or not source_file_path:
        _log(f"import-file 参数缺失: project_path={project_path}, source_file_path={source_file_path}", "warning")
        return jsonify({"success": False, "message": "project_path and source_file_path are required"}), 400

    # 获取模型名用于统计
    llm_cfg = load_llm_config()
    perf_model = llm_cfg.get("llm_model", "")

    # 检查是否为 URL 导入
    source_type = data.get("source_type")
    is_url = source_type == "url" or _is_http_url(source_file_path)
    _log(f"import-file: type={source_type or 'auto'}, path={source_file_path[:100]}")

    set_import_progress(
        import_task_id,
        status="running",
        stage="mermaid_processing",
        current_file=os.path.basename(source_file_path),
        message=f"开始导入 {os.path.basename(source_file_path)}…",
    )

    # 所有文件：统一走 转换 → 流水线 → 导入（不修改源文件）
    md_mermaid_result = None
    _mermaid_temp_file = None
    _pipeline_temp_dir = None
    if not is_url and os.path.isfile(source_file_path):
        # 所有支持的文件类型：统一走 转换 → 流水线 → 导入
        set_import_progress(import_task_id, stage="mermaid_processing", message="正在分析文件并转换为结构化内容…")
        try:
            llm_url = llm_cfg.get("llm_url", "")
            llm_model = llm_cfg.get("llm_model", "")
            if llm_url and llm_model and data.get("enable_image_to_desc", False):
                with track_step("import_file", "mermaid_process", model=perf_model) as step:
                    llm_api_key = llm_cfg.get("llm_api_key", "")
                    from image_to_desc import convert_file_to_markdown as _to_md
                    from image_to_desc import process_file_pipeline as _pipeline
                    # Step 1: 统一转为 Markdown（MD 文件直接返回原路径）
                    _converted_path = _to_md(source_file_path)
                    if _converted_path is None:
                        _log(f"import-file: unsupported file type {source_file_path}, import as-is", "warning")
                        _converted_path = source_file_path
                    else:
                        # 非 MD：converted_path 在临时目录，source_dir = 该目录
                        _source_dir = None
                        _ext = os.path.splitext(source_file_path)[1].lower()
                        if _ext not in (".md", ".mdx", ".markdown"):
                            _source_dir = os.path.dirname(_converted_path)
                            _pipeline_temp_dir = _source_dir
                        _log(f"import-file: converted {source_file_path} -> {_converted_path}")
                        # Step 2: 图片处理流水线
                        md_result = _pipeline(_converted_path, llm_url, llm_api_key, llm_model, source_dir=_source_dir)
                        md_mermaid_result = md_result
                        _output_md = md_result.get("output_md", "")
                        if _output_md and os.path.isfile(_output_md):
                            _mermaid_temp_file = _output_md
                        step.set_detail("total_images", md_result.get("total_images", 0))
                        step.set_detail("type_counts", md_result.get("type_counts", {}))
                        step.set_detail("errors", md_result.get("errors", 0))
                        _tc = md_result.get("type_counts", {})
                        _log(f"import-file: pipeline for {source_file_path}: "
                             f"total={md_result.get('total_images', 0)}, types={_tc}, errors={md_result.get('errors', 0)}")
        except Exception as e:
            _log(f"import-file: file pipeline failed for {source_file_path}: {e}", "warning")
            record_step("import_file", "mermaid_process", 0, model=perf_model, success=False, error=str(e))

    if is_url:
        with track_step("import_file", "import_url", model=perf_model) as step:
            result = _import_raw_source_url(
                project_path, source_file_path,
                target_subdir=target_subdir or None,
                fallback_title=data.get("fallback_title", ""),
                fallback_content=data.get("fallback_content", ""),
            )
            step.set_detail("source_type", "url")
    else:
        # 如果 mermaid 处理生成了临时副本，导入副本（含 mermaid 代码），否则导入原文件
        import_file = _mermaid_temp_file if _mermaid_temp_file and os.path.isfile(_mermaid_temp_file) else source_file_path

        # 复制图片到 raw/assets/ 并更新 MD 中的引用路径
        if md_mermaid_result and md_mermaid_result.get("ok") and _mermaid_temp_file and os.path.isfile(_mermaid_temp_file):
            _p_temp_dir = md_mermaid_result.get("temp_dir", "")
            _p_image_files = md_mermaid_result.get("image_files", [])
            if _p_temp_dir and _p_image_files:
                _p_assets_dir = os.path.join(project_path, "raw", "assets")
                os.makedirs(_p_assets_dir, exist_ok=True)
                # 用 MD 文件名（去掉 .md）的 ASCII 安全版本作为图片前缀，避免重名
                try:
                    from image_to_desc import _safe_ascii_stem
                    _p_md_stem = _safe_ascii_stem(_mermaid_temp_file)
                except Exception:
                    _p_md_stem = "img"
                _log(f"import-file: copying {len(_p_image_files)} images to raw/assets/ (prefix: {_p_md_stem})")
                for _p_img_name in _p_image_files:
                    _p_img_src = os.path.join(_p_temp_dir, _p_img_name)
                    _p_dedup_name = f"{_p_md_stem}_{_p_img_name}"
                    _p_img_dst = os.path.join(_p_assets_dir, _p_dedup_name)
                    if os.path.isfile(_p_img_src):
                        shutil.copy2(_p_img_src, _p_img_dst)
                # 更新 MD 中的图片引用: ](filename.png) → ](../assets/{stem}_filename.png)
                # (MD 在 raw/sources/, 图片在 raw/assets/, 相对路径为 ../assets/)
                # 图片文件名已是纯 ASCII，无需 URL 编码
                try:
                    with open(_mermaid_temp_file, "r", encoding="utf-8") as _f:
                        _md_text = _f.read()
                    for _p_img_name in _p_image_files:
                        _p_dedup_name = f"{_p_md_stem}_{_p_img_name}"
                        _md_text = _md_text.replace(
                            f"]({_p_img_name})",
                            f"](../assets/{_p_dedup_name})"
                        )
                    with open(_mermaid_temp_file, "w", encoding="utf-8") as _f:
                        _f.write(_md_text)
                    _log(f"import-file: updated image references in {_mermaid_temp_file}")
                except Exception as _e:
                    _log(f"import-file: failed to update image references: {_e}", "warning")

        with track_step("import_file", "import_copy", model=perf_model) as step:
            result = client.import_raw_source_file(project_path, import_file, target_subdir=target_subdir or None, task_id=import_task_id)
            step.set_detail("source_type", source_type or "file")

    if not result.get("ok"):
        _log(f"import-file failed: {result.get('error', 'Unknown error')}", "error")
        set_import_progress(import_task_id, status="error", stage="failed", message=f"导入失败：{result.get('error', '未知错误')}")
        write_log("import_file_error", {
            "project_path": project_path,
            "source": source_file_path,
            "source_type": source_type or "file",
            "error": result.get("error", "Unknown error"),
        }, level="error")
        # 清理临时目录
        def _cleanup_temp_dirs():
            for _td in (_mermaid_temp_file, _pipeline_temp_dir):
                if _td:
                    _d = os.path.dirname(_td) if not os.path.isdir(_td) else _td
                    try:
                        shutil.rmtree(_d, ignore_errors=True)
                    except Exception:
                        pass
        _cleanup_temp_dirs()
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    write_log("import_raw_source_file", {"project_path": project_path, "source": source_file_path, "source_type": source_type or result.get("source_type") or "file"})
    with track_step("import_file", "rescan", model=perf_model) as step:
        rescan_info = _try_rescan_project(project_path, background=True)
        step.set_detail("background", rescan_info.get("background", False))
    result["rescan"] = rescan_info
    # 清理临时目录
    def _cleanup_temp_dirs():
        for _td in (_mermaid_temp_file, _pipeline_temp_dir):
            if _td:
                _d = os.path.dirname(_td) if not os.path.isdir(_td) else _td
                try:
                    shutil.rmtree(_d, ignore_errors=True)
                except Exception:
                    pass
    _cleanup_temp_dirs()
    _activate_project_by_path(project_path)
    set_import_progress(import_task_id, status="done", stage="finished", message=f"导入完成：{result.get('filename', os.path.basename(source_file_path))}")
    result["import_task_id"] = import_task_id
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/sources/import-folder", methods=["POST"])
def import_raw_source_folder():
    data = request.get_json() or {}
    project_path = data.get("project_path")
    source_folder_path = data.get("source_folder_path")
    folder_name = data.get("folder_name")
    # 前端可传 import_task_id 用于轮询预处理实时进度；未传则生成一个
    import_task_id = data.get("import_task_id") or str(uuid.uuid4())
    if not project_path or not source_folder_path:
        return jsonify({"success": False, "message": "project_path and source_folder_path are required"}), 400

    # 获取模型名用于统计
    llm_cfg = load_llm_config()
    perf_model = llm_cfg.get("llm_model", "")

    set_import_progress(
        import_task_id,
        status="running",
        stage="mermaid_processing",
        current_file=folder_name or os.path.basename(source_folder_path.rstrip("/").rstrip("\\")),
        message=f"开始导入文件夹 {folder_name or os.path.basename(source_folder_path)}…",
    )

    # 导入前：将源文件夹复制到临时目录，对临时副本中的 md 做图片结构化转换
    _folder_temp_root = None
    _folder_import_path = source_folder_path  # 默认导入源路径
    md_mermaid_results = []
    md_mermaid_success = True
    md_count = 0
    with track_step("import_folder", "mermaid_process", model=perf_model) as step:
        try:
            llm_url = llm_cfg.get("llm_url", "")
            llm_api_key = llm_cfg.get("llm_api_key", "")
            llm_model = llm_cfg.get("llm_model", "")

            if llm_url and llm_model and data.get("enable_image_to_desc", False):
                # 复制源文件夹到临时目录，所有操作在副本上进行
                _folder_temp_root = tempfile.mkdtemp(prefix="folder_pipeline_")
                _folder_import_path = os.path.join(_folder_temp_root, os.path.basename(source_folder_path.rstrip("/").rstrip("\\")))
                shutil.copytree(source_folder_path, _folder_import_path)
                _log(f"import-folder: copied to temp: {_folder_import_path}")

                from image_to_desc import process_file_pipeline as _pipeline
                for root, dirs, files in os.walk(_folder_import_path):
                    for fname in files:
                        if fname.lower().endswith(('.md', '.markdown')):
                            md_path = os.path.join(root, fname)
                            md_count += 1
                            set_import_progress(import_task_id, stage="mermaid_processing", current_file=fname, message=f"正在分析图片并转换为结构化信息 ({md_count})：{fname}…")
                            try:
                                res = _pipeline(md_path, llm_url, llm_api_key, llm_model)
                                output_md = res.get("output_md", "")
                                if output_md and os.path.isfile(output_md):
                                    # 将增强后的 md 文件替换临时副本中的原 md
                                    shutil.copy2(output_md, md_path)
                                # 复制图片到 raw/assets/ 并更新 MD 引用（用 ASCII 安全前缀避免重名）
                                _td = res.get("temp_dir", "")
                                _imgs = res.get("image_files", [])
                                if _td and _imgs:
                                    _fa = os.path.join(project_path, "raw", "assets")
                                    os.makedirs(_fa, exist_ok=True)
                                    try:
                                        from image_to_desc import _safe_ascii_stem
                                        _md_stem = _safe_ascii_stem(md_path)
                                    except Exception:
                                        _md_stem = "img"
                                    for _in in _imgs:
                                        _isrc = os.path.join(_td, _in)
                                        _dedup_name = f"{_md_stem}_{_in}"
                                        if os.path.isfile(_isrc):
                                            shutil.copy2(_isrc, os.path.join(_fa, _dedup_name))
                                    # 更新 md_path 中的图片引用 (MD 在 raw/sources/, 图片在 raw/assets/)
                                    # 图片文件名已是纯 ASCII，无需 URL 编码
                                    if os.path.isfile(md_path):
                                        try:
                                            with open(md_path, "r", encoding="utf-8") as _mf:
                                                _mt = _mf.read()
                                            for _in in _imgs:
                                                _dedup_name = f"{_md_stem}_{_in}"
                                                _mt = _mt.replace(f"]({_in})", f"](../assets/{_dedup_name})")
                                            with open(md_path, "w", encoding="utf-8") as _mf:
                                                _mf.write(_mt)
                                        except Exception as _e:
                                            _log(f"import-folder: failed to update image references in {fname}: {_e}", "warning")
                                md_mermaid_results.append({
                                    "file": fname,
                                    "total_images": res.get("total_images", 0),
                                    "type_counts": res.get("type_counts", {}),
                                })
                                _tc = res.get("type_counts", {})
                                if sum(_tc.get(k, 0) for k in ("mermaid", "table", "code", "list")) > 0:
                                    _log(f"import-folder: processed {fname}, types={_tc}")
                                # 清理单次流水线临时目录
                                td = res.get("temp_dir", "")
                                if td:
                                    try:
                                        shutil.rmtree(td, ignore_errors=True)
                                    except Exception:
                                        pass
                            except Exception as e:
                                _log(f"import-folder: file pipeline failed for {fname}: {e}", "warning")
        except Exception as e:
            _log(f"import-folder: markdown pre-processing skipped: {e}", "warning")
            md_mermaid_success = False
        step.set_detail("md_file_count", md_count)
        step.set_detail("total_images", sum(r.get("total_images", 0) for r in md_mermaid_results))
        if not md_mermaid_success:
            step.set_error("markdown pre-processing failed")

    with track_step("import_folder", "import_copy", model=perf_model) as step:
        # 导入临时副本（含增强 md），无流水线时导入源路径
        result = client.import_raw_source_folder(project_path, _folder_import_path, folder_name=folder_name or None, task_id=import_task_id)
        step.set_detail("ok", result.get("ok", False))
    if not result.get("ok"):
        set_import_progress(import_task_id, status="error", stage="failed", message=f"导入失败：{result.get('error', '未知错误')}")
        # 清理临时目录
        if _folder_temp_root:
            try:
                shutil.rmtree(_folder_temp_root, ignore_errors=True)
            except Exception:
                pass
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    write_log("import_raw_source_folder", {"project_path": project_path, "source_folder": source_folder_path})
    with track_step("import_folder", "rescan", model=perf_model) as step:
        rescan_info = _try_rescan_project(project_path, background=True)
        step.set_detail("background", rescan_info.get("background", False))
    result["rescan"] = rescan_info
    if md_mermaid_results:
        result["md_mermaid"] = md_mermaid_results
    _activate_project_by_path(project_path)
    # 清理临时目录
    if _folder_temp_root:
        try:
            shutil.rmtree(_folder_temp_root, ignore_errors=True)
        except Exception:
            pass
    set_import_progress(import_task_id, status="done", stage="finished", message=f"文件夹导入完成：{folder_name or os.path.basename(source_folder_path)}")
    result["import_task_id"] = import_task_id
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/import-progress", methods=["GET"])
def get_import_progress_endpoint():
    """查询导入/预处理实时进度，供前端轮询展示。

    Query: task_id（必填）, clear=1（可选，查询后清除记录，用于任务结束时清理）
    """
    task_id = request.args.get("task_id")
    if not task_id:
        return jsonify({"success": False, "message": "task_id is required"}), 400
    prog = get_import_progress(task_id)
    if prog is None:
        return jsonify({"success": True, "data": None})
    if request.args.get("clear") == "1":
        clear_import_progress(task_id)
    return jsonify({"success": True, "data": prog})


# ============================================================
#  Rescan route (by filesystem path)
# ============================================================


@app.route("/api/v1/projects/sources/rescan", methods=["POST"])
def rescan_project_by_path():
    data = request.get_json() or {}
    project_path = data.get("project_path")
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400
    rescan_info = _try_rescan_project(project_path, background=True)
    write_log("rescan_by_path", {"project_path": project_path, "rescan": rescan_info})
    return jsonify({"success": True, "data": rescan_info})


@app.route("/api/v1/projects/rescan-progress", methods=["GET"])
def get_rescan_progress():
    """轮询 KMA 后端 rescan 的队列处理进度。

    通过读取 project/.llm-wiki/file-change-queue.json 获取各 task 的
    pending/processing/done/failed 状态计数，同时返回后台 rescan 线程状态。
    前端定时轮询此接口即可展示实时进度条。
    """
    project_path = request.args.get("project_path")
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400

    result = {
        "background": None,
        "queue_exists": False,
        "queue_summary": {"pending": 0, "processing": 0, "done": 0, "failed": 0, "total": 0},
    }

    # 1. 后台 rescan 线程状态
    norm_path = os.path.normpath(project_path).lower()
    with _bg_rescan_lock:
        bg_state = _bg_rescan_states.get(norm_path)
        if bg_state:
            result["background"] = dict(bg_state)

    # 2. 读取 file-change-queue.json（KMA 后端队列持久化文件）
    queue_file = os.path.join(project_path, ".llm-wiki", "file-change-queue.json")
    if os.path.exists(queue_file):
        result["queue_exists"] = True
        try:
            with open(queue_file, "r", encoding="utf-8") as f:
                queue_data = json.load(f)
            tasks = queue_data.get("tasks", []) if isinstance(queue_data, dict) else queue_data
            if isinstance(tasks, list):
                for task in tasks:
                    status = task.get("status", "pending")
                    key = status if status in result["queue_summary"] else "pending"
                    result["queue_summary"][key] = result["queue_summary"].get(key, 0) + 1
                result["queue_summary"]["total"] = len(tasks)
        except (json.JSONDecodeError, IOError):
            pass

    return jsonify({"success": True, "data": result})


# ============================================================
#  Image to Mermaid diagram conversion
# ============================================================


@app.route("/api/v1/projects/process-images", methods=["POST"])
def process_project_images():
    """Process images in raw/assets: identify diagrams and generate Mermaid code."""
    data = request.get_json() or {}
    project_path = data.get("project_path")
    force = data.get("force", False)

    if not project_path:
        # Use active project
        try:
            project_path = _get_active_base_dir()
        except RuntimeError:
            return jsonify({"success": False, "message": "No active project"}), 400

    # Use current selected model, skip if it doesn't support vision
    llm_cfg = load_llm_config()
    llm_url = llm_cfg.get("llm_url", "")
    llm_api_key = llm_cfg.get("llm_api_key", "")
    llm_model = llm_cfg.get("llm_model", "")

    _log(f"chat_qa: resolved llm_config -> model={llm_model}, url={llm_url[:60]}, has_key={bool(llm_api_key)}")

    if not llm_url or not llm_model:
        return jsonify({"success": False, "message": "LLM config not available"}), 500

    # Check if current model supports vision
    models_path = _get_models_json_path()
    current_model_id = ""
    memory_path = _get_memory_file_path()
    if os.path.exists(memory_path):
        try:
            with open(memory_path, "r", encoding="utf-8") as f:
                memory = json.load(f)
            current_model_id = memory.get("selectedModelConfigId", "")
        except (json.JSONDecodeError, IOError):
            pass

    supports_vision = False
    if current_model_id and os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                models_data = json.load(f)
            for m in models_data.get("MODELS", []):
                if m.get("id") == current_model_id:
                    supports_vision = m.get("vision", False)
                    break
        except (json.JSONDecodeError, IOError):
            pass

    if not supports_vision:
        _log(f"process-images: skipped, current model '{llm_model}' (id={current_model_id}) does not support vision")
        return jsonify({
            "success": True,
            "data": {
                "ok": True,
                "total": 0,
                "success": 0,
                "not_diagram": 0,
                "errors": 0,
                "skipped": 0,
                "results": [],
                "message": f"Current model '{llm_model}' does not support vision, skipping image processing",
            },
        })

    _log(f"process-images: project={project_path}, model={llm_model}, force={force}")

    try:
        from image_to_desc import process_project_images as _process_images
        result = _process_images(
            project_path, llm_url, llm_api_key, llm_model, force=force
        )
        write_log("process_images", {
            "project_path": project_path,
            "total": result.get("total", 0),
            "success": result.get("success", 0),
            "not_diagram": result.get("not_diagram", 0),
            "errors": result.get("errors", 0),
        })
        return jsonify({"success": True, "data": result})
    except Exception as e:
        _log(f"process-images failed: {e}", "error")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/v1/projects/list-mermaid", methods=["GET"])
def list_mermaid_files():
    """List all generated Mermaid files in raw/assets with their metadata."""
    project_path = request.args.get("project_path")
    if not project_path:
        try:
            project_path = _get_active_base_dir()
        except RuntimeError:
            return jsonify({"success": False, "message": "No active project"}), 400

    assets_dir = os.path.join(project_path, "raw", "assets")
    if not os.path.isdir(assets_dir):
        return jsonify({"success": True, "data": {"mermaid_files": [], "total": 0}})

    mermaid_files = []
    for root, dirs, files in os.walk(assets_dir):
        for fname in sorted(files):
            if fname.endswith(".mermaid"):
                mermaid_path = os.path.join(root, fname)
                meta_path = mermaid_path + ".json"
                image_name = fname[:-len(".mermaid")]
                image_path = os.path.join(root, image_name)

                meta = {}
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path, "r", encoding="utf-8") as f:
                            meta = json.load(f)
                    except (json.JSONDecodeError, IOError):
                        pass

                mermaid_code = ""
                try:
                    with open(mermaid_path, "r", encoding="utf-8") as f:
                        mermaid_code = f.read()
                except (IOError, UnicodeDecodeError):
                    pass

                rel_path = os.path.relpath(mermaid_path, assets_dir).replace("\\", "/")
                mermaid_files.append({
                    "filename": fname,
                    "relative_path": rel_path,
                    "image": image_name,
                    "image_exists": os.path.exists(image_path),
                    "diagram_type": meta.get("diagram_type", ""),
                    "description": meta.get("description", ""),
                    "mermaid_code": mermaid_code,
                    "processed_at": meta.get("processed_at", ""),
                })

    return jsonify({"success": True, "data": {"mermaid_files": mermaid_files, "total": len(mermaid_files)}})


@app.route("/api/v1/projects/process-markdown-images", methods=["POST"])
def process_markdown_images():
    """Process a markdown file: find image refs, detect diagrams, insert mermaid in-place."""
    data = request.get_json() or {}
    md_file_path = data.get("md_file_path")

    if not md_file_path:
        return jsonify({"success": False, "message": "md_file_path is required"}), 400

    if not os.path.isfile(md_file_path):
        return jsonify({"success": False, "message": f"Markdown file not found: {md_file_path}"}), 404

    # Load LLM config and check Vision support
    llm_cfg = load_llm_config()
    llm_url = llm_cfg.get("llm_url", "")
    llm_api_key = llm_cfg.get("llm_api_key", "")
    llm_model = llm_cfg.get("llm_model", "")

    _log(f"[chat_qa] resolved llm_config: model={llm_model}, url={llm_url[:60]}, has_key={bool(llm_api_key)}")

    if not llm_url or not llm_model:
        return jsonify({"success": False, "message": "LLM config not available"}), 500

    # Check if current model supports vision
    models_path = _get_models_json_path()
    current_model_id = ""
    memory_path = _get_memory_file_path()
    if os.path.exists(memory_path):
        try:
            with open(memory_path, "r", encoding="utf-8") as f:
                memory = json.load(f)
            current_model_id = memory.get("selectedModelConfigId", "")
        except (json.JSONDecodeError, IOError):
            pass

    supports_vision = False
    if current_model_id and os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                models_data = json.load(f)
            for m in models_data.get("MODELS", []):
                if m.get("id") == current_model_id:
                    supports_vision = m.get("vision", False)
                    break
        except (json.JSONDecodeError, IOError):
            pass

    if not supports_vision:
        _log(f"process-markdown-images: skipped, model '{llm_model}' does not support vision")
        return jsonify({
            "success": True,
            "data": {"ok": True, "total_images": 0, "inserted": 0, "message": "Model does not support vision"},
        })

    _log(f"process-markdown-images: md={md_file_path}, model={llm_model}")

    try:
        from image_to_desc import process_markdown_images as _process_md
        result = _process_md(md_file_path, llm_url, llm_api_key, llm_model)
        write_log("process_markdown_images", {
            "md_file": md_file_path,
            "total_images": result.get("total_images", 0),
            "inserted": result.get("inserted", 0),
            "errors": result.get("errors", 0),
        })
        return jsonify({"success": True, "data": result})
    except Exception as e:
        _log(f"process-markdown-images failed: {e}", "error")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/v1/projects/process-file-pipeline", methods=["POST"])
def process_file_pipeline():
    """完整的文件处理流水线: 解析 → 描述 → 判断转换 → 写临时文件。

    支持 mermaid、table、code、list 等多种转换类型。
    使用 prefix cache + 流式输出 + 思考模式。
    不修改源文件，全部在临时目录操作。
    """
    data = request.get_json() or {}
    file_path = data.get("file_path")

    if not file_path:
        return jsonify({"success": False, "message": "file_path is required"}), 400

    if not os.path.isfile(file_path):
        return jsonify({"success": False, "message": f"File not found: {file_path}"}), 404

    # Load LLM config and check Vision support
    llm_cfg = load_llm_config()
    llm_url = llm_cfg.get("llm_url", "")
    llm_api_key = llm_cfg.get("llm_api_key", "")
    llm_model = llm_cfg.get("llm_model", "")

    if not llm_url or not llm_model:
        return jsonify({"success": False, "message": "LLM config not available"}), 500

    # Check if current model supports vision
    models_path = _get_models_json_path()
    current_model_id = ""
    memory_path = _get_memory_file_path()
    if os.path.exists(memory_path):
        try:
            with open(memory_path, "r", encoding="utf-8") as f:
                memory = json.load(f)
            current_model_id = memory.get("selectedModelConfigId", "")
        except (json.JSONDecodeError, IOError):
            pass

    supports_vision = False
    if current_model_id and os.path.exists(models_path):
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                models_data = json.load(f)
            for m in models_data.get("MODELS", []):
                if m.get("id") == current_model_id:
                    supports_vision = m.get("vision", False)
                    break
        except (json.JSONDecodeError, IOError):
            pass

    if not supports_vision:
        _log(f"process-file-pipeline: skipped, model '{llm_model}' does not support vision")
        return jsonify({
            "success": True,
            "data": {"ok": True, "total_images": 0, "message": "Model does not support vision"},
        })

    _log(f"process-file-pipeline: file={file_path}, model={llm_model}")

    try:
        from image_to_desc import process_file_pipeline as _pipeline
        result = _pipeline(file_path, llm_url, llm_api_key, llm_model)
        write_log("process_file_pipeline", {
            "file": file_path,
            "total_images": result.get("total_images", 0),
            "type_counts": result.get("type_counts", {}),
            "errors": result.get("errors", 0),
        })
        return jsonify({"success": True, "data": result})
    except Exception as e:
        _log(f"process-file-pipeline failed: {e}", "error")
        return jsonify({"success": False, "message": str(e)}), 500


# ============================================================
#  Ingest status monitoring routes
# ============================================================


@app.route("/api/v1/projects/ingest-status", methods=["GET"])
def get_ingest_status():
    """获取摄入队列、删除队列状态和日志，用于前端监控面板"""
    project_path = request.args.get("project_path")
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400

    result = {
        "queue": [],
        "summary": {"pending": 0, "processing": 0, "failed": 0, "done": 0, "total": 0},
        "delete_queue": [],
        "delete_summary": {"pending": 0, "processing": 0, "failed": 0, "done": 0, "total": 0},
        "log_entries": [],
        "delete_log_entries": [],
        "queue_exists": False,
        "delete_queue_exists": False,
        "log_exists": False,
    }

    # 1. 读取 ingest-queue.json（摄入队列）
    queue_file = os.path.join(project_path, ".llm-wiki", "ingest-queue.json")
    if os.path.exists(queue_file):
        result["queue_exists"] = True
        try:
            with open(queue_file, "r", encoding="utf-8") as f:
                queue_data = json.load(f)
            if isinstance(queue_data, list):
                for task in queue_data:
                    status = task.get("status", "pending")
                    result["summary"][status] = result["summary"].get(status, 0) + 1
                result["summary"]["total"] = len(queue_data)
                result["queue"] = queue_data
        except (json.JSONDecodeError, IOError):
            pass

    # 2. 读取 file-change-queue.json（删除队列）
    delete_queue_file = os.path.join(project_path, ".llm-wiki", "file-change-queue.json")
    if os.path.exists(delete_queue_file):
        result["delete_queue_exists"] = True
        try:
            with open(delete_queue_file, "r", encoding="utf-8") as f:
                delete_data = json.load(f)
            if isinstance(delete_data, dict):
                tasks = delete_data.get("tasks", [])
                if isinstance(tasks, list):
                    for task in tasks:
                        status = task.get("status", "pending")
                        result["delete_summary"][status] = result["delete_summary"].get(status, 0) + 1
                    result["delete_summary"]["total"] = len(tasks)
                    result["delete_queue"] = tasks
            elif isinstance(delete_data, list):
                for task in delete_data:
                    status = task.get("status", "pending")
                    result["delete_summary"][status] = result["delete_summary"].get(status, 0) + 1
                result["delete_summary"]["total"] = len(delete_data)
                result["delete_queue"] = delete_data
        except (json.JSONDecodeError, IOError):
            pass

    # 3. 读取 wiki/log.md（最近 10 条日志）
    log_file = os.path.join(project_path, "wiki", "log.md")
    if os.path.exists(log_file):
        result["log_exists"] = True
        try:
            # 尝试读取，Windows 下文件可能被其他进程锁定，重试 3 次
            log_content = None
            import time
            for attempt in range(3):
                try:
                    with open(log_file, "r", encoding="utf-8") as f:
                        log_content = f.read()
                    break
                except (IOError, PermissionError):
                    if attempt < 2:
                        time.sleep(0.3)
            if log_content is None:
                raise IOError("failed to read log file after 3 attempts")
            # 解析 markdown 格式的日志，支持多种 header 写法：
            #   ## [2026-06-11] action | filename
            #   ## 2026-06-11 action | filename
            #   2026-06-11: action | filename
            #   2026-06-11 action | filename
            import re
            entries = []
            delete_entries = []
            lines = log_content.split("\n")
            current_entry = None
            # 匹配日期开头的 header 行（允许前导 ## [] : 等装饰）
            header_re = re.compile(
                r"^"                          # 行首
                r"(?:(?:##\s*)?\[?)"          # 可选的 ##  和 [
                r"(\d{4}-\d{2}-\d{2})"        # 日期 (group 1)
                r"\]?"                         # 可选的 ]
                r":?\s+"                       # 可选的 : 和空格
                r"(.+)$"                      # action 正文 (group 2)
            )
            for line in lines:
                hm = header_re.match(line)
                if hm:
                    if current_entry:
                        entries.append(current_entry)
                        action_lower = current_entry.get("action", "").lower()
                        if "delete" in action_lower:
                            delete_entries.append(current_entry)
                    current_entry = {
                        "date": hm.group(1),
                        "action": hm.group(2).strip(),
                        "details": [],
                    }
                elif current_entry is not None:
                    stripped = line.strip()
                    # 去除可能的 - 列表前缀，检查是否以日期开头
                    body = re.sub(r"^-\s*", "", stripped, count=1)
                    date_match = re.match(r"^(\d{4}-\d{2}-\d{2})[:\s]+(.+)$", body)
                    if date_match:
                        entries.append(current_entry)
                        action_lower = current_entry.get("action", "").lower()
                        if "delete" in action_lower:
                            delete_entries.append(current_entry)
                        current_entry = {
                            "date": date_match.group(1),
                            "action": date_match.group(2).strip(),
                            "details": [],
                        }
                    elif stripped.startswith("-"):
                        current_entry["details"].append(stripped.lstrip("- ").strip())
            if current_entry:
                entries.append(current_entry)
                if "delete" in current_entry.get("action", "").lower():
                    delete_entries.append(current_entry)
            # 只保留摄入和删除相关的日志条目
            # 摄入：action 含 "ingest"；删除：action 含 "delete"（source-delete、external delete 等）
            filtered_entries = []
            for e in entries:
                al = e.get("action", "").lower()
                if "delete" in al:
                    filtered_entries.append(e)
                elif "ingest" in al:
                    filtered_entries.append(e)
            result["log_entries"] = filtered_entries[:10]
            result["delete_log_entries"] = delete_entries[:10]
        except Exception as e:
            result["log_error"] = str(e)

    return jsonify({"success": True, "data": result})


# ============================================================
#  Chat / Q&A routes
# ============================================================

# ── Graph expansion helpers ──────────────────────────────────

TYPE_AFFINITY = {
    "entity":    {"entity": 0.8, "concept": 1.2, "source": 1.0, "query": 0.8, "synthesis": 1.0},
    "concept":   {"entity": 1.2, "concept": 0.8, "source": 1.0, "query": 1.0, "synthesis": 1.2},
    "source":    {"entity": 1.0, "concept": 1.0, "source": 0.5, "query": 0.8, "synthesis": 1.0},
    "query":     {"entity": 0.8, "concept": 1.0, "source": 0.8, "query": 0.5, "synthesis": 1.0},
    "synthesis": {"entity": 1.0, "concept": 1.2, "source": 1.0, "query": 1.0, "synthesis": 0.8},
}


class _GraphNode:
    __slots__ = ("id", "label", "node_type", "path", "link_count", "sources", "out_links", "neighbors")

    def __init__(self, data: dict):
        self.id = data.get("id", "")
        self.label = data.get("label", "")
        self.node_type = data.get("nodeType", "unknown")
        self.path = data.get("path", "")
        self.link_count = data.get("linkCount", 0)
        self.sources = set(data.get("sources") or [])
        self.out_links = set(data.get("links") or data.get("outLinks") or [])
        self.neighbors = set()

    def degree(self):
        return max(self.link_count, 1)


class WikiGraph:
    def __init__(self, nodes_data: list, edges_data: list):
        self.nodes = {}
        self._path_to_id = {}
        for n in nodes_data:
            node = _GraphNode(n)
            self.nodes[node.id] = node
            if node.path:
                stem = _stem_path(node.path)
                self._path_to_id[stem] = node.id

        for e in edges_data:
            src = e.get("source", "")
            tgt = e.get("target", "")
            if src in self.nodes:
                self.nodes[src].neighbors.add(tgt)
            if tgt in self.nodes:
                self.nodes[tgt].neighbors.add(src)

    def get_neighbors(self, node_id: str) -> set:
        node = self.nodes.get(node_id)
        return node.neighbors if node else set()

    def find_node_by_path(self, path: str):
        stem = _stem_path(path)
        nid = self._path_to_id.get(stem)
        if nid:
            return self.nodes.get(nid)
        return None


def _stem_path(path: str) -> str:
    """Remove .md suffix from a file path."""
    if path.endswith(".md"):
        return path[:-3]
    return path


def _calculate_relevance(node_a: _GraphNode, node_b: _GraphNode, graph: WikiGraph) -> float:
    """Weighted relevance score between two graph nodes."""
    score = 0.0

    # Signal 1: Direct links (weight 3.0)
    direct = 0
    if node_b.id in node_a.out_links:
        direct += 1
    if node_a.id in node_b.out_links:
        direct += 1
    score += direct * 3.0

    # Signal 2: Source overlap (weight 4.0)
    shared = len(node_a.sources & node_b.sources)
    score += shared * 4.0

    # Signal 3: Common neighbors – Adamic-Adar (weight 1.5)
    common = graph.get_neighbors(node_a.id) & graph.get_neighbors(node_b.id)
    for neighbor_id in common:
        neighbor_node = graph.nodes.get(neighbor_id)
        deg = neighbor_node.degree() if neighbor_node else 2
        score += (1.0 / math.log(max(deg, 2))) * 1.5

    # Signal 4: Type affinity (weight 1.0)
    affinity = TYPE_AFFINITY.get(node_a.node_type, {}).get(node_b.node_type, 0.5)
    score += affinity * 1.0

    return score


def _get_related_nodes(
    search_hit_node: _GraphNode,
    graph: WikiGraph,
    top_k: int = 3,
    relevance_threshold: float = 2.0,
) -> list:
    """Return top-k related nodes for a search hit, sorted by relevance."""
    scored = []
    for other in graph.nodes.values():
        if other.id == search_hit_node.id:
            continue
        rel = _calculate_relevance(search_hit_node, other, graph)
        if rel >= relevance_threshold:
            scored.append((other, rel))
    scored.sort(key=lambda x: -x[1])
    return scored[:top_k]


def _read_and_truncate(project_id: str, path: str, max_chars: int = 8000) -> str:
    """Read page content via backend API and truncate if needed."""
    result = safe_call_llm_wiki(client.get_file_content, project_id, path)
    if result.get("ok") is False:
        return ""
    content = result.get("content", "") or ""
    if len(content) > max_chars:
        content = content[:max_chars] + "\n\n... (truncated)"
    return content


def _extract_frontmatter_title(content: str) -> str:
    """从 YAML frontmatter 中提取 title 字段"""
    if not content.startswith('---'):
        return ''
    end = content.find('---', 3)
    if end == -1:
        return ''
    frontmatter_block = content[3:end]
    for line in frontmatter_block.split('\n'):
        stripped = line.strip()
        if stripped.startswith('title:'):
            return stripped[6:].strip().strip('"').strip("'")
    return ''


def _extract_title_from_content(content: str, wiki_path: str) -> str:
    """从文件内容中提取 title：frontmatter title: > 第一个 # 标题 > 文件名"""
    # 1. 尝试从 YAML frontmatter 中提取 title:
    frontmatter_title = _extract_frontmatter_title(content)
    if frontmatter_title:
        return frontmatter_title

    # 2. 回退到第一个 Markdown 标题
    match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
    if match:
        return match.group(1).strip()

    # 3. 回退到文件名
    return os.path.basename(wiki_path).replace('.md', '')


def _get_wiki_file_title(project_id: str, wiki_path: str) -> str:
    """根据 project_id 和 wiki 路径，读取文件内容并提取 title"""
    project_path = _resolve_project_path(project_id)
    if not project_path:
        return os.path.basename(wiki_path).replace('.md', '')

    file_path = os.path.join(project_path, wiki_path)
    if not os.path.exists(file_path):
        return os.path.basename(wiki_path).replace('.md', '')

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception:
        return os.path.basename(wiki_path).replace('.md', '')

    return _extract_title_from_content(content, wiki_path)


# ── Search hit-rate tracking ──────────────────────────────────
_search_stats = {
    "total": 0,
    "hits": 0,
    "misses": 0,
    "errors": 0,
}
_SEARCH_STATS_FLUSH_INTERVAL = 50  # 每 50 次搜索汇总记录一次
_search_stats_lock = threading.Lock()


def _flush_search_stats():
    """将累计搜索命中率统计写入日志"""
    global _search_stats
    with _search_stats_lock:
        if _search_stats["total"] == 0:
            return
        total = _search_stats["total"]
        hits = _search_stats["hits"]
        hit_rate = round(hits / total * 100, 1) if total > 0 else 0
        write_log("search_hit_rate_summary", {
            "total": total,
            "hits": hits,
            "misses": _search_stats["misses"],
            "errors": _search_stats["errors"],
            "hit_rate_pct": hit_rate,
        })
        _search_stats = {"total": 0, "hits": 0, "misses": 0, "errors": 0}


def _record_search_result(result_count: int, is_error: bool = False):
    """记录单次搜索的命中/未命中/错误统计"""
    global _search_stats
    with _search_stats_lock:
        _search_stats["total"] += 1
        if is_error:
            _search_stats["errors"] += 1
        elif result_count > 0:
            _search_stats["hits"] += 1
        else:
            _search_stats["misses"] += 1
        if _search_stats["total"] >= _SEARCH_STATS_FLUSH_INTERVAL:
            _flush_search_stats()


# ── Main search function ─────────────────────────────────────

def _search_project(project_id, query, mode="normal"):
    contexts = []
    sources = []

    if mode == "graph":
        # Step 1: keyword/vector search with content
        search_result = safe_call_llm_wiki(
            client.search, project_id, query, top_k=10, include_content=True
        )
        if search_result.get("ok") is False:
            err_detail = search_result.get("error", "unknown error")
            write_log(f"_search_project[{mode}]", {"project_id": project_id, "query": query[:100], "status": "KMA_BACKEND_ERROR", "error": str(err_detail)[:200]}, "error")
            _record_search_result(0, is_error=True)
            return contexts, sources

        results = search_result.get("results", [])
        if not results:
            write_log(f"_search_project[{mode}]", {"project_id": project_id, "query": query[:100], "status": "NO_RESULTS", "result_count": 0}, "warning")
            _record_search_result(0)
            return contexts, sources

        write_log(f"_search_project[{mode}]", {"project_id": project_id, "query": query[:100], "status": "SEARCH_OK", "result_count": len(results)}, "info")

        # Step 2: build graph & expand
        graph_result = safe_call_llm_wiki(
            client.get_graph, project_id, limit=1000
        )
        graph = None
        if graph_result.get("ok") is not False:
            graph = WikiGraph(
                graph_result.get("nodes", []),
                graph_result.get("edges", []),
            )

        # Step 2c: get related nodes for each search hit
        seen = set()
        expansions = []  # {title, path, relevance}
        for r in results[:10]:
            r_path = r.get("path", "") or r.get("relPath", "") or r.get("name", "")
            seen.add(r_path)

        if graph:
            for r in results[:10]:
                r_path = r.get("path", "") or r.get("relPath", "") or r.get("name", "")
                hit_node = graph.find_node_by_path(r_path)
                if hit_node is None:
                    continue
                for related_node, relevance in _get_related_nodes(hit_node, graph, top_k=3):
                    npath = related_node.path or ""
                    if npath in seen:
                        continue
                    if not npath:
                        continue
                    expansions.append({
                        "title": related_node.label,
                        "path": npath,
                        "relevance": relevance,
                    })
                    seen.add(npath)

        expansions.sort(key=lambda x: -x["relevance"])

        # Step 3: read content with priority
        title_match_pages = []
        content_match_pages = []
        for r in results:
            if r.get("titleMatch", False) is not None and r.get("titleMatch"):
                title_match_pages.append(r)
            else:
                content_match_pages.append(r)

        context_index = 0

        # P0: titleMatch=true search results (use content from search response)
        for r in title_match_pages:
            r_path = r.get("path", "") or r.get("relPath", "") or r.get("name", "")
            r_content = r.get("content", "")
            r_score = r.get("score", 0)
            if r_content and r_score >= 0.1:  # 最低相关性阈值
                sources.append(r_path)
                context_index += 1
                contexts.append({
                    "index": context_index,
                    "path": r_path,
                    "content": r_content,
                    "score": r_score,
                    "priority": "P0_titleMatch",
                    "project_id": project_id,
                })

        # P1: titleMatch=false search results (require higher score)
        for r in content_match_pages:
            r_path = r.get("path", "") or r.get("relPath", "") or r.get("name", "")
            r_content = r.get("content", "")
            r_score = r.get("score", 0)
            if r_content and r_score >= 0.3:  # 内容匹配要求更高阈值
                sources.append(r_path)
                context_index += 1
                contexts.append({
                    "index": context_index,
                    "path": r_path,
                    "content": r_content,
                    "score": r_score,
                    "priority": "P1_contentMatch",
                    "project_id": project_id,
                })

        # P2: graph-expanded pages (require meaningful relevance)
        for exp in expansions:
            if exp["relevance"] < 0.2:  # 图扩展也需要最低相关性
                continue
            exp_path = exp["path"]
            exp_content = _read_and_truncate(project_id, exp_path)
            if exp_content:
                sources.append(exp_path)
                context_index += 1
                contexts.append({
                    "index": context_index,
                    "path": exp_path,
                    "content": exp_content,
                    "score": exp["relevance"],
                    "priority": "P2_graphExpanded",
                    "project_id": project_id,
                })

        # P3: overview.md fallback (when P0~P2 all empty)
        if not contexts:
            overview_content = _read_and_truncate(project_id, "wiki/overview.md")
            if overview_content:
                sources.append("wiki/overview.md")
                context_index += 1
                contexts.append({
                    "index": context_index,
                    "path": "wiki/overview.md",
                    "content": overview_content,
                    "score": 0.0,
                    "priority": "P3_overviewFallback",
                    "project_id": project_id,
                })

    else:
        search_result = safe_call_llm_wiki(
            client.search, project_id, query, top_k=10, include_content=True
        )
        if search_result.get("ok") is False:
            err_detail = search_result.get("error", "unknown error")
            write_log(f"_search_project[{mode}]", {"project_id": project_id, "query": query[:100], "status": "KMA_BACKEND_ERROR", "error": str(err_detail)[:200]}, "error")
            _record_search_result(0, is_error=True)
            return contexts, sources

        results = search_result.get("results", [])
        if not results:
            write_log(f"_search_project[{mode}]", {"project_id": project_id, "query": query[:100], "status": "NO_RESULTS", "result_count": 0}, "warning")
            _record_search_result(0)
            return contexts, sources

        write_log(f"_search_project[{mode}]", {"project_id": project_id, "query": query[:100], "status": "OK", "result_count": len(results)}, "info")
        for idx, r in enumerate(results):
            content = r.get("content", "")
            path = r.get("path", "") or r.get("relPath", "") or r.get("name", "")
            contexts.append(
                {"index": idx + 1, "path": path, "content": content, "score": r.get("score", 0), "project_id": project_id}
            )
            sources.append(path)

    _record_search_result(len(contexts))
    return contexts, sources


def _enrich_sources_and_cited_pages(contexts, sources, default_project_id):
    """
    为 sources 和 cited_pages 添加 title 字段。
    sources 从字符串列表转为对象列表；cited_pages 增加 title 字段。
    """
    # 构建 path -> project_id 映射
    path_to_pid = {}
    for c in contexts:
        path = c.get("path", "")
        if path:
            path_to_pid[path] = c.get("project_id", default_project_id)

    # 缓存已解析的 title，避免重复读取文件
    title_cache = {}
    # 缓存 project_id -> project_path，避免重复调用 _resolve_project_path
    project_path_cache = {}

    def _resolve_title(wiki_path):
        if wiki_path in title_cache:
            return title_cache[wiki_path]
        pid = path_to_pid.get(wiki_path, default_project_id)
        if pid not in project_path_cache:
            project_path_cache[pid] = _resolve_project_path(pid)
        project_path = project_path_cache[pid]
        if not project_path:
            title = os.path.basename(wiki_path).replace('.md', '')
        else:
            file_path = os.path.join(project_path, wiki_path)
            if not os.path.exists(file_path):
                title = os.path.basename(wiki_path).replace('.md', '')
            else:
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                except Exception:
                    title = os.path.basename(wiki_path).replace('.md', '')
                else:
                    title = _extract_title_from_content(content, wiki_path)
        title_cache[wiki_path] = title
        return title

    # 丰富 sources：字符串 -> 对象
    enriched_sources = []
    for s in sources:
        wiki_path = s.get("path", s) if isinstance(s, dict) else s
        if isinstance(s, str):
            wiki_path = s
        enriched_sources.append({
            "path": wiki_path,
            "title": _resolve_title(wiki_path),
            "platform": "local",
        })

    # 丰富 cited_pages：增加 title 字段
    enriched_cited = []
    for c in contexts:
        wiki_path = c.get("path", "")
        enriched_cited.append({
            "index": c["index"],
            "path": wiki_path,
            "project_id": c.get("project_id", default_project_id),
            "title": _resolve_title(wiki_path),
        })

    return enriched_sources, enriched_cited


@app.route("/api/v1/chat", methods=["POST"])
def chat_qa():
    data = request.get_json() or {}
    query = data.get("query", "")
    project_id = data.get("project_id")
    project_ids = data.get("project_ids")
    mode = data.get("mode", "normal")

    if not query:
        return jsonify({"success": False, "message": "query is required"}), 400

    # 获取模型名用于统计
    llm_cfg_search = load_llm_config()
    perf_model = llm_cfg_search.get("llm_model", "")

    if project_ids and isinstance(project_ids, list) and len(project_ids) > 0:
        write_log("chat_qa", {"query": query[:100], "project_ids": project_ids, "mode": mode, "project_ids_count": len(project_ids)}, "info")
        all_contexts = []
        all_sources = []
        with track_step("chat_query", "search", model=perf_model) as step:
            for pid in project_ids:
                write_log("chat_qa_search", {"project_id": pid, "query": query[:100]}, "info")
                pid_contexts, pid_sources = _search_project(pid, query, mode)
                all_contexts.extend(pid_contexts)
                all_sources.extend(pid_sources)
            step.set_detail("project_count", len(project_ids))
            step.set_detail("result_count", len(all_contexts))

        # 多知识库结果合并：去重、排序、截断、重编号
        if len(project_ids) > 1:
            # 按 path 去重，保留最高分
            seen_paths = {}
            for ctx in all_contexts:
                path = ctx.get("path", "")
                if path not in seen_paths or ctx.get("score", 0) > seen_paths[path].get("score", 0):
                    seen_paths[path] = ctx
            deduped = list(seen_paths.values())

            # 按分数降序排列
            deduped.sort(key=lambda c: c.get("score", 0), reverse=True)

            # 截断到 top 20，防止 context 过长
            deduped = deduped[:20]

            # 重新编号
            for i, ctx in enumerate(deduped):
                ctx["index"] = i + 1

            contexts = deduped
            sources = [c.get("path", "") for c in deduped]
        else:
            contexts = all_contexts
            sources = all_sources
    else:
        project = _get_current_project()
        if project_id is None and project is None:
            return jsonify(
                {"success": False, "message": "No active project found. Please create or open a knowledge base project first"}
            ), 404

        if project_id is None:
            project_id = project.get("id", "")

        if not project_id:
            return jsonify(
                {"success": False, "message": "Cannot determine project ID, please specify project_id"}
            ), 400

        with track_step("chat_query", "search", model=perf_model) as step:
            contexts, sources = _search_project(project_id, query, mode)
            step.set_detail("result_count", len(contexts))

    if not contexts:
        return jsonify(
            {
                "success": True,
                "data": {
                    "query": query,
                    "answer": "No content related to your question was found in the selected knowledge base(s). Please try different keywords or import more data first.",
                    "sources": [],
                    "cited_pages": [],
                    "mode": mode,
                },
            }
        )

    llm_cfg = load_llm_config()
    llm_url = llm_cfg.get("llm_url", "")
    llm_api_key = llm_cfg.get("llm_api_key", "")
    llm_model = llm_cfg.get("llm_model", "")

    _log(f"[chat_qa] resolved llm_config: model={llm_model}, url={llm_url[:60]}, has_key={bool(llm_api_key)}")

    if not llm_url or not llm_model:
        combined = "\n\n---\n\n".join(
            f"### [{c['index']}] {c['path']} (score: {c.get('score', 0):.2f}, priority: {c.get('priority', '-')})\n{c['content']}"
            for c in contexts
        )
        answer = (
            f"Based on relevant content in the knowledge base, here is a summary:\n\n{combined}\n\n"
            "(LLM not configured, showing raw results above. Please configure an LLM in Settings for smarter answers.)"
        )
        enriched_sources, enriched_cited = _enrich_sources_and_cited_pages(contexts, sources, project_id)
        return jsonify(
            {
                "success": True,
                "data": {
                    "query": query,
                    "answer": answer,
                    "sources": enriched_sources,
                    "cited_pages": enriched_cited,
                    "llm_used": False,
                    "mode": mode,
                },
            }
        )

    # 多知识库场景：查找知识库名称用于标注来源
    is_multi_kb = project_ids and isinstance(project_ids, list) and len(project_ids) > 1
    kb_names = _get_project_names_by_ids(project_ids) if is_multi_kb else {}

    context_text = "\n\n---\n\n".join(
        f"Source {c['index']} (file: {c['path']}, relevance score: {c['score']}{', knowledge base: ' + kb_names.get(c.get('project_id', ''), '') if is_multi_kb else ''}):\n{c['content']}"
        for c in contexts
    )

    if mode == "graph":
        system_prompt = (
            "You are a wiki Q&A assistant powered by knowledge graph search. Answer the user's question based only on the numbered wiki pages below.\n"
            + (f"The following content comes from multiple knowledge bases: {', '.join(kb_names.values())}.\n" if is_multi_kb else "") +
            "Requirements:\n"
            "1. Only use the provided wiki page content to answer the question\n"
            "2. If the content is insufficient, state so clearly\n"
            "3. Cite sources using the [N] notation from the page numbers\n"
            "4. Answers should be clear, accurate, and well-organized\n"
            "5. Append a hidden citation comment at the end: <!-- cited: 1, 2, ... -->"
        )
    else:
        system_prompt = (
            "You are a knowledge base Q&A assistant. Answer the user's question based on the knowledge base content below.\n"
            + (f"The following content comes from multiple knowledge bases: {', '.join(kb_names.values())}.\n" if is_multi_kb else "") +
            "Requirements:\n"
            "1. Only use the provided knowledge base content to answer questions\n"
            "2. If the knowledge base content is insufficient, state so clearly\n"
            "3. Cite sources using the [N] notation from the source numbers\n"
            "4. Answers should be clear, accurate, and well-organized\n"
            "5. Append a hidden citation comment at the end: <!-- cited: 1, 2, ... -->"
        )

    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": f"Knowledge base content:\n\n{context_text}\n\nUser question: {query}",
        },
    ]

    try:
        chat_url = build_chat_completions_url(llm_url)

        headers = {"Content-Type": "application/json"}
        if llm_api_key:
            headers["Authorization"] = f"Bearer {llm_api_key}"

        llm_body = {
            "model": llm_model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 20480,
        }

        # thinking 限制（可配置，默认 0 = 不限制）
        from image_to_desc import get_thinking_limit
        _chat_thinking = get_thinking_limit("chat_qa", 0)
        if _chat_thinking > 0:
            llm_body["enable_thinking"] = True
            llm_body["thinking_budget"] = _chat_thinking

        write_log("chat_qa_request", {
            "query": query[:100],
            "url": chat_url,
            "model": llm_model,
            "has_key": bool(llm_api_key),
        })

        with track_step("chat_query", "llm_generate", model=llm_model) as step:
            llm_resp = requests.post(chat_url, json=llm_body, headers=headers, timeout=600)
            llm_resp.raise_for_status()
            llm_data = llm_resp.json()
            usage = llm_data.get("usage", {})
            step.set_detail("prompt_tokens", usage.get("prompt_tokens", 0))
            step.set_detail("completion_tokens", usage.get("completion_tokens", 0))
            step.set_detail("total_tokens", usage.get("total_tokens", 0))
            step.set_detail("source_count", len(contexts))

        write_log("chat_qa_raw_response", {"data": llm_data})

        choices = llm_data.get("choices", [])
        if not choices:
            answer = "LLM returned no choices. The model may be overloaded or the request was rejected."
        else:
            choice = choices[0]
            finish_reason = choice.get("finish_reason", "")
            answer = choice.get("message", {}).get("content", "")

            if not answer:
                reason_map = {
                    "content_filter": "LLM response was blocked by content filter.",
                    "length": "LLM response hit token limit before generating content.",
                    "stop": "LLM stopped immediately. Model may be overloaded or prompt was rejected.",
                }
                cause = reason_map.get(finish_reason, f"LLM returned empty content (finish_reason={finish_reason}).")
                answer = f"{cause} Please check model configuration or try again later."
            elif finish_reason == "length":
                answer += "\n\n---\n[WARNING] LLM response was truncated because it reached the max_tokens limit. The answer above may be incomplete."

        if not choices or not (choices[0].get("message", {}).get("content") if choices else None):
            write_log("chat_qa_empty_response", {
                "url": chat_url,
                "model": llm_model,
                "has_key": bool(llm_api_key),
                "raw_response": llm_data,
            })

        write_log("chat_qa", {"query": query, "sources_count": len(contexts)})

        enriched_sources, enriched_cited = _enrich_sources_and_cited_pages(contexts, sources, project_id)
        return jsonify(
            {
                "success": True,
                "data": {
                    "query": query,
                    "answer": answer,
                    "sources": enriched_sources,
                    "cited_pages": enriched_cited,
                    "llm_used": True,
                    "model": llm_model,
                    "mode": mode,
                },
            }
        )

    except requests.ConnectionError:
        return jsonify(
            {
                "success": False,
                "message": f"Cannot connect to LLM service ({llm_url}). Please check: 1) API endpoint URL is correct 2) Network is reachable 3) The machine running KMA Server can access this address",
            }
        ), 502
    except requests.Timeout:
        return jsonify(
            {"success": False, "message": "LLM request timed out (120 seconds). Please check if the model service is running or try again later"}
        ), 504
    except requests.HTTPError as e:
        status_code = e.response.status_code if e.response is not None else 0
        detail = ""
        try:
            err_body = e.response.json()
            detail = err_body.get("error", {}).get("message", "") or err_body.get("message", "") or str(err_body)[:200]
        except Exception:
            detail = e.response.text[:200] if e.response is not None else ""
        if status_code == 401:
            detail_msg = (
                f"LLM service authentication failed (HTTP 401).\n"
                f"Request URL: {chat_url}\n"
                f"{'Server response: ' + detail if detail else ''}"
            )
        elif status_code == 404:
            detail_msg = (
                f"LLM API endpoint not found (HTTP 404).\n"
                f"Request URL: {chat_url}\n"
                f"Please verify the API endpoint URL is correct. Some services do not need the extra /v1/chat/completions suffix"
            )
        else:
            detail_msg = f"LLM request failed (HTTP {status_code}). Request URL: {chat_url}"
            if detail:
                detail_msg += f"\nServer response: {detail}"
        write_log("chat_qa_error", {"query": query[:100], "url": chat_url, "status": status_code, "detail": detail})
        return jsonify({"success": False, "message": detail_msg}), 502
    except Exception as e:
        return jsonify(
            {"success": False, "message": f"Error calling LLM: {str(e)}"}
        ), 500


# ============================================================
#  Vector visualization helpers
# ============================================================

def _resolve_project_path(project_id: str) -> Optional[str]:
    result = safe_call_llm_wiki(client.list_projects)
    if not result.get("ok"):
        return None
    projects = result.get("projects", [])
    for p in projects:
        if p.get("id") == project_id:
            return p.get("path", "")
    return None


def _get_lancedb_path(project_path: str) -> str:
    return os.path.join(project_path, ".llm-wiki", "lancedb")


def _project_vectors_2d(project_path: str, max_vectors: int = 2000):
    import lancedb

    db_path = _get_lancedb_path(project_path)
    if not os.path.isdir(db_path):
        return {"ok": False, "error": f"LanceDB not found at {db_path}"}

    db = lancedb.connect(db_path)
    table_names = db.table_names()

    table_name = "wiki_chunks_v2" if "wiki_chunks_v2" in table_names else "wiki_vectors"
    if table_name not in table_names:
        return {"ok": False, "error": "No vector table found in LanceDB"}

    table = db.open_table(table_name)

    columns = ["page_id", "vector"]
    if "wiki_chunks_v2" == table_name:
        columns = ["page_id", "chunk_text", "heading_path", "vector"]

    try:
        df = table.to_pandas()
    except Exception:
        try:
            df = table.to_pandas(columns=columns)
        except Exception as e:
            return {"ok": False, "error": f"Failed to read vectors: {str(e)}"}

    if df.empty:
        return {"ok": False, "error": "No vectors in database"}

    vectors = np.stack(df["vector"].to_numpy())
    n_samples, dim = vectors.shape

    if n_samples > max_vectors:
        indices = np.random.choice(n_samples, max_vectors, replace=False)
        df = df.iloc[indices]
        vectors = vectors[indices]
        n_samples = max_vectors

    mean = vectors.mean(axis=0)
    centered = vectors - mean

    if n_samples >= dim:
        u, s, vt = np.linalg.svd(centered, full_matrices=False)
        coords_2d = centered @ vt[:2].T
    else:
        cov = centered @ centered.T / (dim - 1)
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        top2 = eigenvectors[:, -2:]
        coords_2d = top2.T @ centered
        coords_2d = coords_2d.T

    var_total = np.sum(s ** 2) if n_samples >= dim else np.sum(eigenvalues)
    var_top2 = np.sum(s[:2] ** 2) if n_samples >= dim else np.sum(eigenvalues[-2:])
    explained_variance = float(var_top2 / var_total) if var_total > 0 else 0

    points = []
    for i in range(n_samples):
        row = df.iloc[i]
        pt = {
            "x": float(coords_2d[i, 0]),
            "y": float(coords_2d[i, 1]),
            "page_id": str(row["page_id"]),
        }
        if "chunk_text" in df.columns:
            text = str(row["chunk_text"])[:80]
            pt["chunk_text"] = text
            heading = str(row.get("heading_path", "") or "")
            if heading:
                pt["heading_path"] = heading
        points.append(pt)

    return {
        "ok": True,
        "total_vectors": len(df) if n_samples == len(df) else n_samples,
        "total_all": int(n_samples) if n_samples < len(df) else len(df),
        "dimension": dim,
        "explained_variance_2d": round(explained_variance, 4),
        "table": table_name,
        "points": points,
    }


# ============================================================
#  Vector visualization endpoints
# ============================================================


@app.route("/api/v1/projects/<string:project_id>/vectors/stats", methods=["GET"])
def vector_stats(project_id: str):
    project_path = _resolve_project_path(project_id)
    if not project_path:
        return jsonify({"success": False, "message": "Project not found"}), 404

    db_path = _get_lancedb_path(project_path)
    if not os.path.isdir(db_path):
        return jsonify({"success": True, "data": {"exists": False}})

    try:
        import lancedb
        db = lancedb.connect(db_path)
        table_names = db.table_names()

        v2_exists = "wiki_chunks_v2" in table_names
        v1_exists = "wiki_vectors" in table_names
        table_name = "wiki_chunks_v2" if v2_exists else ("wiki_vectors" if v1_exists else None)

        if not table_name:
            return jsonify({"success": True, "data": {"exists": False, "table_names": table_names}})

        table = db.open_table(table_name)
        row_count = table.count_rows()

        df_sample = table.to_pandas(columns=["vector"], limit=1)
        dim = len(df_sample.iloc[0]["vector"]) if not df_sample.empty else 0

        pages = set()
        try:
            df_pages = table.to_pandas(columns=["page_id"])
            pages = set(df_pages["page_id"].unique())
        except Exception:
            pass

        return jsonify({
            "success": True,
            "data": {
                "exists": True,
                "table": table_name,
                "total_vectors": row_count,
                "dimension": dim,
                "unique_pages": len(pages),
                "v1_exists": v1_exists,
                "v2_exists": v2_exists,
            }
        })
    except ImportError:
        return jsonify({"success": False, "message": "lancedb is not installed"}), 500
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/v1/projects/<string:project_id>/vectors/visualize", methods=["GET"])
def vector_visualize(project_id: str):
    project_path = _resolve_project_path(project_id)
    if not project_path:
        return jsonify({"success": False, "message": "Project not found"}), 404

    max_vectors = request.args.get("max", 2000, type=int)

    try:
        result = _project_vectors_2d(project_path, max_vectors=max_vectors)
    except ImportError:
        return jsonify({"success": False, "message": "lancedb or numpy is not installed"}), 500
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Failed to read vectors")}), 404

    return jsonify({"success": True, "data": result})


# ============================================================
#  性能打点统计可视化 (perf tracker)
# ============================================================

@app.route("/api/v1/perf/files", methods=["GET"])
def perf_files():
    """列出所有性能日志文件"""
    return jsonify({"success": True, "data": list_perf_files()})


@app.route("/api/v1/perf/stats", methods=["GET"])
def perf_stats():
    """返回聚合后的性能统计数据（按 operation + step 分组）"""
    operation_filter = request.args.get("operation", "").strip()
    try:
        data = aggregate_perf_stats(operation_filter or "")
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
    return jsonify({"success": True, "data": data})


@app.route("/api/v1/perf/recent", methods=["GET"])
def perf_recent():
    """返回最近的原始性能记录"""
    limit = request.args.get("limit", 200, type=int)
    operation_filter = request.args.get("operation", "").strip()
    try:
        data = recent_perf_records(limit, operation_filter or "")
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
    return jsonify({"success": True, "data": data})


@app.route("/api/v1/perf/deepeval", methods=["POST"])
def perf_deepeval():
    """触发 DeepEval 检索质量评估并返回结果"""
    try:
        import sys as _sys
        _kb_mgmt_path = os.path.dirname(os.path.abspath(__file__))
        if _kb_mgmt_path not in _sys.path:
            _sys.path.insert(0, _kb_mgmt_path)

        from langgraph_fusion.evaluation.deepeval_evaluator import (
            evaluate_retrieval, compute_batch_statistics, is_available,
        )
        from langgraph_fusion.evaluation.test_dataset import (
            load_test_dataset, create_sample_dataset,
        )
        from langgraph_fusion.config import load_llm_config as _load_llm_config

        if not is_available():
            return jsonify({
                "success": False,
                "message": "DeepEval 未安装。请运行: pip install deepeval"
            }), 500

        data = request.get_json(silent=True) or {}
        dataset_name = data.get("dataset_name", "sample")
        project_path = data.get("project_path", "")
        user_query = data.get("user_query", "")

        # 加载或创建测试数据集
        ds = load_test_dataset(dataset_name)
        if len(ds) == 0 and dataset_name == "sample":
            ds = create_sample_dataset(dataset_name)
        if len(ds) == 0:
            return jsonify({
                "success": False,
                "message": f"测试数据集 '{dataset_name}' 为空或不存在"
            }), 400

        llm_config = _load_llm_config()

        # 如果提供了 project_path，则运行实际融合检索获取上下文
        fusion_search_fn = None
        if project_path and os.path.isdir(project_path):
            try:
                from langgraph_fusion.state import FusionSearchState
                from langgraph_fusion.config import build_fusion_config
                from langgraph_fusion.graph import (
                    build_fusion_search_graph, create_sqlite_checkpointer,
                    run_fusion_search, set_write_log,
                )
                from langgraph_fusion.adapters.embedding_adapter import EmbeddingFactory
                from langgraph_fusion.adapters.vector_store_adapter import ChromaDBAdapter
                from langgraph_fusion.nodes.llama_index_retriever import set_index_registry
                from llama_index.index_registry import IndexRegistry

                wiki_dir = os.path.join(project_path, "raw", "wiki")
                raw_dir = os.path.join(project_path, "raw")
                data_dir = os.path.join(project_path, "raw", "data")
                os.makedirs(data_dir, exist_ok=True)

                config = build_fusion_config(
                    wiki_dir=wiki_dir,
                    raw_dir=raw_dir,
                    data_dir=data_dir,
                    project_ids=[],
                    llm_config=llm_config,
                    enabled_sources={"llama_index": True, "graph_rag": False, "hidesk": False, "web": False},
                    use_deepeval=False,
                )

                chroma = ChromaDBAdapter(config.get("chroma_persist_dir", ""))
                embed_factory = EmbeddingFactory(llm_config)
                registry = IndexRegistry(chroma, embed_factory)
                try:
                    registry.reload_all()
                except Exception:
                    pass
                set_index_registry(registry)

                checkpoint_path = config.get("checkpoint_db_path", "")
                checkpointer = create_sqlite_checkpointer(checkpoint_path) if checkpoint_path else None
                graph = build_fusion_search_graph(checkpointer=checkpointer)

                def run_fusion_for_query(q):
                    import uuid
                    state: FusionSearchState = {
                        "user_query": q,
                        "config": config,
                        "retry_count": 0,
                    }
                    result = run_fusion_search(graph, state, thread_id=str(uuid.uuid4()))
                    sources = result.get("final_sources", [])
                    return sources, result.get("final_answer", "")

                fusion_search_fn = run_fusion_for_query
                _logger.info(f"DeepEval: fusion search pipeline initialized for {project_path}")
            except Exception as e:
                _logger.warning(f"DeepEval: failed to init fusion search pipeline: {e}")

        # 对每个测试用例运行评估
        results = []
        for i, case in enumerate(ds.cases):
            query = user_query or case.get("query", "")
            expected_contexts = case.get("expected_contexts", [])
            expected_output = case.get("expected_output", "")

            if fusion_search_fn:
                try:
                    retrieved_sources, actual_output = fusion_search_fn(query)
                    retrieved_contexts = [
                        {"text": s.get("text", s.get("content", "")), "source": s.get("source", "")}
                        for s in retrieved_sources
                    ]
                    if not actual_output:
                        actual_output = expected_output
                except Exception as e:
                    _logger.warning(f"DeepEval: fusion search failed for query '{query[:50]}...': {e}")
                    retrieved_contexts = [{"text": ctx} for ctx in expected_contexts]
                    actual_output = expected_output
            else:
                retrieved_contexts = [{"text": ctx} for ctx in expected_contexts]
                actual_output = expected_output

            result = evaluate_retrieval(
                query=query,
                retrieved_contexts=retrieved_contexts,
                expected_contexts=expected_contexts,
                actual_output=actual_output,
                expected_output=expected_output,
                llm_config=llm_config,
            )
            result["case_index"] = i
            result["query"] = query[:100]
            result["tags"] = case.get("tags", [])
            result["retrieval_count"] = len(retrieved_contexts)
            results.append(result)

        statistics = compute_batch_statistics(results)

        return jsonify({
            "success": True,
            "data": {
                "results": results,
                "statistics": statistics,
                "dataset_name": dataset_name,
                "total_cases": len(results),
                "used_fusion_search": bool(fusion_search_fn),
            }
        })
    except Exception as e:
        _logger.error(f"DeepEval perf endpoint error: {e}", exc_info=True)
        return jsonify({"success": False, "message": str(e)}), 500


# ============================================================
#  Debug / 可视化面板 (LangGraph + LlamaIndex)
# ============================================================

import trace_recorder


@app.route("/debug", methods=["GET"])
def debug_panel():
    """可视化调试面板入口页面"""
    return render_template("debug.html")


@app.route("/api/v1/debug/langgraph/graph", methods=["GET"])
def debug_langgraph_graph():
    """
    返回 LangGraph 融合检索图的节点/边结构（JSON），
    前端可渲染为可视化流程图。
    """
    try:
        import sys as _sys
        _kb_mgmt_path = os.path.dirname(os.path.abspath(__file__))
        if _kb_mgmt_path not in _sys.path:
            _sys.path.insert(0, _kb_mgmt_path)

        from langgraph_fusion.graph import build_fusion_search_graph
        from langgraph_fusion.state import FusionSearchState
        from langgraph.graph import StateGraph, END

        workflow = StateGraph(FusionSearchState)
        from langgraph_fusion.nodes.intent_parser import intent_parser
        from langgraph_fusion.nodes.query_rewriter import query_rewriter
        from langgraph_fusion.nodes.llama_index_retriever import llama_index_retriever
        from langgraph_fusion.nodes.graph_rag_retriever import graph_rag_retriever
        from langgraph_fusion.nodes.hidesk_retriever import hidesk_retriever
        from langgraph_fusion.nodes.web_retriever import web_retriever
        from langgraph_fusion.nodes.fusion_ranker import fusion_ranker
        from langgraph_fusion.nodes.quality_evaluator import quality_evaluator
        from langgraph_fusion.nodes.answer_generator import answer_generator

        nodes = [
            {"id": "intent_parser", "label": "Intent Parser", "type": "entry", "desc": "意图解析"},
            {"id": "query_rewriter", "label": "Query Rewriter", "type": "process", "desc": "HyDE + 关键词"},
            {"id": "llama_index_retriever", "label": "LlamaIndex", "type": "retrieval", "desc": "向量索引检索"},
            {"id": "graph_rag_retriever", "label": "GraphRAG", "type": "retrieval", "desc": "Neo4j 图检索"},
            {"id": "hidesk_retriever", "label": "HiDesk", "type": "retrieval", "desc": "企业知识库"},
            {"id": "web_retriever", "label": "Web Search", "type": "retrieval", "desc": "网络搜索"},
            {"id": "fusion_ranker", "label": "Fusion Ranker", "type": "process", "desc": "RRF + LLM Rerank"},
            {"id": "quality_evaluator", "label": "Quality Eval", "type": "decision", "desc": "质量评估 + 重试"},
            {"id": "answer_generator", "label": "Answer Gen", "type": "output", "desc": "回答生成"},
        ]

        edges = [
            {"from": "intent_parser", "to": "query_rewriter", "label": ""},
            {"from": "query_rewriter", "to": "llama_index_retriever", "label": "并行"},
            {"from": "query_rewriter", "to": "graph_rag_retriever", "label": "并行"},
            {"from": "query_rewriter", "to": "hidesk_retriever", "label": "并行"},
            {"from": "query_rewriter", "to": "web_retriever", "label": "并行"},
            {"from": "llama_index_retriever", "to": "fusion_ranker", "label": ""},
            {"from": "graph_rag_retriever", "to": "fusion_ranker", "label": ""},
            {"from": "hidesk_retriever", "to": "fusion_ranker", "label": ""},
            {"from": "web_retriever", "to": "fusion_ranker", "label": ""},
            {"from": "fusion_ranker", "to": "quality_evaluator", "label": ""},
            {"from": "quality_evaluator", "to": "answer_generator", "label": "score ≥ 阈值"},
            {"from": "quality_evaluator", "to": "query_rewriter", "label": "重试"},
        ]

        return jsonify({
            "success": True,
            "data": {
                "nodes": nodes,
                "edges": edges,
                "mermaid": export_graph_mermaid_safe(),
            },
        })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


def export_graph_mermaid_safe() -> str:
    """安全导出 Mermaid 源码"""
    try:
        from langgraph_fusion.graph import export_graph_mermaid
        return export_graph_mermaid()
    except Exception:
        return ""


@app.route("/api/v1/debug/llamaindex/overview", methods=["GET"])
def debug_llamaindex_overview():
    """
    返回 LlamaIndex 索引概览：每个索引的名称、文档数、状态。
    """
    try:
        import sys as _sys
        _kb_mgmt_path = os.path.dirname(os.path.abspath(__file__))
        if _kb_mgmt_path not in _sys.path:
            _sys.path.insert(0, _kb_mgmt_path)

        from langgraph_fusion.nodes.llama_index_retriever import _index_registry

        indexes = []
        if _index_registry is None:
            return jsonify({"success": True, "data": {"indexes": [], "note": "Index registry 未初始化"}})

        for name in sorted(_index_registry.list_index_names()):
            idx = _index_registry.get(name)
            if idx is None:
                indexes.append({"name": name, "doc_count": 0, "status": "not_found"})
                continue

            try:
                doc_count = len(idx.docstore.docs) if idx.docstore else 0
                indexes.append({
                    "name": name,
                    "doc_count": doc_count,
                    "status": "loaded",
                })
            except Exception:
                indexes.append({"name": name, "doc_count": 0, "status": "error"})

        return jsonify({"success": True, "data": {"indexes": indexes}})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/v1/debug/llamaindex/documents", methods=["GET"])
def debug_llamaindex_documents():
    """
    浏览指定索引中的文档内容。

    Query params:
        index_name: 索引名称（如 wiki_pages）
        offset: 偏移量 (default 0)
        limit: 返回条数 (default 20)
    """
    index_name = request.args.get("index_name", "").strip()
    offset = request.args.get("offset", 0, type=int)
    limit = min(request.args.get("limit", 20, type=int), 100)

    if not index_name:
        return jsonify({"success": False, "message": "index_name is required"}), 400

    try:
        import sys as _sys
        _kb_mgmt_path = os.path.dirname(os.path.abspath(__file__))
        if _kb_mgmt_path not in _sys.path:
            _sys.path.insert(0, _kb_mgmt_path)

        from langgraph_fusion.nodes.llama_index_retriever import _index_registry

        if _index_registry is None:
            return jsonify({"success": True, "data": {"documents": [], "total": 0}})

        idx = _index_registry.get(index_name)
        if idx is None:
            return jsonify({"success": False, "message": f"Index '{index_name}' not found"}), 404

        docs = list(idx.docstore.docs.values()) if idx.docstore else []
        total = len(docs)
        subset = docs[offset:offset + limit]

        documents = []
        for doc in subset:
            documents.append({
                "doc_id": getattr(doc, "doc_id", str(doc.node_id) if hasattr(doc, "node_id") else ""),
                "text": (doc.text[:500] if hasattr(doc, "text") else str(doc)[:500]),
                "metadata": getattr(doc, "metadata", {}),
            })

        return jsonify({
            "success": True,
            "data": {
                "index_name": index_name,
                "total": total,
                "offset": offset,
                "limit": limit,
                "documents": documents,
            },
        })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/v1/debug/traces", methods=["GET"])
def debug_traces():
    """
    返回最近 fusion_search 的执行 trace。
    """
    limit = min(request.args.get("limit", 20, type=int), trace_recorder.count())
    return jsonify({
        "success": True,
        "data": {
            "traces": trace_recorder.get_recent(limit),
            "total": trace_recorder.count(),
            "max_capacity": trace_recorder.max_capacity(),
        },
    })


@app.route("/api/v1/debug/traces/clear", methods=["POST"])
def debug_traces_clear():
    """清空 trace 记录"""
    count = trace_recorder.clear()
    return jsonify({"success": True, "data": {"cleared": count}})


# ============================================================
#  Project wiki management routes (via client file-system ops)
# ============================================================


@app.route("/api/v1/projects/wiki/pages", methods=["GET"])
def list_project_wiki_pages_v2():
    project_path = request.args.get("project_path")
    if not project_path:
        return jsonify({"success": False, "message": "project_path is required"}), 400
    wiki_dir = os.path.join(project_path, "wiki")
    result = client.list_wiki_pages(wiki_dir)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Unknown error")}), 400
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/wiki/page", methods=["GET"])
def get_project_wiki_page_v2():
    project_path = request.args.get("project_path")
    title = request.args.get("title")
    if not project_path or not title:
        return jsonify({"success": False, "message": "project_path and title are required"}), 400
    wiki_dir = os.path.join(project_path, "wiki")
    result = client.read_wiki_page(wiki_dir, title)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Page not found")}), 404
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/wiki/page/update", methods=["PUT"])
def update_project_wiki_page_v2():
    data = request.get_json() or {}
    project_path = data.get("project_path")
    title = data.get("title")
    content = data.get("content", "")
    if not project_path or not title:
        return jsonify({"success": False, "message": "project_path and title are required"}), 400
    wiki_dir = os.path.join(project_path, "wiki")
    result = client.update_wiki_page(wiki_dir, title, content)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Page not found")}), 404
    write_log("update_project_wiki_page_v2", {"project_path": project_path, "title": title})
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/projects/wiki/page/delete", methods=["DELETE"])
def delete_project_wiki_page_v2():
    data = request.get_json() or {}
    project_path = data.get("project_path")
    title = data.get("title")
    if not project_path or not title:
        return jsonify({"success": False, "message": "project_path and title are required"}), 400
    wiki_dir = os.path.join(project_path, "wiki")
    result = client.delete_wiki_page(wiki_dir, title)
    if not result.get("ok"):
        return jsonify({"success": False, "message": result.get("error", "Page not found")}), 404
    write_log("delete_project_wiki_page_v2", {"project_path": project_path, "title": title})
    return jsonify({"success": True, "data": result})


# ============================================================
#  公共知识库同步 (Common KB Sync) routes
# ============================================================


@app.route("/api/v1/common-kb/servers", methods=["GET"])
def list_common_kb_servers():
    """列出所有已配置的公共知识库服务器"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500
    servers = list_servers()
    return jsonify({"success": True, "data": servers})


@app.route("/api/v1/common-kb/config", methods=["GET"])
def get_common_kb_config():
    """获取公共知识库配置，可选 ?name= 指定服务器名称"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500
    name = request.args.get("name")
    config = load_common_kb_config(name)
    # 隐藏密码明文返回
    safe_config = dict(config)
    safe_config["password"] = "***" if config.get("password") else ""
    return jsonify({"success": True, "data": safe_config})


@app.route("/api/v1/common-kb/config", methods=["PUT"])
def update_common_kb_config():
    """更新公共知识库配置，可传入 name 字段指定服务器名称"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500
    data = request.get_json() or {}
    name = data.get("name")
    current = load_common_kb_config(name)
    allowed_keys = ["host", "port", "username", "password", "remote_path", "local_path"]
    for key in allowed_keys:
        if key in data:
            current[key] = data[key]
    save_common_kb_config(current, name)
    write_log("update_common_kb_config", {"name": name, "keys": list(data.keys())})
    return jsonify({"success": True, "data": "配置已保存"})


@app.route("/api/v1/common-kb/config", methods=["DELETE"])
def delete_common_kb_config():
    """删除指定名称的公共知识库服务器配置，?name= 指定服务器名称"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500
    name = request.args.get("name")
    if not name:
        return jsonify({"success": False, "message": "缺少 name 参数"}), 400
    result = delete_server_config(name)
    if result:
        write_log("delete_common_kb_config", {"name": name})
        return jsonify({"success": True, "data": f"已删除服务器配置: {name}"})
    else:
        return jsonify({"success": False, "message": f"删除失败: 服务器 {name} 不存在或为内置配置"}), 404


@app.route("/api/v1/common-kb/check-local", methods=["GET"])
def check_common_kb_local():
    """检测本地公共知识库是否存在，可选 ?name= 指定服务器名称"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500
    name = request.args.get("name")
    config = load_common_kb_config(name)
    local_path = config.get("local_path", "")
    result = check_local_kb(local_path)
    return jsonify({"success": True, "data": result})


@app.route("/api/v1/common-kb/check-server", methods=["POST"])
def check_common_kb_server():
    """检测服务器是否可达及 SSH 认证"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500
    data = request.get_json() or {}
    config = load_common_kb_config()

    host = data.get("host") or config.get("host", "")
    port = int(data.get("port") or config.get("port", 22))
    username = data.get("username") or config.get("username", "root")
    password = data.get("password") or config.get("password", "")

    if not host:
        return jsonify({"success": False, "message": "未配置服务器 IP"}), 400

    # TCP 连接检测
    reachable = check_server_reachable(host, port)
    if not reachable["reachable"]:
        return jsonify({
            "success": True, "data": {
                "server_reachable": False,
                "ssh_authenticated": False,
                "error": reachable.get("error", "服务器不可达"),
            }
        })

    # SSH 认证检测
    auth = check_server_auth(host, port, username, password)
    return jsonify({
        "success": True, "data": {
            "server_reachable": True,
            "ssh_authenticated": auth.get("authenticated", False),
            "error": auth.get("error") if not auth.get("authenticated") else None,
        }
    })


@app.route("/api/v1/common-kb/remote-tree", methods=["POST"])
def get_remote_tree():
    """获取远程服务器目录树结构，供用户勾选下载"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500

    data = request.get_json() or {}
    config = load_common_kb_config()

    host = data.get("host") or config.get("host", "")
    port = int(data.get("port") or config.get("port", 22))
    username = data.get("username") or config.get("username", "root")
    password = data.get("password") or config.get("password", "")
    remote_path = data.get("remote_path") or config.get("remote_path", "")

    if not host or not remote_path:
        return jsonify({"success": False, "message": "缺少服务器配置"}), 400

    write_log("get_remote_tree", {"host": host, "remote_path": remote_path})
    result = list_remote_tree(host, port, username, password, remote_path)
    return jsonify(result)


@app.route("/api/v1/common-kb/sync", methods=["POST"])
def sync_common_kb():
    """执行公共知识库同步（支持传 selected_paths 进行部分下载）

    返回 task_id，前端可通过 /api/v1/common-kb/sync-progress?task_id=xxx 轮询进度。
    """
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500

    data = request.get_json() or {}
    config = load_common_kb_config()

    # 允许请求中覆盖配置
    if data:
        allowed_keys = ["host", "port", "username", "password", "remote_path", "local_path"]
        for key in allowed_keys:
            if key in data:
                config[key] = data[key]
        save_common_kb_config(config)

    selected_paths = data.get("selected_paths", None)
    task_id = str(uuid.uuid4())

    write_log("sync_common_kb", {"host": config.get("host"), "local_path": config.get("local_path"), "task_id": task_id})

    def _run_sync():
        result = run_full_sync(config, selected_paths=selected_paths, task_id=task_id)

        # 同步完成后，递归遍历 local_path 下的目录树，将知识库根目录注册并触发 rescan
        local_path = config.get("local_path", "")
        if local_path and result.get("status") in ("already_exists", "synced") and os.path.isdir(local_path):
            def _is_kb_root(dir_path: str) -> bool:
                """判断目录是否是知识库根目录（以 schema.md 为标志）"""
                return os.path.isfile(os.path.join(dir_path, "schema.md"))

            def _register_kb_dirs(root_dir: str):
                """递归遍历目录树，将含 schema.md 的知识库根目录注册到 LLM Wiki 后端

                不能用“叶子节点（无子目录）”判断：知识库根目录本身含 wiki/、raw/
                等子目录，会被判为非叶子而跳过，一直递归到深层无 schema.md 的目录，
                validate_project 失败被静默吞掉，导致知识库根目录从未注册、前端
                列表看不到对应卡片。
                """
                try:
                    entries = sorted(os.listdir(root_dir))
                except OSError:
                    return

                for entry in entries:
                    sub_path = os.path.join(root_dir, entry)
                    if not os.path.isdir(sub_path):
                        continue
                    if _is_kb_root(sub_path):
                        # 知识库根目录 → 注册，不再向下递归（避免误注册其内部子目录）
                        try:
                            open_result = client.open_project_by_path(sub_path)
                            project_id = open_result.get("project_id")
                            if project_id:
                                safe_call_llm_wiki(client.rescan_sources, project_id)
                        except Exception:
                            pass
                    else:
                        # 非知识库目录 → 继续递归查找
                        _register_kb_dirs(sub_path)

            _register_kb_dirs(local_path)

    # 在后台线程中执行同步
    thread = threading.Thread(target=_run_sync, daemon=True)
    thread.start()

    return jsonify({"success": True, "data": {"task_id": task_id, "message": "同步已在后台启动"}})


@app.route("/api/v1/common-kb/sync-progress", methods=["GET"])
def get_sync_progress_endpoint():
    """获取指定同步任务的进度"""
    if not HAS_COMMON_KB_SYNC:
        return jsonify({"success": False, "message": "common_kb_sync 模块未安装"}), 500

    task_id = request.args.get("task_id", "")
    if not task_id:
        return jsonify({"success": False, "data": {"status": "error", "message": "缺少 task_id"}}), 400

    progress = get_sync_progress(task_id)
    return jsonify({"success": True, "data": progress})


# ============================================================
#  Web Search API (Python DDGS backend)
# ============================================================

def _get_websearch_config_file():
    return os.path.join(_get_data_dir(), "websearch_config.json")


def _load_websearch_config():
    config_file = _get_websearch_config_file()
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {
                    "engine": data.get("engine") or "duckduckgo",
                    "api_key": data.get("api_key") or "",
                    "searxng_url": data.get("searxng_url") or "",
                }
        except (json.JSONDecodeError, IOError):
            pass
    return {"engine": "duckduckgo", "api_key": "", "searxng_url": ""}


def _save_websearch_config(config):
    os.makedirs(_get_data_dir(), exist_ok=True)
    with open(_get_websearch_config_file(), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def _dedupe_search_results(results):
    deduped = []
    seen = set()
    for item in results or []:
        url = (item.get("url") or "").strip()
        title = (item.get("title") or "").strip()
        key = url or title.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _do_duckduckgo_search(query, max_results=10):
    results = []
    diagnostics = {"engine": "duckduckgo", "requested": max_results, "raw_count": 0, "error": ""}
    try:
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS

        has_chinese = bool(re.search(r"[\u4e00-\u9fff]", query or ""))
        region = "cn-zh" if has_chinese else "wt-wt"
        with DDGS() as ddgs:
            for item in ddgs.text(query, region=region, max_results=max_results):
                results.append({
                    "title": item.get("title", ""),
                    "url": item.get("href", "") or item.get("url", ""),
                    "snippet": item.get("body", "") or item.get("content", ""),
                    "engine": "duckduckgo",
                })
        diagnostics["raw_count"] = len(results)
    except ImportError as exc:
        diagnostics["error"] = str(exc)
        write_log("web_search_missing_dependency", {"engine": "duckduckgo", "error": str(exc)})
    except Exception as exc:
        diagnostics["error"] = str(exc)[:300]
        write_log("web_search_error", {"engine": "duckduckgo", "query": query, "error": str(exc)[:300]})
    return results, diagnostics


def _do_searxng_search(query, max_results=10, searxng_url=""):
    if not searxng_url:
        return [], {"engine": "searxng", "requested": max_results, "raw_count": 0, "error": "searxng_url is empty"}
    results = []
    diagnostics = {"engine": "searxng", "requested": max_results, "raw_count": 0, "error": "", "searxng_url": searxng_url}
    try:
        params = {"q": query, "format": "json", "categories": "general"}
        if re.search(r"[\u4e00-\u9fff]", query or ""):
            params["language"] = "zh-CN"
        resp = requests.get(f"{searxng_url.rstrip('/')}/search", params=params, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        for item in (data.get("results") or [])[:max_results]:
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": item.get("content", ""),
                "engine": item.get("engine", "searxng"),
            })
        diagnostics["raw_count"] = len(results)
    except Exception as exc:
        diagnostics["error"] = str(exc)[:300]
        write_log("web_search_error", {"engine": "searxng", "query": query, "error": str(exc)[:300]})
    return results, diagnostics


def _do_bing_search(query, max_results=10, api_key=""):
    if not api_key:
        return [], {"engine": "bing", "requested": max_results, "raw_count": 0, "error": "bing api_key is empty"}
    results = []
    diagnostics = {"engine": "bing", "requested": max_results, "raw_count": 0, "error": "", "api_key_set": bool(api_key)}
    try:
        resp = requests.get(
            "https://api.bing.microsoft.com/v7.0/search",
            headers={"Ocp-Apim-Subscription-Key": api_key},
            params={"q": query, "count": max_results, "mkt": "zh-CN", "responseFilter": "WebPages"},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        for item in data.get("webPages", {}).get("value", [])[:max_results]:
            results.append({
                "title": item.get("name", ""),
                "url": item.get("url", ""),
                "snippet": item.get("snippet", ""),
                "engine": "bing",
            })
        diagnostics["raw_count"] = len(results)
    except Exception as exc:
        diagnostics["error"] = str(exc)[:300]
        write_log("web_search_error", {"engine": "bing", "query": query, "error": str(exc)[:300]})
    return results, diagnostics


def _do_web_search(query, max_results=10, engine=None, searxng_url=None, api_key=None):
    config = _load_websearch_config()
    selected_engine = (engine or config.get("engine") or "duckduckgo").lower()
    selected_searxng = searxng_url if searxng_url is not None else config.get("searxng_url", "")
    selected_api_key = api_key if api_key is not None else config.get("api_key", "")

    diagnostics = {
        "requested_engine": selected_engine,
        "engine": selected_engine,
        "query": query,
        "requested": max_results,
        "raw_count": 0,
        "deduped_count": 0,
        "kept_count": 0,
        "fallback_used": False,
        "attempts": [],
        "errors": [],
    }

    if selected_engine == "searxng":
        results, attempt_diag = _do_searxng_search(query, max_results, selected_searxng)
        diagnostics["attempts"].append(attempt_diag)
        if results:
            deduped = _dedupe_search_results(results)
            diagnostics.update({"engine": selected_engine, "raw_count": len(results), "deduped_count": len(deduped), "kept_count": min(len(deduped), max_results)})
            return deduped[:max_results], selected_engine, diagnostics
        diagnostics["fallback_used"] = True
        if attempt_diag.get("error"):
            diagnostics["errors"].append(attempt_diag["error"])
        results, fallback_diag = _do_duckduckgo_search(query, max_results)
        diagnostics["attempts"].append(fallback_diag)
        deduped = _dedupe_search_results(results)
        diagnostics.update({"engine": "duckduckgo", "raw_count": len(results), "deduped_count": len(deduped), "kept_count": min(len(deduped), max_results)})
        if fallback_diag.get("error"):
            diagnostics["errors"].append(fallback_diag["error"])
        return deduped[:max_results], "duckduckgo", diagnostics

    if selected_engine == "bing":
        results, attempt_diag = _do_bing_search(query, max_results, selected_api_key)
        diagnostics["attempts"].append(attempt_diag)
        if results:
            deduped = _dedupe_search_results(results)
            diagnostics.update({"engine": selected_engine, "raw_count": len(results), "deduped_count": len(deduped), "kept_count": min(len(deduped), max_results)})
            return deduped[:max_results], selected_engine, diagnostics
        diagnostics["fallback_used"] = True
        if attempt_diag.get("error"):
            diagnostics["errors"].append(attempt_diag["error"])
        results, fallback_diag = _do_duckduckgo_search(query, max_results)
        diagnostics["attempts"].append(fallback_diag)
        deduped = _dedupe_search_results(results)
        diagnostics.update({"engine": "duckduckgo", "raw_count": len(results), "deduped_count": len(deduped), "kept_count": min(len(deduped), max_results)})
        if fallback_diag.get("error"):
            diagnostics["errors"].append(fallback_diag["error"])
        return deduped[:max_results], "duckduckgo", diagnostics

    results, attempt_diag = _do_duckduckgo_search(query, max_results)
    diagnostics["attempts"].append(attempt_diag)
    deduped = _dedupe_search_results(results)
    diagnostics.update({"engine": "duckduckgo", "raw_count": len(results), "deduped_count": len(deduped), "kept_count": min(len(deduped), max_results)})
    if attempt_diag.get("error"):
        diagnostics["errors"].append(attempt_diag["error"])
    return deduped[:max_results], "duckduckgo", diagnostics


@app.route("/api/v1/websearch-config", methods=["GET"])
def get_websearch_config():
    config = _load_websearch_config()
    safe_config = {k: v for k, v in config.items() if k != "api_key"}
    safe_config["api_key_set"] = bool(config.get("api_key"))
    return jsonify({"success": True, "data": safe_config})


@app.route("/api/v1/websearch-config", methods=["POST"])
def save_websearch_config_api():
    data = request.get_json() or {}
    current = _load_websearch_config()
    if "engine" in data:
        engine = str(data.get("engine") or "").lower()
        if engine not in {"duckduckgo", "bing", "searxng"}:
            return jsonify({"success": False, "message": f"Unsupported web search engine: {engine}"}), 400
        current["engine"] = engine
    if "api_key" in data:
        current["api_key"] = data.get("api_key") or ""
    if "searxng_url" in data:
        current["searxng_url"] = data.get("searxng_url") or ""
    _save_websearch_config(current)
    return jsonify({"success": True, "message": "Web search config saved"})


@app.route("/api/v1/web-search", methods=["POST"])
def web_search():
    data = request.get_json() or {}
    query = str(data.get("query") or "").strip()
    if not query:
        return jsonify({"success": False, "message": "query is required"}), 400
    max_results = int(data.get("max_results") or 10)
    max_results = max(1, min(max_results, 30))
    results, engine_used, diagnostics = _do_web_search(
        query,
        max_results=max_results,
        engine=data.get("engine"),
        searxng_url=data.get("searxng_url") or data.get("searxngUrl"),
        api_key=data.get("api_key"),
    )
    write_log("web_search", {"query": query, "engine": engine_used, "results_count": len(results), "diagnostics": diagnostics})
    return jsonify({"success": True, "data": {"results": results, "query": [query], "engine": engine_used, "diagnostics": diagnostics}})


# ============================================================
#  Unified Multi-Platform Search
# ============================================================


def _assess_quality(contexts: list, sources: list) -> int:
    """评估搜索结果质量 (0-100)

    评分维度:
    - 结果数量 (0-40): 1条10分，4条及以上满分
    - 平均相关性分数 (0-40): score * 40
    - 内容总长度 (0-20): 200字10分，1000字及以上满分
    """
    if not contexts:
        return 0

    # 数量和长度只能作为辅助信号，避免低相关但数量多的结果触发级联早停。
    count_score = min(len(contexts) * 6, 25)

    scores = []
    for c in contexts:
        try:
            scores.append(float(c.get("score", 0) or 0))
        except Exception:
            scores.append(0.0)
    avg_score = sum(scores) / len(scores) if scores else 0
    max_score = max(scores) if scores else 0
    relevance_score = min(avg_score * 55, 55)

    # 长度分: 总字符数
    total_len = sum(len(c.get("content", "")) for c in contexts)
    if total_len >= 1000:
        length_score = 20
    elif total_len >= 200:
        length_score = int((total_len / 1000) * 20)
    else:
        length_score = 0

    total = count_score + relevance_score + length_score
    if max_score < 0.25:
        total = min(total, 55)
    return int(total)


def _llm_assess_search_quality(query: str, platform: str, results: list) -> dict:
    """Use the configured chat model to judge whether search results can answer the query.

    Returns {"score": int, "reason": str} or {} when LLM quality judging is unavailable.
    """
    if not results:
        return {}

    llm_cfg = load_llm_config()
    llm_url = llm_cfg.get("llm_url", "")
    llm_api_key = llm_cfg.get("llm_api_key", "")
    llm_model = llm_cfg.get("llm_model", "")
    if not llm_url or not llm_model:
        return {}

    snippets = []
    for idx, item in enumerate(results[:8], start=1):
        title = item.get("title") or item.get("path") or item.get("url") or f"result-{idx}"
        url = item.get("url") or ""
        content = item.get("content") or item.get("snippet") or ""
        snippets.append(f"[{idx}] {title}\n{url}\n{str(content)[:900]}")

    system_prompt = (
        "你是搜索质量评估器。请判断给定搜索结果是否足以回答用户问题。\n"
        "只输出 JSON，不要输出解释性文本。JSON 格式："
        "{\"score\":0-100,\"sufficient\":true/false,\"reason\":\"简短原因\",\"missing\":[\"缺失点\"]}\n"
        "评分标准：0-39 基本不相关；40-59 只有少量相关信息；"
        "60-79 基本可回答但可能不完整；80-100 相关、充分、可直接回答。\n"
        "必须重点检查结果是否覆盖用户问题中的关键主题、时间范围、地域/对象和所需数据。"
    )
    user_prompt = (
        f"用户问题：{query}\n\n"
        f"来源平台：{platform}\n\n"
        f"搜索结果：\n" + "\n\n---\n\n".join(snippets)
    )

    try:
        chat_url = build_chat_completions_url(llm_url)
        headers = {"Content-Type": "application/json"}
        if llm_api_key:
            headers["Authorization"] = f"Bearer {llm_api_key}"
        body = {
            "model": llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0,
            "max_tokens": 500,
        }
        resp = requests.post(chat_url, json=body, headers=headers, timeout=45)
        resp.raise_for_status()
        content = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
        match = re.search(r"\{[\s\S]*\}", content or "")
        data = json.loads(match.group(0) if match else content)
        score = int(float(data.get("score", 0) or 0))
        score = max(0, min(100, score))
        return {
            "score": score,
            "sufficient": bool(data.get("sufficient", score >= 60)),
            "reason": str(data.get("reason") or "")[:300],
            "missing": data.get("missing") if isinstance(data.get("missing"), list) else [],
        }
    except Exception as e:
        _log(f"LLM quality assessment error: {e}", "warning")
        return {}


def _search_platform_local(query: str, project_ids: list = None, mode: str = "normal") -> dict:
    """本地知识库搜索适配器"""
    contexts = []
    sources = []

    if project_ids and isinstance(project_ids, list) and len(project_ids) > 0:
        for pid in project_ids:
            pid_contexts, pid_sources = _search_project(pid, query, mode)
            contexts.extend(pid_contexts)
            sources.extend(pid_sources)
    else:
        project = _get_current_project()
        if project:
            pid = project.get("id", "")
            if pid:
                contexts, sources = _search_project(pid, query, mode)

    quality = _assess_quality(contexts, sources)
    return {
        "results": contexts,
        "sources": sources,
        "quality_score": quality,
        "platform": "local",
    }


def _search_platform_hidesk(query: str, domains: list = None) -> dict:
    """HiDesk 搜索 (预留接口)"""
    return {
        "results": [],
        "sources": [],
        "quality_score": 0,
        "platform": "hiDesk",
        "error": "HiDesk 暂未接入",
    }


def _search_platform_haiwen(query: str) -> dict:
    """海问思答 搜索"""
    import asyncio

    async def _do_search():
        if not _haiwen_client.is_authenticated:
            return {
                "results": [],
                "sources": [],
                "quality_score": 0,
                "platform": "haiwen",
                "error": "海问思答未登录，请先登录",
            }

        result = await _haiwen_client.document_search(query)

        if result.get("expired"):
            return {
                "results": [],
                "sources": [],
                "quality_score": 0,
                "platform": "haiwen",
                "error": "海问思答认证已过期，请重新登录",
                "expired": True,
            }

        if not result.get("success"):
            return {
                "results": [],
                "sources": [],
                "quality_score": 0,
                "platform": "haiwen",
                "error": result.get("error", "海问思答搜索失败"),
            }

        documents = result.get("documents", [])
        contexts = []
        for idx, doc in enumerate(documents):
            if isinstance(doc, dict):
                content = doc.get("content", "") or doc.get("text", "") or json.dumps(doc, ensure_ascii=False)[:500]
                contexts.append({
                    "index": idx + 1,
                    "path": doc.get("title", doc.get("source", f"海问文档_{idx+1}")),
                    "content": content[:1000],
                    "score": doc.get("score", 0.7),
                    "url": doc.get("url", ""),
                    "title": doc.get("title", f"海问文档_{idx+1}"),
                })
            elif isinstance(doc, str):
                title = ""
                url = ""
                for line in doc.split("\n"):
                    if line.startswith("标题:"):
                        title = line[3:].strip()
                    elif line.startswith("链接:"):
                        url = line[3:].strip()
                contexts.append({
                    "index": idx + 1,
                    "path": title or f"海问文档_{idx+1}",
                    "content": doc[:1000],
                    "score": 0.7,
                    "url": url,
                    "title": title or f"海问文档_{idx+1}",
                })

        quality = min(len(contexts) * 15, 90)
        return {
            "results": contexts,
            "sources": [],
            "quality_score": quality,
            "platform": "haiwen",
            "document_count": len(documents),
        }

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(_do_search())
    finally:
        loop.close()


def _search_platform_web(query: str, max_results: int = 10) -> dict:
    """联网搜索适配器"""
    results, engine_used, diagnostics = _do_web_search(query, max_results=max_results)
    # 转换为统一格式
    web_contexts = []
    for idx, r in enumerate(results):
        web_contexts.append({
            "index": idx + 1,
            "path": r.get("url", r.get("title", "")),
            "content": r.get("snippet", ""),
            "score": 0.5,
            "url": r.get("url", ""),
            "title": r.get("title", ""),
            "engine": r.get("engine", engine_used),
        })
    quality = min(len(web_contexts) * 8, 80)  # 联网搜索基础质量
    return {
        "results": web_contexts,
        "sources": [],
        "quality_score": quality,
        "platform": "web",
        "diagnostics": diagnostics,
        "engine": engine_used,
    }


def _fetch_web_contents_batch(urls: list, max_per_page: int = 3000, max_workers: int = 5) -> dict:
    """并行抓取多个网页正文内容"""
    results = {}

    def _fetch_one(url):
        try:
            content = _fetch_web_content(url, max_chars=max_per_page, timeout=10)
            return url, content
        except Exception:
            return url, ""

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_fetch_one, url): url for url in urls if url}
        for future in as_completed(futures):
            url, content = future.result()
            if content:
                results[url] = content

    return results


def _build_unified_context(all_platform_results: list, deep_mode: bool = False) -> tuple:
    """构建统一的上下文文本

    Returns: (context_text, unified_sources)
    """
    unified_sources = []
    context_parts = []
    global_idx = 0

    for pr in all_platform_results:
        platform = pr.get("platform", "unknown")
        results = pr.get("results", [])

        for r in results:
            global_idx += 1
            url = r.get("url", "")
            title = r.get("title", r.get("path", ""))
            content = r.get("content", "")
            score = r.get("score", 0)

            unified_sources.append({
                "index": global_idx,
                "platform": platform,
                "title": title,
                "url": url,
                "snippet": content[:200] if content else "",
                "score": score,
                "project_id": r.get("project_id", ""),
            })

            if content:
                source_label = f"[{global_idx}] [{platform}] {title}"
                if url:
                    source_label += f" ({url})"
                context_parts.append(f"{source_label}:\n{content}")

    context_text = "\n\n---\n\n".join(context_parts)
    return context_text, unified_sources


def _llm_synthesize(query: str, context_text: str, unified_sources: list, mode: str, platforms_used: list = None) -> str:
    """调用 LLM 综合分析搜索结果"""
    llm_cfg = load_llm_config()
    llm_url = llm_cfg.get("llm_url", "")
    llm_api_key = llm_cfg.get("llm_api_key", "")
    llm_model = llm_cfg.get("llm_model", "")

    if not llm_url or not llm_model:
        return ""

    if mode == "deep":
        system_prompt = (
            "你是一个多源信息综合分析助手。请根据以下来自不同平台的搜索结果，"
            "对用户的问题进行深度分析和综合回答。\n\n"
            "要求：\n"
            "1. 整合所有平台的信息，提供全面、准确的答案\n"
            "2. 使用 [N] 格式引用信息来源编号\n"
            "3. 如果不同来源有矛盾信息，请指出并分析\n"
            "4. 在回答末尾追加隐藏引用注释: <!-- cited: 1, 2, ... -->\n"
            "5. 回答要条理清晰，使用 Markdown 格式"
        )
    else:
        system_prompt = (
            "你是一个知识问答助手。请根据以下搜索结果回答用户问题。\n\n"
            "要求：\n"
            "1. 基于提供的搜索结果进行回答\n"
            "2. 使用 [N] 格式引用来源编号\n"
            "3. 如果信息不足，请明确说明\n"
            "4. 在回答末尾追加隐藏引用注释: <!-- cited: 1, 2, ... -->\n"
            "5. 回答要简洁准确"
        )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"搜索结果：\n\n{context_text}\n\n用户问题：{query}"},
    ]

    try:
        chat_url = build_chat_completions_url(llm_url)
        headers = {"Content-Type": "application/json"}
        if llm_api_key:
            headers["Authorization"] = f"Bearer {llm_api_key}"

        llm_body = {
            "model": llm_model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 8192 if mode == "deep" else 4096,
        }

        write_log("unified_search_llm", {"query": query[:100], "mode": mode, "sources_count": len(unified_sources)})

        llm_resp = requests.post(chat_url, json=llm_body, headers=headers, timeout=120)
        llm_resp.raise_for_status()
        llm_data = llm_resp.json()

        answer = llm_data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return answer or ""

    except Exception as e:
        _log(f"LLM synthesis error: {e}", "warning")
        return ""

@app.route("/api/v1/unified-search", methods=["POST"])
def unified_search():
    """统一多平台搜索端点

    请求:
    {
        "query": "用户问题",
        "mode": "normal" | "deep",
        "platforms": {"local": true, "hiDesk": false, "haiwen": false, "webSearch": true},
        "project_ids": ["project1"],
        "domains": []
    }
    """
    data = request.get_json() or {}
    query = str(data.get("query") or "").strip()
    if not query:
        return jsonify({"success": False, "message": "query is required"}), 400

    search_mode = data.get("mode", "normal")
    platforms_cfg = data.get("platforms", {})
    project_ids = data.get("project_ids", [])
    domains = data.get("domains", [])

    all_results = []
    platforms_used = []
    quality_scores = {}

    if search_mode == "deep":
        # 深度模式：并行搜索所有已启用平台
        futures = {}
        with ThreadPoolExecutor(max_workers=4) as executor:
            if platforms_cfg.get("local"):
                futures[executor.submit(_search_platform_local, query, project_ids)] = "local"
            if platforms_cfg.get("hiDesk"):
                futures[executor.submit(_search_platform_hidesk, query, domains)] = "hiDesk"
            if platforms_cfg.get("haiwen"):
                futures[executor.submit(_search_platform_haiwen, query)] = "haiwen"
            if platforms_cfg.get("webSearch"):
                futures[executor.submit(_search_platform_web, query)] = "web"

            for future in as_completed(futures):
                platform_name = futures[future]
                try:
                    result = future.result(timeout=60)
                    all_results.append(result)
                    platforms_used.append(platform_name)
                    quality_scores[platform_name] = result.get("quality_score", 0)

                    # 检查是否有过期标记
                    if result.get("expired"):
                        _log(f"[{platform_name}] 认证已过期，清除凭证", "warning")
                        _haiwen_client.clear_credentials()
                except Exception as e:
                    _log(f"Platform {platform_name} search failed: {e}", "warning")
                    all_results.append({
                        "results": [],
                        "sources": [],
                        "quality_score": 0,
                        "platform": platform_name,
                        "error": str(e),
                    })

        # 深度模式：抓取网页内容
        web_results = [r for r in all_results if r.get("platform") == "web"]
        web_urls = []
        for wr in web_results:
            for item in wr.get("results", []):
                url = item.get("url", "")
                if url and url.startswith("http"):
                    web_urls.append(url)

        if web_urls:
            fetched = _fetch_web_contents_batch(web_urls[:10])
            # 用抓取的内容替换 snippet
            for wr in web_results:
                for item in wr.get("results", []):
                    url = item.get("url", "")
                    if url in fetched:
                        item["content"] = fetched[url]

    else:
        # 普通模式：级联搜索
        cascade_order = [
            ("local", lambda: _search_platform_local(query, project_ids)),
            ("hiDesk", lambda: _search_platform_hidesk(query, domains)),
            ("haiwen", lambda: _search_platform_haiwen(query)),
            ("web", lambda: _search_platform_web(query)),
        ]

        # 前端传入的平台 key 映射
        _platform_key_map = {"web": "webSearch"}

        for platform_name, search_fn in cascade_order:
            cfg_key = _platform_key_map.get(platform_name, platform_name)
            if not platforms_cfg.get(cfg_key):
                continue

            try:
                result = search_fn()
                all_results.append(result)
                platforms_used.append(platform_name)

                # 检查是否有过期标记
                if result.get("expired"):
                    _log(f"[haiwen] auth expired, clear credentials", "warning")
                    _haiwen_client.clear_credentials()

                score = result.get("quality_score", 0)
                llm_quality = _llm_assess_search_quality(query, platform_name, result.get("results", []))
                if llm_quality:
                    score = llm_quality.get("score", score)
                    result["quality_score"] = score
                    result["quality_assessment"] = llm_quality
                quality_scores[platform_name] = score

                # 质量达标则停止级联
                if score >= 60:
                    break
            except Exception as e:
                import traceback as _tb
                _log(f"Platform {platform_name} search failed: {e}\n{_tb.format_exc()}", "warning")

    # 构建统一上下文
    context_text, unified_sources = _build_unified_context(all_results, deep_mode=(search_mode == "deep"))

    # LLM 综合分析
    answer = ""
    if context_text:
        answer = _llm_synthesize(query, context_text, unified_sources, search_mode, platforms_used)

    if not answer:
        # LLM 未配置或失败，返回原始结果汇总
        parts = []
        for pr in all_results:
            platform = pr.get("platform", "unknown")
            results = pr.get("results", [])
            error = pr.get("error", "")
            if error:
                parts.append(f"### {platform}\n\n{error}")
            elif results:
                for r in results:
                    title = r.get("title", r.get("path", ""))
                    url = r.get("url", "")
                    snippet = r.get("content", r.get("snippet", ""))
                    if url:
                        parts.append(f"- [{title}]({url}): {snippet[:200]}")
                    else:
                        parts.append(f"- {title}: {snippet[:200]}")
        answer = "\n\n".join(parts) if parts else "未找到相关信息。"

    write_log("unified_search", {
        "mode": search_mode,
        "platforms_used": platforms_used,
        "quality_scores": quality_scores,
    })

    # 检查是否有平台返回过期标记
    has_expired = any(r.get("expired") for r in all_results)

    return jsonify({
        "success": True,
        "data": {
            "query": query,
            "answer": answer,
            "sources": unified_sources,
            "platforms_used": platforms_used,
            "quality_scores": quality_scores,
            "mode": search_mode,
            "expired": has_expired,
        },
    })


# ============================================================
#  Agent 智能体 API
# ============================================================

# 延迟导入 agent 模块
_agent_registry = None
_agent_skills_mgr = None
_sub_agent_registry = None    # SubAgentRegistry 实例
_workflow_registry = None     # WorkflowRegistry 实例


def _get_agent_registry():
    """获取或初始化工具注册表"""
    global _agent_registry
    if _agent_registry is None:
        from agent_tools import build_tool_registry, get_disabled_tools
        app_refs = {
            "client": client,
            "safe_call_llm_wiki": safe_call_llm_wiki,
            "load_llm_config": load_llm_config,
            "build_chat_completions_url": build_chat_completions_url,
            "_get_current_project": _get_current_project,
            "_search_project": _search_project,
            "_do_web_search": _do_web_search,
            "_fetch_web_content": _fetch_web_content,
            "_search_platform_local": _search_platform_local,
            "_search_platform_hidesk": _search_platform_hidesk,
            "_search_platform_haiwen": _search_platform_haiwen,
            "_search_platform_web": _search_platform_web,
            "_build_unified_context": _build_unified_context,
            "_llm_synthesize": _llm_synthesize,
            "write_log": write_log,
            "_log": _log,
        }
        _agent_registry = build_tool_registry(app_refs)
        _log("Agent 工具注册表已初始化")
    return _agent_registry


def _get_skills_manager():
    """获取技能管理模块"""
    global _agent_skills_mgr
    if _agent_skills_mgr is None:
        import skills_manager
        _agent_skills_mgr = skills_manager
        _log("Skills 管理器已加载")
    return _agent_skills_mgr


@app.route("/api/v1/agent/tools", methods=["GET"])
def agent_list_tools():
    """列出所有可用的 agent 工具"""
    registry = _get_agent_registry()
    return jsonify({
        "success": True,
        "data": {
            "tools": registry.list_tool_info(),
            "count": len(registry.list_tool_info()),
        },
    })


@app.route("/api/v1/agent/skills", methods=["GET"])
def agent_list_skills():
    """列出所有可用的 skill"""
    skills_mgr = _get_skills_manager()
    skills = skills_mgr.load_skills()
    # 返回时不含 content 全文，仅摘要
    return jsonify({
        "success": True,
        "data": {
            "skills": [
                {
                    "id": s["id"],
                    "name": s["name"],
                    "description": s["description"],
                    "tools_used": s["tools_used"],
                    "trigger_keywords": s["trigger_keywords"],
                    "content_preview": s["content"][:200] if s["content"] else "",
                }
                for s in skills
            ],
            "count": len(skills),
        },
    })


@app.route("/api/v1/agent/skills/<skill_id>", methods=["GET"])
def agent_get_skill(skill_id):
    """获取单个 skill 的详细信息"""
    skills_mgr = _get_skills_manager()
    skill = skills_mgr.get_skill_by_id(skill_id)
    if not skill:
        return jsonify({"success": False, "message": f"Skill '{skill_id}' not found"}), 404
    return jsonify({"success": True, "data": skill})


@app.route("/api/v1/agent/chat", methods=["POST"])
def agent_chat():
    """Agent 智能体对话端点（SSE 流式）

    请求体:
    {
        "messages": [{"role": "user", "content": "..."}],
        "skill_ids": ["knowledge-qa"],       # 可选，指定激活的 skill
        "custom_instructions": "...",          # 可选，自定义指令
        "max_iterations": 8,                   # 可选，最大工具调用轮次
        "subagent_name": "intent_analyzer"     # 可选，指定调用某个 SubAgent
    }

    返回: text/event-stream (SSE)
    """
    from flask import Response

    data = request.get_json() or {}
    messages = data.get("messages", [])
    skill_ids = data.get("skill_ids", [])
    custom_instructions = data.get("custom_instructions", "")
    max_iterations = int(data.get("max_iterations") or 8)
    subagent_name = data.get("subagent_name", "").strip()  # 可选：指定 SubAgent
    project_ids = data.get("project_ids", [])   # 可选：指定知识库 project IDs
    domains = data.get("domains", [])           # 可选：指定搜索域
    platforms = data.get("platforms", {})
    search_mode = data.get("search_mode", "deep" if data.get("deep_search") else "normal")

    if not messages:
        return jsonify({"success": False, "message": "messages is required"}), 400

    # 加载 LLM 配置
    llm_cfg = load_llm_config()
    if not llm_cfg.get("llm_url") or not llm_cfg.get("llm_model"):
        return jsonify({"success": False, "message": "LLM not configured. Please configure LLM in Settings first."}), 400

    # 初始化工具和技能
    registry = _get_agent_registry()
    skills_mgr = _get_skills_manager()

    # 如果指定了 subagent_name，路由到 SubAgent
    if subagent_name:
        sub_agent_reg = _get_sub_agent_registry()
        agent = sub_agent_reg.get(subagent_name)
        if not agent:
            return jsonify({
                "success": False,
                "message": f"SubAgent '{subagent_name}' not found. Available: {sub_agent_reg.list_names()}",
            }), 404

        if max_iterations:
            agent.config.max_iterations = max_iterations

        user_input = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        input_data = {"user_query": user_input}
        shared_state = {"user_input": user_input, "step_results": {}}

        _log(f"[agent] chat via subagent: {subagent_name}, messages={len(messages)}")
        write_log("agent_chat_subagent", {
            "subagent_name": subagent_name,
            "messages_count": len(messages),
        })

        _current_request_id = getattr(g, 'request_id', '-')

        def generate_subagent():
            try:
                for event in agent.run(
                    input_data=input_data,
                    shared_state=shared_state,
                    tool_registry=registry,
                    llm_config=llm_cfg,
                    skills_manager=skills_mgr,
                    context={
                        "request_id": _current_request_id,
                        "project_ids": project_ids,
                        "domains": domains,
                        "platforms": platforms,
                        "search_mode": search_mode,
                        "_app_refs": app_refs,
                    },
                ):
                    yield event
            except Exception as e:
                _log(f"[agent] subagent stream error: {traceback.format_exc()}", "error")
                yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
                yield f"event: done\ndata: {json.dumps({'error': True})}\n\n"

        return Response(
            generate_subagent(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    # 默认：通用 agent_loop 模式

    # 将 KB context 注入 custom_instructions，让 LLM 知道该搜索哪些知识库
    kb_context_parts = []
    if project_ids:
        kb_context_parts.append(f"Available knowledge base project IDs: {', '.join(project_ids)}. Prefer these when calling knowledge_query.")
    if domains:
        kb_context_parts.append(f"Relevant domains/topics: {', '.join(domains)}.")
    if platforms:
        enabled_platforms = [k for k, v in platforms.items() if v]
        if enabled_platforms:
            kb_context_parts.append(
                "Selected search/source platforms: "
                + ", ".join(enabled_platforms)
                + ". Use unified_search when multiple platforms are enabled or when the user asks about HiDesk or 海问思答."
            )
    if search_mode != "deep":
        kb_context_parts.append(
            "Normal mode search policy: after knowledge_query returns count >= 3, "
            "prefer answering directly from those results instead of continuing to call more search tools. "
            "Only do another tool call if the results are clearly irrelevant, contradictory, or insufficient for the user's exact question."
        )
    else:
        kb_context_parts.append(
            "Professional mode search policy: multi-round search and cross-source verification are allowed when they improve answer quality."
        )
    kb_context_parts.append(
        "When the user asks what knowledge sources, search channels, or platforms you have, call get_available_sources and answer from that tool result."
    )
    if kb_context_parts:
        kb_hint = "\n\n".join(kb_context_parts)
        custom_instructions = f"{custom_instructions}\n\n{kb_hint}" if custom_instructions else kb_hint

    # 匹配技能
    skills_prompt = ""
    if skill_ids:
        active_skills = [skills_mgr.get_skill_by_id(sid) for sid in skill_ids]
        active_skills = [s for s in active_skills if s]
        skills_prompt = skills_mgr.build_skills_prompt(active_skills)
    else:
        # 自动匹配
        user_msg = messages[-1].get("content", "") if messages else ""
        matched = skills_mgr.match_skills(user_msg)
        if matched:
            skills_prompt = skills_mgr.build_skills_prompt(matched)

    # 根据 platforms 开关过滤工具：未启用的平台对应工具不注册给 LLM
    from agent_tools import get_disabled_tools
    disabled = get_disabled_tools(platforms)
    tools = registry.list_tools(exclude=disabled)
    enabled_tool_names = [t["function"]["name"] for t in tools]

    _log(f"[agent] chat: {len(messages)} messages, {len(tools)} tools (disabled: {disabled}), skills: {skill_ids or 'auto'}")
    write_log("agent_chat", {
        "messages_count": len(messages),
        "tools_count": len(tools),
        "skill_ids": skill_ids,
        "custom_instructions": custom_instructions[:100] if custom_instructions else "",
    })

    _current_request_id = getattr(g, 'request_id', '-')

    def generate():
        from agent_loop import run_agent_stream
        try:
            for event in run_agent_stream(
                messages=messages,
                tools=tools,
                registry=registry,
                llm_config=llm_cfg,
                skills_prompt=skills_prompt,
                custom_instructions=custom_instructions,
                max_iterations=max_iterations,
                context={
                    "request_id": _current_request_id,
                    "project_ids": project_ids,
                    "domains": domains,
                    "platforms": platforms,
                    "search_mode": search_mode,
                    "_app_refs": app_refs,
                },
            ):
                yield event
        except Exception as e:
            _log(f"[agent] stream error: {traceback.format_exc()}", "error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
            yield f"event: done\ndata: {json.dumps({'error': True})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ============================================================
#  SubAgent / Workflow API
# ============================================================

def _get_sub_agent_registry():
    """获取或初始化 SubAgent 注册表（含内置通用 SubAgent）"""
    global _sub_agent_registry
    if _sub_agent_registry is None:
        from sub_agent_registry import build_default_sub_agent_registry
        _sub_agent_registry = build_default_sub_agent_registry()
        _log(f"SubAgent 注册表已初始化，共 {len(_sub_agent_registry.list_names())} 个 SubAgent")
    return _sub_agent_registry


def _get_workflow_registry():
    """获取或初始化工作流注册表（含内置示例工作流）"""
    global _workflow_registry
    if _workflow_registry is None:
        from workflow_orchestrator import build_default_workflow_registry
        _workflow_registry = build_default_workflow_registry()
        _log(f"Workflow 注册表已初始化，共 {len(_workflow_registry.list_names())} 个工作流")
    return _workflow_registry


@app.route("/api/v1/agent/subagents", methods=["GET"])
def agent_list_subagents():
    """列出所有已注册的 SubAgent"""
    registry = _get_sub_agent_registry()
    return jsonify({
        "success": True,
        "data": {
            "subagents": registry.list_agents(),
            "count": len(registry.list_names()),
        },
    })


@app.route("/api/v1/agent/subagents/<name>", methods=["GET"])
def agent_get_subagent(name):
    """获取单个 SubAgent 的详细信息"""
    registry = _get_sub_agent_registry()
    agent = registry.get(name)
    if not agent:
        return jsonify({"success": False, "message": f"SubAgent '{name}' not found"}), 404
    return jsonify({
        "success": True,
        "data": agent.to_dict(),
    })


@app.route("/api/v1/agent/subagents/register", methods=["POST"])
def agent_register_subagent():
    """动态注册一个新的 SubAgent

    请求体:
    {
        "name": "my_agent",
        "description": "描述",
        "system_prompt": "你是...",
        "tools_allowed": ["knowledge_query", "web_search"],
        "skill_ids": [],
        "max_iterations": 5,
        "on_error": "stop",
        "timeout": 300
    }
    """
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"success": False, "message": "name is required"}), 400

    registry = _get_sub_agent_registry()
    if registry.has(name):
        return jsonify({"success": False, "message": f"SubAgent '{name}' already exists"}), 409

    agent = registry.register_config(data)
    _log(f"[agent] 动态注册 SubAgent: {name}")
    write_log("subagent_registered", {"name": name, "description": data.get("description", "")})
    return jsonify({
        "success": True,
        "message": f"SubAgent '{name}' registered successfully",
        "data": agent.to_dict(),
    })


@app.route("/api/v1/agent/subagents/<name>", methods=["DELETE"])
def agent_delete_subagent(name):
    """删除一个 SubAgent"""
    registry = _get_sub_agent_registry()
    if not registry.has(name):
        return jsonify({"success": False, "message": f"SubAgent '{name}' not found"}), 404
    removed = registry.remove(name)
    _log(f"[agent] 删除 SubAgent: {name}")
    write_log("subagent_deleted", {"name": name})
    return jsonify({
        "success": True,
        "message": f"SubAgent '{name}' deleted",
    })


@app.route("/api/v1/agent/workflows", methods=["GET"])
def agent_list_workflows():
    """列出所有已注册的工作流"""
    wf_registry = _get_workflow_registry()
    return jsonify({
        "success": True,
        "data": {
            "workflows": wf_registry.list_workflows(),
            "count": len(wf_registry.list_names()),
        },
    })


@app.route("/api/v1/agent/workflows/register", methods=["POST"])
def agent_register_workflow():
    """动态注册一个工作流

    请求体:
    {
        "name": "my_flow",
        "description": "自定义工作流",
        "use_brain": false,
        "max_total_revisits": 5,
        "steps": [
            {
                "agent_name": "intent_analyzer",
                "input_mapping": {"user_query": "$.user_input"},
                "output_mapping": {"content": "$.step_results.intent_analyzer.intent"},
                "await_user": true,
                "await_message": "确认？",
                "on_error": "stop",
                "goto_on_failure": "",
                "goto_rules": []
            }
        ]
    }
    """
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"success": False, "message": "name is required"}), 400

    wf_registry = _get_workflow_registry()
    try:
        workflow = wf_registry.register_from_dict(data)
        _log(f"[workflow] 动态注册工作流: {name}")
        write_log("workflow_registered", {"name": name, "description": data.get("description", "")})
        return jsonify({
            "success": True,
            "message": f"Workflow '{name}' registered successfully",
            "data": wf_registry.get_detail(name),
        })
    except Exception as e:
        _log(f"[workflow] 注册失败: {e}")
        return jsonify({"success": False, "message": f"Failed to register workflow: {str(e)}"}), 400


@app.route("/api/v1/agent/workflows/<name>", methods=["GET"])
def agent_get_workflow(name):
    """获取单个工作流详情"""
    wf_registry = _get_workflow_registry()
    detail = wf_registry.get_detail(name)
    if not detail:
        return jsonify({"success": False, "message": f"Workflow '{name}' not found"}), 404
    return jsonify({
        "success": True,
        "data": detail,
    })


@app.route("/api/v1/agent/workflows/<name>", methods=["DELETE"])
def agent_delete_workflow(name):
    """删除一个工作流"""
    wf_registry = _get_workflow_registry()
    removed = wf_registry.remove(name)
    if not removed:
        return jsonify({"success": False, "message": f"Workflow '{name}' not found"}), 404
    _log(f"[workflow] 删除工作流: {name}")
    write_log("workflow_deleted", {"name": name})
    return jsonify({
        "success": True,
        "message": f"Workflow '{name}' deleted",
    })


@app.route("/api/v1/agent/workflow", methods=["POST"])
def agent_run_workflow():
    """执行工作流（SSE 流式）

    请求体:
    {
        "workflow_name": "ppt_generation",    # 工作流名称
        "user_input": "帮我做一份关于AI的PPT",   # 用户输入
        "initial_state": {},                   # 可选，额外初始状态
        "workflow_id": "abc123"               # 可选，指定工作流实例 ID
    }

    返回: text/event-stream (SSE)
    """
    from flask import Response

    data = request.get_json() or {}
    workflow_name = data.get("workflow_name", "").strip()
    user_input = data.get("user_input", "").strip()
    initial_state = data.get("initial_state", {})
    workflow_id = data.get("workflow_id") or str(uuid.uuid4())[:8]

    if not workflow_name:
        return jsonify({"success": False, "message": "workflow_name is required"}), 400
    if not user_input:
        return jsonify({"success": False, "message": "user_input is required"}), 400

    wf_registry = _get_workflow_registry()
    workflow = wf_registry.get(workflow_name)
    if not workflow:
        available = wf_registry.list_names()
        return jsonify({
            "success": False,
            "message": f"Workflow '{workflow_name}' not found. Available: {available}",
        }), 404

    # 加载配置
    llm_cfg = load_llm_config()
    if not llm_cfg.get("llm_url") or not llm_cfg.get("llm_model"):
        return jsonify({"success": False, "message": "LLM not configured"}), 400

    sub_agent_reg = _get_sub_agent_registry()
    tool_reg = _get_agent_registry()
    skills_mgr = _get_skills_manager()

    _log(f"[workflow] start: name={workflow_name} id={workflow_id} input={user_input[:80]}")
    write_log("workflow_start", {
        "workflow_name": workflow_name,
        "workflow_id": workflow_id,
        "user_input": user_input[:200],
    })

    _current_request_id = getattr(g, 'request_id', '-')

    def generate():
        from workflow_orchestrator import WorkflowOrchestrator
        try:
            # Brain Agent 注入
            brain = None
            if workflow.use_brain:
                from brain_agent import BrainAgent
                brain = BrainAgent(log_fn=_log)
                _log("[workflow] BrainAgent enabled")

            orch = WorkflowOrchestrator(
                workflow=workflow,
                agent_registry=sub_agent_reg,
                tool_registry=tool_reg,
                llm_config=llm_cfg,
                skills_manager=skills_mgr,
                log_fn=_log,
                brain=brain,
            )
            for event in orch.run(
                user_input=user_input,
                initial_state=initial_state,
                context={"request_id": _current_request_id},
                workflow_id=workflow_id,
            ):
                yield event
        except Exception as e:
            _log(f"[workflow] error: {traceback.format_exc()}", "error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
            yield f"event: done\ndata: {json.dumps({'error': True})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.route("/api/v1/agent/workflow/<workflow_id>/action", methods=["POST"])
def agent_workflow_action(workflow_id):
    """向等待中的工作流发送用户操作（确认/编辑/取消）

    请求体:
    {
        "action": "continue",          # "continue" | "edit" | "cancel" | "reanalyze"
        "edited_content": "...",       # 编辑后的内容（JSON 字符串或纯文本）
        "feedback": "..."              # 用户反馈意见
    }
    """
    from workflow_orchestrator import set_workflow_action, get_workflow_state

    data = request.get_json() or {}
    action = data.get("action", "continue").strip()
    edited_content = data.get("edited_content", "")
    feedback = data.get("feedback", "")

    state = get_workflow_state(workflow_id)
    if not state:
        return jsonify({
            "success": False,
            "message": f"Workflow '{workflow_id}' not found or not waiting for user action",
        }), 404

    ok = set_workflow_action(workflow_id, action, edited_content, feedback)
    if not ok:
        return jsonify({"success": False, "message": "Failed to update workflow state"}), 500

    _log(f"[workflow] action: id={workflow_id} action={action}")
    write_log("workflow_action", {
        "workflow_id": workflow_id,
        "action": action,
        "edited_content_length": len(edited_content),
        "feedback_length": len(feedback),
    })
    return jsonify({
        "success": True,
        "message": f"Action '{action}' sent to workflow '{workflow_id}'",
    })


@app.route("/api/v1/agent/workflow/pending", methods=["GET"])
def agent_workflow_pending():
    """列出所有等待用户操作的工作流"""
    from workflow_orchestrator import list_pending_workflows
    pending = list_pending_workflows()
    return jsonify({
        "success": True,
        "data": {
            "pending": pending,
            "count": len(pending),
        },
    })


@app.route("/api/v1/agent/chat-direct", methods=["POST"])
def agent_chat_direct():
    """直接调用单个 SubAgent 进行对话（SSE 流式）

    请求体:
    {
        "subagent_name": "intent_analyzer",    # SubAgent 名称
        "messages": [{"role": "user", "content": "..."}],  # 对话历史
        "extra_state": {},                      # 可选，额外 shared_state
        "max_iterations": 5                     # 可选
    }

    返回: text/event-stream (SSE)
    """
    from flask import Response

    data = request.get_json() or {}
    subagent_name = data.get("subagent_name", "").strip()
    messages = data.get("messages", [])
    extra_state = data.get("extra_state", {})
    max_iterations = int(data.get("max_iterations") or 5)

    if not subagent_name:
        return jsonify({"success": False, "message": "subagent_name is required"}), 400
    if not messages:
        return jsonify({"success": False, "message": "messages is required"}), 400

    sub_agent_reg = _get_sub_agent_registry()
    agent = sub_agent_reg.get(subagent_name)
    if not agent:
        return jsonify({
            "success": False,
            "message": f"SubAgent '{subagent_name}' not found. Available: {sub_agent_reg.list_names()}",
        }), 404

    llm_cfg = load_llm_config()
    if not llm_cfg.get("llm_url") or not llm_cfg.get("llm_model"):
        return jsonify({"success": False, "message": "LLM not configured"}), 400

    # 覆盖 max_iterations
    if max_iterations:
        agent.config.max_iterations = max_iterations

    tool_reg = _get_agent_registry()
    skills_mgr = _get_skills_manager()

    # 从 messages 提取 user_input
    user_input = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")

    # 构建 input_data（以 messages 最后一条 user 消息为输入）
    input_data = {"user_query": user_input}
    shared_state = {"user_input": user_input, "step_results": {}}
    if extra_state:
        shared_state.update(extra_state)

    _log(f"[agent] chat-direct: subagent={subagent_name} messages={len(messages)}")
    write_log("agent_chat_direct", {
        "subagent_name": subagent_name,
        "messages_count": len(messages),
    })

    _current_request_id = getattr(g, 'request_id', '-')

    def generate():
        try:
            for event in agent.run(
                input_data=input_data,
                shared_state=shared_state,
                tool_registry=tool_reg,
                llm_config=llm_cfg,
                skills_manager=skills_mgr,
                context={"request_id": _current_request_id},
            ):
                yield event
        except Exception as e:
            _log(f"[agent] chat-direct error: {traceback.format_exc()}", "error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
            yield f"event: done\ndata: {json.dumps({'error': True})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ============================================================
#  海问思答 API
# ============================================================

@app.route("/api/v1/haiwen/login", methods=["POST"])
def haiwen_login():
    """海问思答登录

    请求体:
    {
        "username": "w3账号",
        "password": "w3密码"
    }
    """
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if not username or not password:
        return jsonify({"success": False, "message": "username 和 password 是必填项"}), 400

    import asyncio

    async def _do_login():
        return await _haiwen_client.login(username, password)

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(_do_login())
    finally:
        loop.close()

    if result.get("success"):
        _log("[haiwen] login success")
        return jsonify({"success": True, "message": "haiwen login success"})
    else:
        _log(f"[haiwen] login failed: {result.get('error')}", "error")
        return jsonify({"success": False, "message": result.get("error", "haiwen login failed")}), 401


@app.route("/api/v1/haiwen/status", methods=["GET"])
def haiwen_status():
    """查询海问思答登录状态"""
    return jsonify({
        "success": True,
        "authenticated": _haiwen_client.is_authenticated,
    })


@app.route("/api/v1/haiwen/logout", methods=["POST"])
def haiwen_logout():
    """清除海问思答凭证"""
    _haiwen_client.clear_credentials()
    _log("[haiwen] credentials cleared")
    return jsonify({"success": True, "message": "haiwen logout success"})


# ============================================================
#  全局错误处理器
# ============================================================

@app.errorhandler(400)
def bad_request(e):
    _log(f"HTTP 400: {request.method} {request.path} - {str(e)}", "warning")
    return jsonify({"success": False, "message": str(e)}), 400


@app.errorhandler(404)
def not_found(e):
    _log(f"HTTP 404: {request.method} {request.path}", "warning")
    return jsonify({"success": False, "message": "Not found"}), 404


@app.errorhandler(500)
def internal_error(e):
    _log(f"HTTP 500: {request.method} {request.path} - {str(e)}", "error")
    _log(traceback.format_exc(), "error")
    write_log("internal_server_error", {
        "method": request.method,
        "path": request.path,
        "error": str(e),
        "traceback": traceback.format_exc()[-500:],
    }, level="error")
    return jsonify({"success": False, "message": "Internal server error"}), 500


@app.errorhandler(Exception)
def handle_exception(e):
    """捕获所有未处理的异常"""
    _log(f"未捕获异常: {request.method} {request.path} - {type(e).__name__}: {e}", "error")
    _log(traceback.format_exc(), "error")
    write_log("unhandled_exception", {
        "method": request.method,
        "path": request.path,
        "error_type": type(e).__name__,
        "error": str(e),
        "traceback": traceback.format_exc()[-500:],
    }, level="error")
    return jsonify({"success": False, "message": f"Server error: {str(e)}"}), 500


# ============================================================
#  W3 OAuth 2.0 认证路由
# ============================================================

@app.route("/api/v1/auth/w3-exchange", methods=["POST"])
def auth_w3_exchange():
    """用 W3 access_token 换取本地 JWT"""
    if pyjwt is None:
        return jsonify({"success": False, "message": "服务端未启用 JWT 支持"}), 500

    data = request.get_json() or {}
    w3_token = data.get("access_token", "")
    w3_user = data.get("user_info", {})

    if not w3_token:
        return jsonify({"success": False, "message": "缺少 access_token"}), 400

    # 验证 W3 token 的有效性
    try:
        verify_url = OAUTH_CONFIG.get("userinfo_url", "https://login.huawei.com/oauth2/userinfo")
        params = {}
        cid = _read_oauth_client_id()
        if cid:
            params["client_id"] = cid
        resp = requests.get(
            verify_url,
            headers={"Authorization": f"Bearer {w3_token}"},
            params=params,
            timeout=10,
            verify=False,
        )
    except Exception as e:
        _log(f"[auth] w3-exchange verify failed: {e}", "error")
        return jsonify({"success": False, "message": f"W3 token 验证异常: {e}"}), 502

    user_data = {}
    if resp.status_code == 200:
        try:
            user_data = resp.json()
        except Exception:
            user_data = {}
    else:
        # userinfo 调用失败时，降级使用前端传入的 user_info（兼容部分 W3 部署）
        _log(f"[auth] w3 userinfo returned {resp.status_code}, falling back to client-supplied user_info", "warning")

    emp_no = user_data.get("emp_no") or w3_user.get("emp_no") or ""
    name = user_data.get("name") or w3_user.get("name") or ""
    dept = user_data.get("dept1") or user_data.get("dept") or w3_user.get("dept") or ""

    now = datetime.utcnow()
    payload = {
        "emp_no": emp_no,
        "name": name,
        "dept": dept,
        "iat": now,
        "exp": now + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    jwt_token = pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")
    if isinstance(jwt_token, bytes):
        jwt_token = jwt_token.decode("utf-8")

    write_log("w3_exchange", {"emp_no": emp_no, "name": name})
    try:
        record_login(emp_no or name or "unknown")
    except Exception:
        pass

    return jsonify({
        "success": True,
        "jwt": jwt_token,
        "user": {
            "name": name,
            "emp_no": emp_no,
            "dept": dept,
            "avatar": None,
        },
        "expires_in": JWT_EXPIRY_HOURS * 3600,
    })


@app.route("/api/v1/auth/refresh", methods=["POST"])
def auth_refresh():
    """刷新 JWT"""
    if pyjwt is None:
        return jsonify({"success": False, "message": "服务端未启用 JWT 支持"}), 500

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"success": False, "message": "缺少 Authorization 头"}), 401

    try:
        old_token = auth_header[7:]
        payload = pyjwt.decode(
            old_token, JWT_SECRET, algorithms=["HS256"],
            options={"verify_exp": False},
        )
        # 检查是否在宽限期内
        exp = datetime.utcfromtimestamp(payload["exp"])
        if datetime.utcnow() > exp + timedelta(hours=JWT_REFRESH_GRACE_HOURS):
            return jsonify({"success": False, "message": "Token 已过期，请重新登录"}), 401

        now = datetime.utcnow()
        new_payload = {
            "emp_no": payload.get("emp_no", ""),
            "name": payload.get("name", ""),
            "dept": payload.get("dept", ""),
            "iat": now,
            "exp": now + timedelta(hours=JWT_EXPIRY_HOURS),
        }
        new_jwt = pyjwt.encode(new_payload, JWT_SECRET, algorithm="HS256")
        if isinstance(new_jwt, bytes):
            new_jwt = new_jwt.decode("utf-8")
        return jsonify({"success": True, "jwt": new_jwt, "expires_in": JWT_EXPIRY_HOURS * 3600})
    except pyjwt.PyJWTError as e:
        return jsonify({"success": False, "message": str(e)}), 401


@app.route("/api/v1/auth/logout", methods=["POST"])
def auth_logout():
    """登出"""
    emp_no = None
    if hasattr(g, "current_user") and g.current_user:
        emp_no = g.current_user.get("emp_no")
    if emp_no:
        try:
            record_logout(emp_no)
        except Exception:
            pass
    return jsonify({"success": True})


@app.route("/api/v1/auth/user-info", methods=["GET"])
def auth_user_info():
    """获取当前用户信息"""
    if not hasattr(g, "current_user") or not g.current_user:
        return jsonify({"success": False, "message": "未认证"}), 401
    return jsonify({"success": True, "user": g.current_user})


# ============================================================
#  请求级日志中间件 + JWT 认证
# ============================================================

# 白名单路由不需要认证
_AUTH_WHITELIST = {
    "/api/v1/auth/w3-exchange",
    "/api/v1/auth/refresh",
    "/api/v1/auth/logout",
    "/api/v1/haiwen/login",
    "/api/v1/haiwen/status",
    "/api/v1/haiwen/logout",
}


@app.before_request
def before_request_log():
    """请求开始前的日志记录 + JWT 校验"""
    g.request_id = str(uuid.uuid4())[:8]
    g.request_start = datetime.now()
    g.current_user = None

    # ---- JWT 认证（仅保护 /api/ 路由）----
    if pyjwt is not None and request.path.startswith("/api/") and request.path not in _AUTH_WHITELIST:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            try:
                payload = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
                g.current_user = payload
            except pyjwt.ExpiredSignatureError:
                # 写入操作拒绝，读取操作宽容
                if request.method in ("POST", "PUT", "DELETE", "PATCH"):
                    return jsonify({"success": False, "message": "Token 已过期"}), 401
            except pyjwt.InvalidTokenError:
                if request.method in ("POST", "PUT", "DELETE", "PATCH"):
                    return jsonify({"success": False, "message": "Token 无效"}), 401
        elif request.method in ("POST", "PUT", "DELETE", "PATCH"):
            # 开发期宽容：未携带 Token 的写入请求允许通过（避免一刀切阻塞现有功能）
            pass

    # 对 POST/PUT/DELETE 请求记录详细信息
    if request.method in ("POST", "PUT", "DELETE"):
        _log(f"[{g.request_id}] {request.method} {request.path}")


@app.after_request
def after_request_log(response):
    """请求完成后的日志记录"""
    if hasattr(g, 'request_start'):
        elapsed = (datetime.now() - g.request_start).total_seconds()
        request_id = getattr(g, 'request_id', '-')
        # 记录慢请求或错误响应
        if response.status_code >= 400:
            _log(f"[{request_id}] {request.method} {request.path} -> {response.status_code} ({elapsed:.2f}s)", "error")
        elif elapsed > 5.0:
            _log(f"[{request_id}] {request.method} {request.path} -> {response.status_code} ({elapsed:.2f}s) [SLOW]", "warning")
    return response


# ============================================================
#  Register PPT Pipeline Routes
# ============================================================

_ppt_app_refs = {
    "_log": _log,
    "write_log": write_log,
    "_search_project": _search_project,
    "_do_web_search": _do_web_search,
    "_fetch_web_content": _fetch_web_content,
    "_get_current_project": _get_current_project,
    "load_llm_config": load_llm_config,
    "build_chat_completions_url": build_chat_completions_url,
    "_search_platform_hidesk": _search_platform_hidesk,
    "_search_platform_haiwen": _search_platform_haiwen,
}

register_ppt_pipeline_routes(app, _ppt_app_refs)


# ============================================================
#  App startup
# ============================================================

if __name__ == "__main__":
    port = int(os.environ.get("LLM_WIKI_SERVER_PORT", 5002))
    _log(f"Starting KMA Server on port {port}")

    # 立即启动 Flask（先监听端口，后端探测放后台避免阻塞）
    import threading as _threading
    def _startup_log_and_init():
        try:
            base = _get_active_base_dir()
            _log(f"  Active KB:    {base}")
            _log(f"  Wiki Dir:     {_get_wiki_dir()}")
            _log(f"  Raw Dir:      {_get_raw_dir()}")
            _log(f"  Schema Dir:   {_get_schema_dir()}")
            schema = load_schema()
            schema_file = os.path.join(_get_schema_dir(), "schema.json")
            if not os.path.exists(schema_file):
                os.makedirs(os.path.dirname(schema_file), exist_ok=True)
                with open(schema_file, "w", encoding="utf-8") as f:
                    json.dump(schema, f, ensure_ascii=False, indent=2)
        except RuntimeError as e:
            _log(f"  Warning: {e}", "warning")
    _threading.Thread(target=_startup_log_and_init, daemon=True).start()

    _log(f"  Logs Dir:     {_get_logs_dir()}")
    _log(f"  Data Dir:     {_get_data_dir()}")
    _log(f"  KMA API: {LLM_WIKI_API_BASE}")
    app.run(debug=False, host="0.0.0.0", port=port)
