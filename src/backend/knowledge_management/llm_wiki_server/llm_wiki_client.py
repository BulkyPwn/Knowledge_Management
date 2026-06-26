import os
import re
import shutil
import time
import uuid
import socket
import subprocess
import tempfile
import requests
import json
import logging
from datetime import datetime
from typing import Optional, Dict, List, Any

_preprocessor_logger = logging.getLogger("wiki-server.preprocessor")
_logger = logging.getLogger("wiki-server.client")

# ============================================================
#  导入/预处理实时进度存储
#  导入文件时预处理（CloudModeling 转换 + PlantUML LLM 总结）可能耗时很长，
#  仅靠前端静态 toast 会让用户误以为卡住。这里维护按 task_id 索引的进度状态，
#  供 app.py 的 /api/v1/projects/import-progress 接口返回给前端轮询展示。
# ============================================================
import threading as _threading

_import_progress: Dict[str, dict] = {}
_import_progress_lock = _threading.Lock()


def set_import_progress(task_id: str, **kwargs) -> None:
    """更新指定导入任务的进度（内部 + app.py 通用入口调用）"""
    if not task_id:
        return
    now = time.time()
    with _import_progress_lock:
        prog = _import_progress.get(task_id)
        if prog is None:
            prog = {
                "status": "running",
                "stage": "init",
                "message": "",
                "current_file": "",
                "plantuml_total": 0,
                "plantuml_done": 0,
                "started_at": now,
                "updated_at": now,
            }
            _import_progress[task_id] = prog
        prog.update(kwargs)
        prog["updated_at"] = now


def get_import_progress(task_id: str) -> Optional[dict]:
    """读取指定导入任务的进度（含已耗时），供 app.py 查询接口使用"""
    if not task_id:
        return None
    with _import_progress_lock:
        prog = _import_progress.get(task_id)
        if prog is None:
            return None
        result = dict(prog)
    result["elapsed_seconds"] = round(time.time() - result.get("started_at", time.time()), 1)
    return result


def clear_import_progress(task_id: str) -> None:
    """清除指定导入任务的进度记录"""
    if not task_id:
        return
    with _import_progress_lock:
        _import_progress.pop(task_id, None)


class LLMWikiClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:19828",
        api_prefix: str = "/api/v1",
        token: Optional[str] = None,
        timeout: int = 30,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_prefix = api_prefix
        self.token = token
        self.timeout = timeout
        self._session = requests.Session()
        if token:
            self._session.headers["X-LLM-Wiki-Token"] = token

    def set_token(self, token: str) -> None:
        self.token = token
        self._session.headers["X-LLM-Wiki-Token"] = token

    def _url(self, path: str) -> str:
        return f"{self.base_url}{self.api_prefix}{path}"

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = self._url(path)
        if params is None:
            params = {}
        if self.token:
            params["token"] = self.token
        try:
            resp = self._session.get(url, params=params, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            reason = e.response.reason if e.response is not None else "Unknown"
            if status == 401 or status == 403:
                self.token = None
                retry_params = {}
                # 优先尝试 app-state.json 中的 token（KMA 可能从那里加载了不同的 token）
                new_token = self._read_app_state_token()
                if not new_token:
                    new_token = self._ensure_backend_token()
                    # 如果是新生成的 token（app-state.json 中没有），写入 app-state.json
                    # 让 KMA 后端能识别它（适用于重装 LLM Wiki 后的场景）
                    if new_token:
                        self._write_token_to_app_state(new_token)
                        try:
                            self.reload_llm_wiki_config()
                        except Exception:
                            pass
                if new_token:
                    self.set_token(new_token)
                    retry_params["token"] = new_token
                for k in params:
                    if k != "token":
                        retry_params[k] = params[k]
                try:
                    resp2 = self._session.get(url, params=retry_params, timeout=self.timeout)
                    resp2.raise_for_status()
                    return resp2.json()
                except requests.HTTPError as e2:
                    s2 = e2.response.status_code if e2.response is not None else 0
                    r2 = e2.response.reason if e2.response is not None else "Unknown"
                    return {"ok": False, "error": f"HTTP {s2} {r2}", "status_code": s2}
            return {"ok": False, "error": f"HTTP {status} {reason}", "status_code": status}
        except requests.ConnectionError:
            return {"ok": False, "error": f"无法连接到后端服务 ({self.base_url})", "status_code": 0}
        except requests.Timeout:
            return {"ok": False, "error": f"后端服务请求超时 ({self.base_url})", "status_code": 0}

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = self._url(path)
        params = {}
        if self.token:
            params["token"] = self.token
        try:
            resp = self._session.post(url, json=body, params=params, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            reason = e.response.reason if e.response is not None else "Unknown"
            if status == 401 or status == 403:
                self.token = None
                retry_params = {}
                # 优先尝试 app-state.json 中的 token（KMA 可能从那里加载了不同的 token）
                new_token = self._read_app_state_token()
                if not new_token:
                    new_token = self._ensure_backend_token()
                    # 如果是新生成的 token（app-state.json 中没有），写入 app-state.json
                    # 让 KMA 后端能识别它（适用于重装 LLM Wiki 后的场景）
                    if new_token:
                        self._write_token_to_app_state(new_token)
                        try:
                            self.reload_llm_wiki_config()
                        except Exception:
                            pass
                if new_token:
                    self.set_token(new_token)
                    retry_params["token"] = new_token
                try:
                    resp2 = self._session.post(url, json=body, params=retry_params, timeout=self.timeout)
                    resp2.raise_for_status()
                    return resp2.json()
                except requests.HTTPError as e2:
                    s2 = e2.response.status_code if e2.response is not None else 0
                    r2 = e2.response.reason if e2.response is not None else "Unknown"
                    return {"ok": False, "error": f"HTTP {s2} {r2}", "status_code": s2}
            return {"ok": False, "error": f"HTTP {status} {reason}", "status_code": status}
        except requests.ConnectionError:
            return {"ok": False, "error": f"无法连接到后端服务 ({self.base_url})", "status_code": 0}
        except requests.Timeout:
            return {"ok": False, "error": f"后端服务请求超时 ({self.base_url})", "status_code": 0}

    def health(self) -> Dict[str, Any]:
        return self._get("/health")

    def list_projects(self) -> Dict[str, Any]:
        return self._get("/projects")

    def list_files(
        self,
        project_id: str,
        root: str = "wiki",
        recursive: bool = True,
        max_files: int = 2000,
    ) -> Dict[str, Any]:
        return self._get(
            f"/projects/{project_id}/files",
            params={
                "root": root,
                "recursive": str(recursive).lower(),
                "maxFiles": max_files,
            },
        )

    def get_file_content(self, project_id: str, path: str) -> Dict[str, Any]:
        return self._get(
            f"/projects/{project_id}/files/content",
            params={"path": path},
        )

    def search(
        self,
        project_id: str,
        query: str,
        top_k: int = 10,
        include_content: bool = False,
    ) -> Dict[str, Any]:
        return self._post(
            f"/projects/{project_id}/search",
            body={
                "query": query,
                "topK": top_k,
                "includeContent": include_content,
            },
        )

    def get_graph(
        self,
        project_id: str,
        q: Optional[str] = None,
        node_type: Optional[str] = None,
        limit: int = 200,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit}
        if q:
            params["q"] = q
        if node_type:
            params["nodeType"] = node_type
        return self._get(f"/projects/{project_id}/graph", params=params)

    def rescan_sources(self, project_id: str) -> Dict[str, Any]:
        return self._post(f"/projects/{project_id}/sources/rescan", body={})

    def activate_project(self, project_id: str) -> Dict[str, Any]:
        return self._post("/projects/activate", body={"projectId": project_id})

    def create_wiki_page(
        self, wiki_dir: str, title: str, content: str
    ) -> Dict[str, Any]:
        import os

        filepath = os.path.join(wiki_dir, f"{title}.md")
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return {"ok": True, "path": filepath, "title": title}

    def read_wiki_page(self, wiki_dir: str, title: str) -> Dict[str, Any]:
        import os

        filepath = os.path.join(wiki_dir, f"{title}.md")
        if not os.path.exists(filepath):
            return {"ok": False, "error": f"Page not found: {title}"}
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        return {"ok": True, "title": title, "content": content, "path": filepath}

    def update_wiki_page(
        self, wiki_dir: str, title: str, content: str
    ) -> Dict[str, Any]:
        import os

        filepath = os.path.join(wiki_dir, f"{title}.md")
        if not os.path.exists(filepath):
            return {"ok": False, "error": f"Page not found: {title}"}
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return {"ok": True, "path": filepath, "title": title}

    def delete_wiki_page(self, wiki_dir: str, title: str) -> Dict[str, Any]:
        import os

        filepath = os.path.join(wiki_dir, f"{title}.md")
        if not os.path.exists(filepath):
            return {"ok": False, "error": f"Page not found: {title}"}
        os.remove(filepath)
        return {"ok": True, "title": title}

    def list_wiki_pages(self, wiki_dir: str) -> Dict[str, Any]:
        if not os.path.exists(wiki_dir):
            return {"ok": True, "pages": []}
        pages = []
        for item in os.listdir(wiki_dir):
            if item.endswith(".md"):
                filepath = os.path.join(wiki_dir, item)
                pages.append(
                    {
                        "title": item[:-3],
                        "filename": item,
                        "size": os.path.getsize(filepath),
                    }
                )
        return {"ok": True, "pages": pages}

    # ============================================================
    #  Knowledge base management (file-system level)
    # ============================================================

    _PROJECT_DIRS = [
        "raw/sources",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/queries",
        "wiki/comparisons",
        "wiki/synthesis",
    ]

    CLIP_SERVER_URL = "http://127.0.0.1:19827"

    def _generate_project_id(self) -> str:
        return uuid.uuid4().hex

    def _write_project_id_file(self, project_path: str, project_id: str) -> None:
        llm_wiki_dir = os.path.join(project_path, ".llm-wiki")
        os.makedirs(llm_wiki_dir, exist_ok=True)
        project_json = os.path.join(llm_wiki_dir, "project.json")
        existing = {}
        if os.path.exists(project_json):
            try:
                with open(project_json, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        if not existing.get("id"):
            existing["id"] = project_id
            with open(project_json, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)

    def _read_project_id_file(self, project_path: str) -> Optional[str]:
        project_json = os.path.join(project_path, ".llm-wiki", "project.json")
        if not os.path.exists(project_json):
            return None
        try:
            with open(project_json, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("id")
        except (json.JSONDecodeError, IOError):
            return None

    def _clip_request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.CLIP_SERVER_URL}{path}"
        try:
            if method == "GET":
                resp = requests.get(url, timeout=5)
            elif method == "POST":
                resp = requests.post(url, json=body or {}, timeout=5)
            else:
                return {"ok": False, "error": f"Unsupported method: {method}"}
            resp.raise_for_status()
            return resp.json()
        except requests.ConnectionError:
            return {"ok": False, "error": "clip_server 不可用（KMA 桌面应用未运行），项目注册将跳过但本地功能正常"}
        except requests.Timeout:
            return {"ok": False, "error": "clip_server 超时"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---- Backend process management ----

    _backend_process: Optional[subprocess.Popen] = None
    _binary_path: Optional[str] = None

    def _resolve_binary(self) -> Optional[str]:
        if self._binary_path and os.path.exists(self._binary_path):
            return self._binary_path
        env_bin = os.environ.get("LLM_WIKI_BINARY")
        if env_bin and os.path.exists(env_bin):
            self._binary_path = env_bin
            return env_bin
        script_dir = os.path.dirname(os.path.abspath(__file__))
        candidate = os.path.join(
            script_dir, "..", "llm_wiki", "src-tauri", "target", "debug", "llm-wiki.exe"
        )
        candidate = os.path.normpath(candidate)
        if os.path.exists(candidate):
            self._binary_path = candidate
            return candidate
        return None

    def _port_is_open(self, port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except (socket.timeout, ConnectionRefusedError, OSError):
            return False

    def backend_status(self) -> dict:
        clip_ok = self._port_is_open(19827)
        api_ok = self._port_is_open(19828)
        binary = self._resolve_binary()
        running = clip_ok and api_ok
        return {
            "ok": True,
            "running": running,
            "clip_server": clip_ok,
            "api_server": api_ok,
            "binary": binary,
            "binary_exists": binary is not None,
        }

    def start_backend(self) -> dict:
        status = self.backend_status()
        if status["running"]:
            token = self._ensure_backend_token()
            self.set_token(token)
            health = self.health()
            return {
                "ok": True,
                "action": "already_running",
                "token": token,
                "auth_ok": health.get("ok", False),
                "auth_required": health.get("authRequired", False),
                "auth_configured": health.get("authConfigured", False),
                "status": status,
            }

        binary = self._resolve_binary()
        if not binary:
            return {
                "ok": False,
                "error": (
                    "找不到 llm-wiki.exe。请设置 LLM_WIKI_BINARY 环境变量指向编译好的二进制文件，"
                    "或在 llm_wiki/src-tauri 目录下运行 cargo build。"
                ),
            }

        token = self._ensure_backend_token()

        try:
            env = os.environ.copy()
            if token:
                env["LLM_WIKI_API_TOKEN"] = token
            env["LLM_WIKI_HEADLESS"] = "1"

            proc = subprocess.Popen(
                [binary],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
                env=env,
            )
            self._backend_process = proc

            import time
            for _ in range(15):
                time.sleep(0.5)
                if self._port_is_open(19827) and self._port_is_open(19828):
                    self.set_token(token)
                    status = self.backend_status()
                    return {
                        "ok": True,
                        "action": "started",
                        "pid": proc.pid,
                        "token": token,
                        "status": status,
                    }

            status = self.backend_status()
            return {
                "ok": True,
                "action": "started_waiting",
                "pid": proc.pid,
                "token": token,
                "status": status,
                "message": "后端进程已启动但端口尚未就绪，请稍后检查状态",
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    _DATA_DIR: Optional[str] = None

    def _get_data_dir(self) -> str:
        if self._DATA_DIR:
            return self._DATA_DIR
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "config")

    def set_data_dir(self, path: str) -> None:
        self._DATA_DIR = path

    def _ensure_backend_token(self) -> str:
        if self.token:
            return self.token
        env_token = os.environ.get("LLM_WIKI_API_TOKEN", "").strip()
        if env_token:
            return env_token

        data_dir = self._get_data_dir()
        token_file = os.path.join(data_dir, "backend_token.json")
        if os.path.exists(token_file):
            try:
                with open(token_file, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                if saved.get("token"):
                    return saved["token"]
            except (json.JSONDecodeError, IOError):
                pass

        backend_token = self._read_app_state_token()
        if backend_token:
            return backend_token

        token = uuid.uuid4().hex
        os.makedirs(data_dir, exist_ok=True)
        with open(token_file, "w", encoding="utf-8") as f:
            json.dump({"token": token}, f, ensure_ascii=False)
        return token

    def _read_app_state_token(self) -> Optional[str]:
        state_file = self._find_app_state_file()
        if not state_file:
            return None
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
            return state.get("apiConfig", {}).get("token")
        except (json.JSONDecodeError, IOError):
            return None

    def _find_app_state_file(self) -> Optional[str]:
        candidates = []
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(os.path.join(appdata, "com.llmwiki.app", "app-state.json"))
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            candidates.append(os.path.join(local_appdata, "com.llmwiki.app", "app-state.json"))
        home = os.path.expanduser("~")
        candidates.append(os.path.join(home, "Library", "Application Support", "com.llmwiki.app", "app-state.json"))
        candidates.append(os.path.join(home, ".local", "share", "com.llmwiki.app", "app-state.json"))
        for c in candidates:
            if os.path.exists(c):
                return c
        return None

    def _write_token_to_app_state(self, token: str) -> bool:
        """将 token 写入 app-state.json 的 apiConfig 中，确保 KMA 后端能识别该 token。"""
        state_file = self._find_app_state_file()
        if not state_file:
            return False
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (json.JSONDecodeError, IOError):
            state = {}
        state.setdefault("apiConfig", {})["token"] = token
        try:
            tmp = state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, state_file)
            return True
        except (IOError, OSError):
            return False

    def _update_app_state_project(
        self, project_path: str, project_name: str, project_id: Optional[str] = None
    ) -> bool:
        state_file = self._find_app_state_file()
        if not state_file:
            return False
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (json.JSONDecodeError, IOError):
            state = {}

        norm_path = project_path.replace("\\", "/").rstrip("/")

        registry = state.setdefault("projectRegistry", {})
        pid = project_id or self._read_project_id_file(project_path) or norm_path
        registry[pid] = {"name": project_name, "path": norm_path, "id": pid}

        recents = state.setdefault("recentProjects", [])
        existing_paths = {r.get("path", "").replace("\\", "/").rstrip("/") for r in recents}
        if norm_path not in existing_paths:
            recents.insert(0, {"name": project_name, "path": norm_path})

        # 同步 lastProject，使 KMA 桌面应用启动时自动打开此知识库
        state["lastProject"] = {"name": project_name, "path": norm_path}

        try:
            tmp = state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, state_file)
            return True
        except (IOError, OSError):
            return False

    def sync_llm_config_to_app_state(
        self,
        llm_url: str = "",
        llm_api_key: str = "",
        llm_model: str = "",
        llm_embedding_model: str = "",
    ) -> dict:
        state_file = self._find_app_state_file()
        if not state_file:
            return {"ok": False, "error": "找不到 app-state.json，请确认 KMA 桌面应用至少运行过一次"}

        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (json.JSONDecodeError, IOError):
            state = {}

        url = llm_url.strip().rstrip("/")
        key = llm_api_key.strip()
        chat_model = llm_model.strip()
        emb_model = llm_embedding_model.strip()

        # Write llmConfig (provider=custom so getProviderConfig uses customEndpoint)
        # Also write providerConfigs + activePresetId so that
        # llm_wiki startup / config-reload won't re-resolve llmConfig
        # from stale providerConfigs and overwrite these values.
        state["llmConfig"] = {
            "provider": "custom",
            "apiKey": key,
            "apiMode": "chat_completions",
            "customEndpoint": url,
            "maxContextSize": 128000,
            "model": chat_model or "gpt-3.5-turbo",
            "ollamaUrl": "http://localhost:11434",
        }
        state["activePresetId"] = "custom"
        state["providerConfigs"] = {
            "custom": {
                "apiKey": key,
                "model": chat_model or "gpt-3.5-turbo",
                "baseUrl": url,
                "apiMode": "chat_completions",
                "maxContextSize": 128000,
            },
        }

        # Write embeddingConfig
        if emb_model:
            state["embeddingConfig"] = {
                "enabled": True,
                "endpoint": f"{url}/embeddings" if url else "",
                "apiKey": key,
                "model": emb_model,
            }

        try:
            tmp = state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, state_file)
            return {"ok": True, "synced": True, "state_file": state_file}
        except (IOError, OSError) as e:
            return {"ok": False, "error": str(e)}

    def reload_llm_wiki_config(self) -> dict:
        """Notify the LLM Wiki backend to reload configuration from app-state.json.

        Uses self.token (the same token as all other API calls) first,
        falling back to _ensure_backend_token() only when no active
        token is set (e.g. during initial bootstrapping).  This avoids
        the class of bugs where _ensure_backend_token returns a token
        that differs from self.token and causes 401.
        """
        token = self.token or self._ensure_backend_token()
        url = f"{self.base_url}/api/v1/config/reload"
        _logger.info(f"reload_llm_wiki_config: url={url}, token={'present' if token else 'MISSING'}")

        try:
            resp = self._session.post(url, params={"token": token}, timeout=self.timeout)
            _logger.info(f"reload_llm_wiki_config: response status={resp.status_code}, body={resp.text[:500]}")
            resp.raise_for_status()
            return {"ok": True, "reloaded": True}
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            body = e.response.text[:500] if e.response is not None else ""
            error_msg = f"reload request failed (HTTP {status}): {body}"
            _logger.warning(f"reload_llm_wiki_config: {error_msg}")
            return {"ok": False, "error": error_msg}
        except requests.ConnectionError as e:
            error_msg = f"Cannot connect to LLM Wiki backend at {self.base_url}: {e}"
            _logger.warning(f"reload_llm_wiki_config: {error_msg}")
            return {"ok": False, "error": error_msg}
        except requests.Timeout as e:
            error_msg = f"LLM Wiki reload request timeout after {self.timeout}s: {e}"
            _logger.warning(f"reload_llm_wiki_config: {error_msg}")
            return {"ok": False, "error": error_msg}
        except Exception as e:
            error_msg = f"Unexpected error: {e}"
            _logger.error(f"reload_llm_wiki_config: {error_msg}", exc_info=True)
            return {"ok": False, "error": error_msg}

    def read_llm_config_from_app_state(self) -> dict:
        state_file = self._find_app_state_file()
        if not state_file:
            return {"ok": False, "error": "找不到 app-state.json"}

        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (json.JSONDecodeError, IOError):
            return {"ok": False, "error": "无法解析 app-state.json"}

        llm_cfg = state.get("llmConfig", {}) or {}
        emb_cfg = state.get("embeddingConfig", {}) or {}

        return {
            "ok": True,
            "state_file": state_file,
            "llm_config": {
                "provider": llm_cfg.get("provider", ""),
                "model": llm_cfg.get("model", ""),
                "api_key": llm_cfg.get("apiKey", ""),
                "endpoint": llm_cfg.get("customEndpoint", "") or llm_cfg.get("ollamaUrl", ""),
                "max_context_size": llm_cfg.get("maxContextSize", 0),
            },
            "embedding_config": {
                "enabled": emb_cfg.get("enabled", False),
                "model": emb_cfg.get("model", ""),
                "api_key": emb_cfg.get("apiKey", ""),
                "endpoint": emb_cfg.get("endpoint", ""),
            },
        }

    def _register_project_with_clip_server(
        self, project_path: str, project_name: str, set_current: bool = True
    ) -> dict:
        norm_path = project_path.replace("\\", "/").rstrip("/")

        result = self._clip_request("GET", "/projects")
        projects = result.get("projects", []) if result.get("ok") else []

        found = False
        for p in projects:
            if (p.get("path", "") or "").replace("\\", "/").rstrip("/") == norm_path:
                found = True
                break
        if not found:
            projects.append({"name": project_name, "path": norm_path})

        register_result = self._clip_request("POST", "/projects", {"projects": projects})

        current_result = {"ok": True}
        if set_current:
            current_result = self._clip_request("POST", "/project", {"path": norm_path})

        return {
            "registered": register_result.get("ok", False),
            "set_current": current_result.get("ok", False),
            "project_path": norm_path,
        }

    def create_project(
        self, name: str, path: str, template_content: bool = True
    ) -> Dict[str, Any]:
        root = os.path.join(path, name)
        if os.path.exists(root):
            return {
                "ok": False,
                "error": f"Directory already exists: '{root}'",
            }

        try:
            for dir_path in self._PROJECT_DIRS:
                os.makedirs(os.path.join(root, dir_path), exist_ok=True)

            if template_content:
                self._write_project_templates(root, name)

            norm_root = root.replace("\\", "/")

            project_id = self._generate_project_id()
            self._write_project_id_file(root, project_id)

            registration = self._register_project_with_clip_server(root, name, set_current=True)
            app_state_updated = self._update_app_state_project(root, name, project_id)

            return {
                "ok": True,
                "name": name,
                "path": norm_root,
                "project_id": project_id,
                "created_at": datetime.now().isoformat(),
                "backend_registration": registration,
                "app_state_updated": app_state_updated,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _write_project_templates(self, root: str, name: str) -> None:
        today = datetime.now().strftime("%Y-%m-%d")

        schema_content = f"""# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| entity | wiki/entities/ | Named things (models, companies, people, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena |
| source | wiki/sources/ | Papers, articles, talks, blog posts |
| query | wiki/queries/ | Open questions under investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |

## Naming Conventions

- Files: `kebab-case.md`
- Entities: match official name where possible (e.g., `gpt-4.md`, `openai.md`)
- Concepts: descriptive noun phrases (e.g., `chain-of-thought.md`)

## Frontmatter

All pages must include YAML frontmatter:

```yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

## Cross-referencing Rules

- Use `[[page-slug]]` syntax to link between wiki pages
- Every entity and concept should appear in `wiki/index.md`
"""

        self._write_text_file(os.path.join(root, "schema.md"), schema_content)

        purpose_content = """# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this research -->

1.
2.
3.

## Scope

**In scope:**
-

**Out of scope:**
-
"""
        self._write_text_file(os.path.join(root, "purpose.md"), purpose_content)

        index_content = """# Wiki Index

## Entities

## Concepts

## Sources

## Queries

## Comparisons

## Synthesis
"""
        self._write_text_file(os.path.join(root, "wiki/index.md"), index_content)

        log_content = f"""# Research Log

## {today}

- Project created
"""
        self._write_text_file(os.path.join(root, "wiki/log.md"), log_content)

        overview_content = """---
type: overview
title: Project Overview
tags: []
related: []
---

# Overview

<!-- Provide a high-level summary of what this wiki covers and its current state. -->
"""
        self._write_text_file(os.path.join(root, "wiki/overview.md"), overview_content)

    def _write_text_file(self, filepath: str, content: str) -> None:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)

    def validate_project(self, project_path: str) -> Dict[str, Any]:
        if not os.path.exists(project_path):
            return {"ok": False, "error": f"Path does not exist: '{project_path}'"}
        if not os.path.isdir(project_path):
            return {"ok": False, "error": f"Path is not a directory: '{project_path}'"}
        # 仅校验，不自动创建——避免在非项目目录（如公共知识库父目录）下误创建文件
        wiki_dir = os.path.join(project_path, "wiki")
        if not os.path.isdir(wiki_dir):
            return {"ok": False, "error": f"Not a valid wiki project (missing wiki/ directory): '{project_path}'"}
        schema_file = os.path.join(project_path, "schema.md")
        if not os.path.exists(schema_file):
            return {"ok": False, "error": f"Not a valid wiki project (missing schema.md): '{project_path}'"}
        return {"ok": True, "path": project_path.replace("\\", "/"), "valid": True}

    def open_project_by_path(self, project_path: str) -> Dict[str, Any]:
        validation = self.validate_project(project_path)
        if not validation.get("ok"):
            return validation
        norm_path = project_path.replace("\\", "/").rstrip("/")
        name = os.path.basename(project_path.rstrip("/").rstrip("\\"))

        existing_id = self._read_project_id_file(project_path)
        pid = existing_id
        if not existing_id:
            pid = self._generate_project_id()
            self._write_project_id_file(project_path, pid)

        registration = self._register_project_with_clip_server(project_path, name, set_current=True)
        app_state_updated = self._update_app_state_project(project_path, name, pid)

        # 等待 app-state.json 缓存 TTL 过期（5s），确保 Rust API Server 重新读取文件以找到新注册的项目
        _logger.info("[llm_wiki_client] 等待 6s 让 app-state.json 缓存 TTL 过期...")
        time.sleep(6)

        # 通知 Rust API Server 激活项目，由 Rust 端通过 Tauri 事件驱动前端切换
        try:
            _logger.info("[llm_wiki_client] 发送项目激活请求: projectId=%s, name=%s, path=%s", pid, name, norm_path)
            activate_result = self._post("/projects/activate", {"projectId": pid})
            if activate_result.get("ok"):
                _logger.info("[llm_wiki_client] 项目激活成功: projectId=%s", pid)
            else:
                _logger.warning("[llm_wiki_client] 项目激活失败: projectId=%s, result=%s", pid, activate_result)
        except Exception as e:
            activate_result = {"ok": False, "error": str(e)}
            _logger.error("[llm_wiki_client] 项目激活异常: %s", e)

        return {
            "ok": True,
            "name": name,
            "path": norm_path,
            "project_id": pid,
            "backend_registration": registration,
            "app_state_updated": app_state_updated,
            "activate_result": activate_result,
        }

    # ============================================================
    #  Raw source file management (file-system level)
    # ============================================================

    # ============================================================
    #  预处理服务（CloudModeling Markdown 文件转换，默认关闭，通过 config 开启）
    #  用于将 Markdown 中的 CloudModeling diagram URL 转换为 PlantUML / SVG
    # ============================================================

    _MARKDOWN_EXTENSIONS = {".md", ".mdx", ".markdown"}

    def _load_preprocessor_config(self) -> Dict[str, Any]:
        """从知识管理配置中加载预处理服务配置，默认关闭（每次重新读取以支持运行时切换）"""
        config_file = os.path.join(
            os.path.expanduser("~"), ".SSSC_AI", "knowledge_management.json"
        )
        try:
            if os.path.exists(config_file):
                with open(config_file, "r", encoding="utf-8") as f:
                    km_cfg = json.load(f)
                cfg = km_cfg.get("preprocessor", {"enabled": False})
                _preprocessor_logger.info("加载配置: enabled=%s, port=%s, timeout=%ss", cfg.get('enabled'), cfg.get('port'), cfg.get('timeout_seconds'))
                return cfg
            else:
                _preprocessor_logger.info("配置文件不存在: %s，使用默认关闭配置", config_file)
                return {"enabled": False}
        except (json.JSONDecodeError, IOError) as e:
            _preprocessor_logger.info("加载配置失败: %s，使用默认关闭配置", e)
            return {"enabled": False}

    def _is_preprocessor_enabled(self) -> bool:
        """预处理服务是否已启用"""
        cfg = self._load_preprocessor_config()
        enabled = cfg.get("enabled", False)
        _preprocessor_logger.info("预处理服务状态: %s", "已启用" if enabled else "未启用")
        return enabled

    def _read_login_credentials(self):
        """从 app_state.json 中读取登录凭据，作为预处理鉴权的回退来源"""
        app_state_file = os.path.join(
            os.path.expanduser("~"), ".SSSC_AI", "app_state.json"
        )
        _preprocessor_logger.info("读取登录凭据: path=%s", app_state_file)
        try:
            if os.path.exists(app_state_file):
                with open(app_state_file, "r", encoding="utf-8") as f:
                    state = json.load(f)

                # 优先从 memoryLoginConfig 读取
                login_cfg = state.get("memoryLoginConfig", {})
                username = login_cfg.get("username", "")
                password = login_cfg.get("password", "")

                # 如果 memoryLoginConfig 中没有密码，尝试从 memoryUserInfo 获取
                if not password:
                    user_info = state.get("memoryUserInfo", {})
                    password = user_info.get("password", "") or password
                    if not username:
                        username = user_info.get("name", "")

                _preprocessor_logger.info("登录凭据: username=%s, password=%s",
                    username if username else "(空)",
                    "***" if password else "(空)")
                return username, password
        except (json.JSONDecodeError, IOError) as e:
            _preprocessor_logger.info("读取登录凭据失败: %s", e)
        return "", ""

    @classmethod
    def _is_markdown_file(cls, file_path: str) -> bool:
        """判断文件是否为 Markdown 格式"""
        ext = os.path.splitext(file_path)[1].lower()
        return ext in cls._MARKDOWN_EXTENSIONS

    def _call_preprocessor(self, file_path: str, output_path: Optional[str] = None, task_id: Optional[str] = None) -> Optional[str]:
        """
        调用 CloudModeling 预处理服务处理 Markdown 文件。
        将 Markdown 中的 CloudModeling diagram URL 转换为 PlantUML 代码块或 SVG 图片引用。
        返回预处理输出文件路径，失败时返回 None。
        """
        start_time = time.time()

        cfg = self._load_preprocessor_config()
        port = cfg.get("port", 5900)
        timeout = cfg.get("timeout_seconds", 300)

        # 从登录状态中获取鉴权凭据
        username, password = self._read_login_credentials()

        url = f"http://127.0.0.1:{port}"

        filename = os.path.basename(file_path)
        file_size = os.path.getsize(file_path) if os.path.exists(file_path) else 0
        _preprocessor_logger.info("开始处理: %s (%s bytes), 目标端口: %s, 超时: %ss", filename, file_size, port, timeout)

        headers = {"Content-Type": "application/json"}
        if username and password:
            headers["X-Cloud-Username"] = username
            headers["X-Cloud-Password"] = password
            _preprocessor_logger.info("使用鉴权用户: %s", username)
        else:
            _preprocessor_logger.info("未配置鉴权信息")

        body = {"file_path": file_path}
        if output_path:
            body["output_path"] = output_path

        if task_id:
            set_import_progress(
                task_id,
                stage="preprocessing",
                message=f"正在调用预处理服务转换 {filename}（端口 {port}，超时 {timeout}s）…",
                current_file=filename,
            )

        try:
            resp = requests.post(
                f"{url}/process-file",
                json=body,
                headers=headers,
                timeout=timeout,
            )
            elapsed = time.time() - start_time
            if resp.status_code == 401:
                _preprocessor_logger.warning("鉴权失败 (401)，请检查 X-Cloud-Username 和 X-Cloud-Password 配置 (耗时 %.1fs)", elapsed)
                if task_id:
                    set_import_progress(task_id, stage="preprocess_skipped", message=f"{filename} 预处理鉴权失败，使用原始文件（{elapsed:.1f}s）")
                return None
            resp.raise_for_status()
            result = resp.json()
            if result.get("success"):
                out_path = result.get("output_path", "")
                _preprocessor_logger.info("处理成功 -> %s (耗时 %.1fs)", os.path.basename(out_path) if out_path else '无输出', elapsed)
                if task_id:
                    set_import_progress(task_id, stage="preprocess_done", message=f"{filename} 预处理转换完成（{elapsed:.1f}s）")
                return out_path
            else:
                _preprocessor_logger.warning("处理失败: %s (耗时 %.1fs)", result, elapsed)
                if task_id:
                    set_import_progress(task_id, stage="preprocess_skipped", message=f"{filename} 预处理失败，使用原始文件（{elapsed:.1f}s）")
                return None
        except requests.exceptions.ConnectionError:
            elapsed = time.time() - start_time
            _preprocessor_logger.warning("无法连接预处理服务 (%s)，跳过预处理 (耗时 %.1fs)", url, elapsed)
            if task_id:
                set_import_progress(task_id, stage="preprocess_skipped", message=f"无法连接预处理服务，使用原始文件（{elapsed:.1f}s）")
            return None
        except requests.exceptions.Timeout:
            elapsed = time.time() - start_time
            _preprocessor_logger.warning("预处理超时 (%ss) (耗时 %.1fs)", timeout, elapsed)
            if task_id:
                set_import_progress(task_id, stage="preprocess_skipped", message=f"{filename} 预处理超时，使用原始文件（{elapsed:.1f}s）")
            return None
        except Exception as e:
            elapsed = time.time() - start_time
            _preprocessor_logger.error("预处理异常: %s (耗时 %.1fs)", e, elapsed)
            if task_id:
                set_import_progress(task_id, stage="preprocess_skipped", message=f"{filename} 预处理异常，使用原始文件（{elapsed:.1f}s）")
            return None

    def _read_llm_config(self) -> Dict[str, str]:
        """从 models.json 和 knowledge_management.json 读取 LLM 配置"""
        config_dir = os.path.join(os.path.expanduser("~"), ".SSSC_AI")
        try:
            # 读取选中的模型 ID
            km_file = os.path.join(config_dir, "knowledge_management.json")
            selected_id = ""
            if os.path.exists(km_file):
                with open(km_file, "r", encoding="utf-8") as f:
                    km = json.load(f)
                selected_id = km.get("selectedModelConfigId", "")

            # 从 models.json 中查找模型配置
            models_file = os.path.join(config_dir, "models.json")
            if os.path.exists(models_file):
                with open(models_file, "r", encoding="utf-8") as f:
                    models_data = json.load(f)
                models = models_data.get("MODELS", [])
                for m in models:
                    if m.get("id") == selected_id:
                        return {
                            "llm_url": m.get("url", ""),
                            "llm_api_key": m.get("apiKey", ""),
                            "llm_model": m.get("model", ""),
                        }
                if models:
                    m = models[0]
                    return {
                        "llm_url": m.get("url", ""),
                        "llm_api_key": m.get("apiKey", ""),
                        "llm_model": m.get("model", ""),
                    }
        except (json.JSONDecodeError, IOError) as e:
            _preprocessor_logger.info("读取 LLM 配置失败: %s", e)
        return {"llm_url": "", "llm_api_key": "", "llm_model": ""}

    @classmethod
    def _extract_plantuml_blocks(cls, content: str) -> List[Dict[str, str]]:
        """从 Markdown 内容中提取所有 PlantUML 代码块及其 alt 文本"""
        PLANTUML_PATTERN = re.compile(
            r'```plantuml\s*\r?\n(.*?)```', re.DOTALL
        )
        blocks = []
        for match in PLANTUML_PATTERN.finditer(content):
            uml_content = match.group(1).rstrip('\r').strip()
            if uml_content:
                idx = match.start()
                preceding = content[max(0, idx - 500):idx]

                alt_text = ""

                # 策略1: 查找 ![alt](...svg/png) 引用
                svg_match = re.search(
                    r'!\[([^\]]*)\]\([^)]*(?:\.(?:svg|png|puml))[^)]*\)\s*\r?\n?\s*$',
                    preceding, re.MULTILINE
                )
                if svg_match and svg_match.group(1).strip():
                    alt_text = svg_match.group(1).strip()

                # 策略2: 查找 ![alt](...) 任意引用
                if not alt_text:
                    img_match = re.search(
                        r'!\[([^\]]*)\]\([^)]+\)\s*\r?\n?\s*$',
                        preceding, re.MULTILINE
                    )
                    if img_match and img_match.group(1).strip():
                        alt_text = img_match.group(1).strip()

                # 策略3: 从 plantuml 内容中提取 @startuml 的 title
                if not alt_text:
                    title_match = re.search(r"^\s*title\s+(.+)$", uml_content, re.MULTILINE | re.IGNORECASE)
                    if title_match:
                        alt_text = title_match.group(1).strip()

                blocks.append({
                    "content": uml_content,
                    "alt": alt_text,
                })
        return blocks

    def _summarize_plantuml_with_llm(self, plantuml_content: str, alt_text: str) -> Optional[str]:
        """调用 LLM 总结 PlantUML 图表的内容描述"""
        llm_cfg = self._read_llm_config()
        llm_url = llm_cfg.get("llm_url", "")
        llm_api_key = llm_cfg.get("llm_api_key", "")
        llm_model = llm_cfg.get("llm_model", "")

        if not llm_url or not llm_model:
            _preprocessor_logger.info("LLM 配置不完整，跳过 PlantUML 总结")
            return None

        # 构建 chat completions URL
        chat_url = llm_url.rstrip("/")
        lower = chat_url.lower()
        if not lower.endswith("/chat/completions"):
            if not lower.endswith("/v1") and not lower.endswith("/v3") and "coding/v3" not in lower:
                chat_url += "/v1"
            chat_url += "/chat/completions"

        system_prompt = (
            "你是一个技术文档助手。请用简洁的中文总结下面 PlantUML 时序图/流程图描述的业务逻辑。"
            "只输出总结内容，不要加前缀。控制在 3-5 句话内。"
        )
        user_msg = f"请总结以下 PlantUML 图表{' (' + alt_text + ')' if alt_text else ''}：\n\n```plantuml\n{plantuml_content}\n```"

        headers = {"Content-Type": "application/json"}
        if llm_api_key:
            headers["Authorization"] = f"Bearer {llm_api_key}"

        body = {
            "model": llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            "temperature": 0.3,
            "max_tokens": 512,
        }

        try:
            resp = requests.post(chat_url, json=body, headers=headers, timeout=120)
            if not resp.ok:
                _preprocessor_logger.info("LLM 调用失败 HTTP %s: %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            choices = data.get("choices", [{}])
            return choices[0].get("message", {}).get("content", "").strip()
        except Exception as e:
            _preprocessor_logger.info("LLM 总结 PlantUML 异常: %s", e)
            return None

    def _process_plantuml_after_preprocess(
        self, final_source_path: str, dest_dir: str, task_id: Optional[str] = None
    ) -> int:
        """
        处理预处理后的 markdown 文件：
        1. 提取所有 PlantUML 代码块
        2. 调用 LLM 总结每个图
        3. 生成独立的 markdown 文件放入子文件夹
        返回生成的 PlantUML 文件数量
        """
        try:
            with open(final_source_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            _preprocessor_logger.info("读取预处理文件失败: %s", e)
            return 0

        blocks = self._extract_plantuml_blocks(content)
        if not blocks:
            _preprocessor_logger.info("未找到 PlantUML 代码块")
            return 0

        _preprocessor_logger.info("找到 %s 个 PlantUML 代码块，开始 LLM 总结...", len(blocks))
        if task_id:
            set_import_progress(
                task_id,
                stage="plantuml_summarizing",
                plantuml_total=len(blocks),
                plantuml_done=0,
                message=f"提取到 {len(blocks)} 个图表，开始 LLM 总结…",
            )

        # 基于转换后的 markdown 文件名创建子文件夹
        base_name = os.path.splitext(os.path.basename(final_source_path))[0]
        # 移除 _plantuml 后缀（如果有）
        if base_name.endswith("_plantuml"):
            base_name = base_name[:-len("_plantuml")]
        plantuml_dir = os.path.join(dest_dir, f"{base_name}_plantuml")
        os.makedirs(plantuml_dir, exist_ok=True)

        saved_count = 0
        for i, block in enumerate(blocks):
            alt = block["alt"] or ""
            uml_content = block["content"]

            if task_id:
                set_import_progress(
                    task_id,
                    message=f"正在用 LLM 总结图表 {i + 1}/{len(blocks)}…",
                )

            # 调用 LLM 总结
            summary = self._summarize_plantuml_with_llm(uml_content, alt)

            # 生成安全文件名：优先用 alt，没有则用 LLM 总结前几个词，否则用序号
            raw_name = alt.strip()
            if not raw_name and summary:
                # 从总结中取前 60 个字符作为文件名基础
                raw_name = re.sub(r'[，。,\.、；;：:！!？?\s]+', ' ', summary[:80]).strip()
            if not raw_name:
                raw_name = f"Diagram {i + 1}"

            safe_name = re.sub(r'[\\/*?:"<>|]', '_', raw_name)
            safe_name = safe_name.strip().replace(' ', '_')[:60]
            safe_name = safe_name.strip('_')
            if not safe_name:
                safe_name = f"diagram_{i + 1}"

            # 始终加序号前缀防止重名
            md_file = os.path.join(plantuml_dir, f"{i + 1:02d}_{safe_name}.md")

            # 标题使用 alt 或序号
            title = alt if alt else (f"Diagram {i + 1}" + (f" - {summary[:40]}" if summary else ""))
            lines = []
            lines.append(f"# {title}")
            lines.append("")
            if summary:
                lines.append(f"> {summary}")
                lines.append("")
            lines.append("```plantuml")
            lines.append(uml_content)
            lines.append("```")
            lines.append("")

            try:
                with open(md_file, "w", encoding="utf-8") as f:
                    f.write("\n".join(lines))
                saved_count += 1
                _preprocessor_logger.info("[%d/%d] 已保存: %s%s",
                    i + 1, len(blocks),
                    os.path.basename(md_file),
                    f" (总结: {summary[:50]}...)" if summary else " (无总结)")
            except Exception as e:
                _preprocessor_logger.info("保存 PlantUML 文件失败: %s", e)

            if task_id:
                set_import_progress(task_id, plantuml_done=i + 1)

        _preprocessor_logger.info("PlantUML 处理完成: 提取=%s, 保存=%s, 目录=%s",
            len(blocks), saved_count, plantuml_dir)
        return saved_count

    def _raw_sources_dir(self, project_path: str) -> str:
        return os.path.join(project_path, "raw", "sources")

    def import_raw_source_file(
        self,
        project_path: str,
        source_file_path: str,
        target_subdir: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not os.path.isfile(source_file_path):
            return {"ok": False, "error": f"Source file not found: '{source_file_path}'"}

        dest_dir = self._raw_sources_dir(project_path)
        if target_subdir:
            dest_dir = os.path.join(dest_dir, target_subdir)

        original_filename = os.path.basename(source_file_path)
        is_md = self._is_markdown_file(source_file_path)
        preprocessor_enabled = self._is_preprocessor_enabled()

        # 需要预处理时：先拷贝到临时目录，预处理后得到输出文件，再用输出文件作为源文件
        needs_preprocess = preprocessor_enabled and is_md
        _preprocessor_logger.info("导入文件判断: 文件=%s, 是否Markdown=%s, 预处理启用=%s, 是否触发预处理=%s", original_filename, is_md, preprocessor_enabled, needs_preprocess)

        if task_id:
            if needs_preprocess:
                set_import_progress(
                    task_id,
                    stage="preprocess_starting",
                    current_file=original_filename,
                    message=f"准备预处理 {original_filename}…",
                )
            else:
                set_import_progress(
                    task_id,
                    stage="copying",
                    current_file=original_filename,
                    message=f"正在复制 {original_filename}…",
                )

        final_source_path = source_file_path
        final_filename = original_filename
        tmp_dir = None

        try:
            if needs_preprocess:
                # 在临时目录中拷贝源文件并调用预处理
                tmp_dir = tempfile.mkdtemp(prefix="md_preprocess_")
                tmp_source = os.path.join(tmp_dir, original_filename)
                shutil.copy2(source_file_path, tmp_source)

                preprocess_output = self._call_preprocessor(tmp_source, task_id=task_id)
                if preprocess_output and os.path.isfile(preprocess_output):
                    final_source_path = preprocess_output
                    final_filename = os.path.basename(preprocess_output)
                    _preprocessor_logger.info("预处理成功: %s", final_filename)
                else:
                    _preprocessor_logger.warning("预处理未产生有效输出，使用原始文件")

            os.makedirs(dest_dir, exist_ok=True)
            dest_path = os.path.join(dest_dir, final_filename)
            shutil.copy2(final_source_path, dest_path)
            relative_path = os.path.relpath(dest_path, self._raw_sources_dir(project_path))

            result = {
                "ok": True,
                "source": source_file_path,
                "destination": dest_path.replace("\\", "/"),
                "relative_path": relative_path.replace("\\", "/"),
                "filename": final_filename,
                "size": os.path.getsize(dest_path),
                "imported_at": datetime.now().isoformat(),
            }

            if needs_preprocess and final_source_path != source_file_path:
                result["preprocessed"] = True
                result["preprocessed_output"] = final_source_path.replace("\\", "/")
                # 从转换后的 markdown 中提取 PlantUML，调用 LLM 总结并保存
                try:
                    plantuml_count = self._process_plantuml_after_preprocess(
                        final_source_path, dest_dir, task_id=task_id
                    )
                    if plantuml_count > 0:
                        result["plantuml_files"] = plantuml_count
                except Exception as e:
                    _preprocessor_logger.info("PlantUML 后处理失败: %s", e)

            return result
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            # 清理临时目录
            if tmp_dir and os.path.isdir(tmp_dir):
                try:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                except Exception:
                    pass

    def import_raw_source_folder(
        self,
        project_path: str,
        source_folder_path: str,
        folder_name: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not os.path.isdir(source_folder_path):
            return {"ok": False, "error": f"Source folder not found: '{source_folder_path}'"}

        target_name = folder_name or os.path.basename(source_folder_path.rstrip("/").rstrip("\\"))
        dest_dir = os.path.join(self._raw_sources_dir(project_path), target_name)

        try:
            copied_files = []
            preprocessed_files = []
            folder_preprocessor_enabled = self._is_preprocessor_enabled()
            _preprocessor_logger.info("文件夹导入: 预处理启用=%s, 源文件夹=%s", folder_preprocessor_enabled, source_folder_path)

            if task_id:
                set_import_progress(
                    task_id,
                    stage="folder_copying",
                    current_file=target_name,
                    message=f"正在复制文件夹 {target_name}…",
                )

            shutil.copytree(source_folder_path, dest_dir, dirs_exist_ok=True)
            md_count = 0
            for dirpath, _, filenames in os.walk(dest_dir):
                for filename in filenames:
                    filepath = os.path.join(dirpath, filename)
                    rel = os.path.relpath(filepath, self._raw_sources_dir(project_path))
                    copied_files.append(
                        {
                            "relative_path": rel.replace("\\", "/"),
                            "size": os.path.getsize(filepath),
                        }
                    )

                    # Markdown 文件调用预处理服务（需配置启用）
                    if folder_preprocessor_enabled and self._is_markdown_file(filepath):
                        md_count += 1
                        _preprocessor_logger.info("文件夹导入-处理第%s个Markdown: %s", md_count, filename)
                        preprocess_result = self._call_preprocessor(filepath, task_id=task_id)
                        if preprocess_result:
                            preprocessed_files.append({
                                "relative_path": rel.replace("\\", "/"),
                                "preprocessed_output": preprocess_result,
                            })
                            # 从转换后的文件提取 PlantUML 并 LLM 总结
                            try:
                                preprocessed_output_path = preprocess_result
                                if os.path.isfile(preprocessed_output_path):
                                    file_parent_dir = os.path.dirname(filepath)
                                    self._process_plantuml_after_preprocess(
                                        preprocessed_output_path, file_parent_dir, task_id=task_id
                                    )
                            except Exception as e:
                                _preprocessor_logger.info("PlantUML 后处理失败(%s): %s", filename, e)
            _preprocessor_logger.info("文件夹导入完成: 总文件=%s, Markdown文件=%s, 预处理成功=%s", len(copied_files), md_count, len(preprocessed_files))

            result = {
                "ok": True,
                "source_folder": source_folder_path,
                "destination": dest_dir.replace("\\", "/"),
                "folder_name": target_name,
                "files": copied_files,
                "file_count": len(copied_files),
                "imported_at": datetime.now().isoformat(),
            }
            if preprocessed_files:
                result["preprocessed_files"] = preprocessed_files
            return result
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_project_by_path(self, project_path: str, deep: bool = False) -> Dict[str, Any]:
        """取消注册项目，deep=True 时同时删除磁盘文件"""
        import shutil

        norm_path = project_path.replace("\\", "/").rstrip("/")
        name = os.path.basename(project_path.rstrip("/").rstrip("\\"))

        # 深度删除：用户已二次确认，只要目录存在就递归删除。
        # 不再要求是“完整的 wiki 项目”——否则 wiki/ 或 schema.md 缺失时
        # 会静默跳过删除，导致用户选了深度删除而磁盘文件依然存在。
        disk_deleted = False
        if deep:
            real_path = os.path.abspath(project_path)
            stripped = real_path.rstrip("\\/")
            _drive, tail = os.path.splitdrive(stripped)
            # 安全护栏：拒绝删除盘符根 / 文件系统根目录
            if not tail or tail in ("\\", "/", os.sep):
                return {"ok": False, "error": f"拒绝删除根目录: '{real_path}'"}
            if not os.path.isdir(real_path):
                return {"ok": False, "error": f"路径不是目录或不存在: '{real_path}'"}
            try:
                shutil.rmtree(real_path)
                disk_deleted = True
            except Exception as e:
                return {"ok": False, "error": f"删除磁盘文件失败: {str(e)}"}

        # 1. 从 clip server 的项目列表中移除
        result = self._clip_request("GET", "/projects")
        projects = result.get("projects", []) if result.get("ok") else []
        new_projects = [
            p for p in projects
            if (p.get("path", "") or "").replace("\\", "/").rstrip("/") != norm_path
        ]
        if len(new_projects) < len(projects):
            self._clip_request("POST", "/projects", {"projects": new_projects})

        # 2. 从 app-state.json 中移除
        state_file = self._find_app_state_file()
        if state_file:
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    state = json.load(f)
            except (json.JSONDecodeError, IOError):
                state = {}

            pid = self._read_project_id_file(project_path) or norm_path
            registry = state.get("projectRegistry", {})
            registry.pop(pid, None)
            state["projectRegistry"] = registry

            recents = state.get("recentProjects", [])
            state["recentProjects"] = [
                r for r in recents
                if (r.get("path", "") or "").replace("\\", "/").rstrip("/") != norm_path
            ]

            # 3. 如果 lastProject 指向该项目，将其删除或置空
            last_project = state.get("lastProject")
            if last_project and (last_project.get("path", "") or "").replace("\\", "/").rstrip("/") == norm_path:
                state.pop("lastProject", None)

            try:
                tmp = state_file + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(state, f, ensure_ascii=False, indent=2)
                os.replace(tmp, state_file)
            except (IOError, OSError):
                pass

        # 4. 如果 LLM Wiki 正在运行，通知它重新加载配置
        reload_result = {"ok": False, "error": "reload not attempted"}
        try:
            reload_result = self.reload_llm_wiki_config()
        except Exception:
            pass

        return {
            "ok": True,
            "project_path": norm_path,
            "name": name,
            "removed": True,
            "disk_deleted": disk_deleted,
            "config_reloaded": reload_result.get("ok", False),
        }

    def delete_raw_source(
        self,
        project_path: str,
        relative_path: str,
    ) -> Dict[str, Any]:
        target_path = os.path.normpath(
            os.path.join(self._raw_sources_dir(project_path), relative_path)
        )
        sources_root = os.path.normpath(self._raw_sources_dir(project_path))
        if not target_path.startswith(sources_root + os.sep) and target_path != sources_root:
            return {"ok": False, "error": f"Path traversal denied: '{relative_path}'"}

        if not os.path.exists(target_path):
            return {"ok": False, "error": f"Source not found: '{relative_path}'"}

        try:
            if os.path.isfile(target_path):
                os.remove(target_path)
                return {
                    "ok": True,
                    "deleted": relative_path,
                    "type": "file",
                    "deleted_at": datetime.now().isoformat(),
                }
            else:
                return {"ok": False, "error": f"Use delete_raw_source_folder for directories: '{relative_path}'"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_raw_source_folder(
        self,
        project_path: str,
        relative_path: str,
    ) -> Dict[str, Any]:
        target_path = os.path.normpath(
            os.path.join(self._raw_sources_dir(project_path), relative_path)
        )
        sources_root = os.path.normpath(self._raw_sources_dir(project_path))
        if not target_path.startswith(sources_root + os.sep) and target_path != sources_root:
            return {"ok": False, "error": f"Path traversal denied: '{relative_path}'"}

        if not os.path.exists(target_path):
            return {"ok": False, "error": f"Source folder not found: '{relative_path}'"}

        try:
            if os.path.isdir(target_path):
                deleted_count = sum(1 for _, _, files in os.walk(target_path) for _ in files)
                shutil.rmtree(target_path)
                return {
                    "ok": True,
                    "deleted": relative_path,
                    "type": "folder",
                    "file_count": deleted_count,
                    "deleted_at": datetime.now().isoformat(),
                }
            else:
                return {"ok": False, "error": f"Not a directory: '{relative_path}'"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def list_raw_sources(
        self,
        project_path: str,
        subdir: Optional[str] = None,
        recursive: bool = True,
    ) -> Dict[str, Any]:
        base_dir = self._raw_sources_dir(project_path)
        if subdir:
            base_dir = os.path.join(base_dir, subdir)

        if not os.path.exists(base_dir):
            return {"ok": True, "sources": [], "total": 0}

        try:
            sources = []
            if recursive:
                for dirpath, dirnames, filenames in os.walk(base_dir):
                    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                    for filename in filenames:
                        if filename.startswith("."):
                            continue
                        filepath = os.path.join(dirpath, filename)
                        rel = os.path.relpath(filepath, self._raw_sources_dir(project_path))
                        stat = os.stat(filepath)
                        sources.append(
                            {
                                "relative_path": rel.replace("\\", "/"),
                                "filename": filename,
                                "size": stat.st_size,
                                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                                "is_dir": False,
                            }
                        )
            else:
                for item in os.listdir(base_dir):
                    if item.startswith("."):
                        continue
                    item_path = os.path.join(base_dir, item)
                    rel = os.path.relpath(item_path, self._raw_sources_dir(project_path))
                    if os.path.isdir(item_path):
                        sources.append(
                            {
                                "relative_path": rel.replace("\\", "/") + "/",
                                "filename": item,
                                "size": 0,
                                "modified_at": datetime.fromtimestamp(
                                    os.stat(item_path).st_mtime
                                ).isoformat(),
                                "is_dir": True,
                            }
                        )
                    else:
                        stat = os.stat(item_path)
                        sources.append(
                            {
                                "relative_path": rel.replace("\\", "/"),
                                "filename": item,
                                "size": stat.st_size,
                                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                                "is_dir": False,
                            }
                        )

            return {"ok": True, "sources": sources, "total": len(sources)}
        except Exception as e:
            return {"ok": False, "error": str(e)}
