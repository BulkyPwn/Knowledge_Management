"""
公共知识库同步模块
负责检测本地公共知识库是否存在，若不存在则从服务器通过 SCP 递归下载。
"""

import os
import json
import socket
import threading
from pathlib import Path
from typing import Dict, Any, Optional

try:
    import paramiko
    HAS_PARAMIKO = True
except ImportError:
    HAS_PARAMIKO = False

# 默认配置（字典格式，name 为 key）
DEFAULT_CONFIG = {
    "common": {
        "host": "7.212.122.246",
        "port": 22,
        "username": "root",
        "password": "Huawei12#$",
        "remote_path": "/home/Knowledge_Management/common",
        "local_path": "D:\\Knowledge_Management\\common",
    }
}

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "llm_wiki_server", "config", "common_kb_config.json")

# 全局同步进度存储: {task_id: {"total_files": int, "downloaded_files": int, "downloaded_dirs": int, "status": str, "message": str, "started_at": float}}
_sync_progress: Dict[str, dict] = {}
_sync_progress_lock = threading.Lock()


def get_sync_progress(task_id: str) -> dict:
    """获取指定同步任务的进度"""
    with _sync_progress_lock:
        return _sync_progress.get(task_id, {"total_files": 0, "downloaded_files": 0, "downloaded_dirs": 0, "status": "not_found"})


def _set_sync_progress(task_id: str, **kwargs):
    """更新同步进度"""
    with _sync_progress_lock:
        if task_id not in _sync_progress:
            _sync_progress[task_id] = {"total_files": 0, "downloaded_files": 0, "downloaded_dirs": 0, "status": "running", "message": ""}
        _sync_progress[task_id].update(kwargs)


def _get_config_file() -> str:
    """获取配置文件路径，确保目录存在"""
    data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "llm_wiki_server", "config")
    os.makedirs(data_dir, exist_ok=True)
    return CONFIG_FILE


def load_config(name: Optional[str] = None) -> Dict[str, Any]:
    """加载公共知识库配置，返回某个命名条目的扁平配置字典"""
    config_file = _get_config_file()
    saved = {}
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                saved = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # 如果保存的是旧版扁平格式（无 name 层级），自动包装
    if saved and "host" in saved:
        saved = {"common": saved}

    # 合并默认值
    merged = {}
    for entry_name, entry in DEFAULT_CONFIG.items():
        merged[entry_name] = dict(entry)
    for entry_name, entry in saved.items():
        if entry_name not in merged:
            merged[entry_name] = dict(entry)
        else:
            merged[entry_name].update(entry)

    # 如果指定了 name，返回对应条目
    if name and name in merged:
        return merged[name]

    # 否则返回第一个条目
    first_name = next(iter(merged))
    return merged[first_name]


def list_servers() -> list:
    """列出所有已配置的服务器名称及其摘要信息"""
    config_file = _get_config_file()
    all_configs = {}
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                all_configs = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # 兼容旧版扁平格式
    if all_configs and "host" in all_configs:
        all_configs = {"common": all_configs}

    servers = []
    for name, cfg in all_configs.items():
        servers.append({
            "name": name,
            "host": cfg.get("host", ""),
            "port": cfg.get("port", 22),
            "remote_path": cfg.get("remote_path", ""),
            "local_path": cfg.get("local_path", ""),
        })
    return servers


def save_config(config: Dict[str, Any], name: Optional[str] = None) -> None:
    """保存公共知识库配置，将扁平配置字典写回指定命名条目"""
    config_file = _get_config_file()

    # 读取已有配置
    existing = {}
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # 兼容旧版扁平格式
    if existing and "host" in existing:
        existing = {"common": existing}

    # 确定写入的 name
    entry_name = name or next(iter(existing)) if existing else "common"

    if entry_name not in existing:
        # 新条目：从 DEFAULT_CONFIG 继承
        if entry_name in DEFAULT_CONFIG:
            existing[entry_name] = dict(DEFAULT_CONFIG[entry_name])
        else:
            existing[entry_name] = dict(DEFAULT_CONFIG.get("common", {}))
    existing[entry_name].update(config)

    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)


def delete_server_config(name: str) -> bool:
    """删除指定名称的服务器配置，返回是否成功删除"""
    if not name:
        return False
    config_file = _get_config_file()
    if not os.path.exists(config_file):
        return False
    try:
        with open(config_file, "r", encoding="utf-8") as f:
            existing = json.load(f)
    except (json.JSONDecodeError, IOError):
        return False

    # 兼容旧版扁平格式
    if existing and "host" in existing:
        existing = {"common": existing}

    if name not in existing:
        return False

    # 不允许删除 DEFAULT_CONFIG 中的条目（只能删除用户手动添加的）
    if name in DEFAULT_CONFIG:
        return False

    del existing[name]

    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)
    return True


def check_local_kb(local_path: str) -> Dict[str, Any]:
    """检测本地公共知识库是否存在"""
    path = Path(local_path)
    exists = path.exists() and path.is_dir()
    if exists:
        try:
            items = list(path.iterdir())
            file_count = sum(1 for item in items if item.is_file())
            dir_count = sum(1 for item in items if item.is_dir())
            return {
                "exists": True,
                "path": str(path.absolute()),
                "file_count": file_count,
                "dir_count": dir_count,
                "total_items": dir_count,
            }
        except PermissionError:
            return {"exists": True, "path": str(path.absolute()), "error": "Permission denied"}
    return {"exists": False, "path": str(path.absolute())}


def check_server_reachable(host: str, port: int = 22, timeout: int = 10) -> Dict[str, Any]:
    """检测服务器是否可达（TCP 连接测试 + SSH 认证测试）"""
    if not host:
        return {"reachable": False, "error": "未配置服务器 IP"}

    # TCP 连接测试
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((host, port))
    except socket.timeout:
        return {"reachable": False, "error": f"连接 {host}:{port} 超时"}
    except socket.gaierror:
        return {"reachable": False, "error": f"无法解析主机名: {host}"}
    except ConnectionRefusedError:
        return {"reachable": False, "error": f"连接被拒绝: {host}:{port}"}
    except OSError as e:
        return {"reachable": False, "error": f"网络错误: {str(e)}"}
    finally:
        if sock:
            sock.close()

    return {"reachable": True, "host": host, "port": port}


def _ssh_connect(host: str, port: int, username: str, password: str,
                  timeout: int = 15) -> paramiko.SSHClient:
    """创建 SSH 连接，带多策略回退。

    首选 Transport + auth_password（等效于 sftp -o PreferredAuthentications=password），
    SSHClient.connect() 在某些服务器上认证协商会失败。
    """
    # 策略1: Transport 底层连接 + 显式密码认证（最可靠，等效于 sftp 命令行）
    sock = None
    transport = None
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        transport = paramiko.Transport(sock)
        transport.start_client()
        transport.auth_password(username, password)

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh._transport = transport
        return ssh
    except Exception:
        if transport:
            transport.close()
        elif sock:
            sock.close()
        # 继续尝试后续策略
        pass

    # 策略2: SSHClient.connect() 默认方式
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=host, port=port, username=username, password=password,
            timeout=timeout, allow_agent=False, look_for_keys=False,
        )
        return ssh
    except paramiko.SSHException:
        pass

    # 策略3: 允许旧版 ssh-rsa 主机密钥
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=host, port=port, username=username, password=password,
            timeout=timeout, allow_agent=False, look_for_keys=False,
            disabled_algorithms={"pubkeys": ["rsa-sha2-256", "rsa-sha2-512"]},
        )
        return ssh
    except paramiko.SSHException as e:
        raise e


def check_server_auth(host: str, port: int, username: str, password: str,
                      timeout: int = 15) -> Dict[str, Any]:
    """检测 SSH 认证是否通过"""
    if not HAS_PARAMIKO:
        return {"authenticated": False, "error": "paramiko 未安装，无法进行 SSH 认证检测"}

    ssh = None
    try:
        ssh = _ssh_connect(host, port, username, password, timeout)
        return {"authenticated": True, "host": host, "username": username}
    except paramiko.AuthenticationException:
        return {"authenticated": False, "error": "SSH 认证失败，请检查用户名和密码"}
    except paramiko.SSHException as e:
        return {"authenticated": False, "error": f"SSH 连接错误: {str(e)}"}
    except socket.timeout:
        return {"authenticated": False, "error": "SSH 连接超时"}
    except Exception as e:
        return {"authenticated": False, "error": f"SSH 错误: {str(e)}"}
    finally:
        if ssh:
            ssh.close()


def list_remote_tree(host: str, port: int, username: str, password: str,
                     remote_path: str, timeout: int = 30, max_depth: int = 5) -> Dict[str, Any]:
    """列出远程目录树结构"""
    if not HAS_PARAMIKO:
        return {"success": False, "error": "paramiko 未安装"}

    ssh = None
    sftp = None
    try:
        ssh = _ssh_connect(host, port, username, password, timeout)
        sftp = ssh.open_sftp()

        def _list_recursive(remote_dir: str, depth: int) -> dict:
            node = {"name": os.path.basename(remote_dir) or remote_dir,
                    "path": remote_dir,
                    "is_dir": True,
                    "children": []}

            if depth >= max_depth:
                node["truncated"] = True
                return node

            try:
                items = sftp.listdir_attr(remote_dir)
            except IOError as e:
                node["error"] = str(e)
                return node

            for item in items:
                remote_item = remote_dir + "/" + item.filename
                if item.st_mode & 0o40000:
                    child = _list_recursive(remote_item, depth + 1)
                else:
                    child = {
                        "name": item.filename,
                        "path": remote_item,
                        "is_dir": False,
                        "size": item.st_size if item.st_size else 0,
                        "children": [],
                    }
                node["children"].append(child)

            return node

        tree = _list_recursive(remote_path, 0)
        return {"success": True, "data": tree}

    except paramiko.AuthenticationException:
        return {"success": False, "error": "SSH 认证失败，请检查用户名和密码"}
    except paramiko.SSHException as e:
        return {"success": False, "error": f"SSH 连接错误: {str(e)}"}
    except socket.timeout:
        return {"success": False, "error": "SSH 连接超时"}
    except Exception as e:
        return {"success": False, "error": f"列出目录失败: {str(e)}"}
    finally:
        if sftp:
            sftp.close()
        if ssh:
            ssh.close()


def download_selected_items(host: str, port: int, username: str, password: str,
                            remote_path: str, local_path: str,
                            selected_paths: list = None,
                            timeout: int = 30,
                            task_id: str = None) -> Dict[str, Any]:
    """按选中路径下载远程目录/文件到本地，保持目录结构

    若提供 task_id，则会在同一个 SSH 连接内先统计文件总数，再下载并实时更新进度。
    """
    if not HAS_PARAMIKO:
        return {"success": False, "error": "paramiko 未安装，请运行: pip install paramiko"}

    local_dir = Path(local_path)
    local_dir.mkdir(parents=True, exist_ok=True)

    ssh = None
    sftp = None
    total_files = 0
    downloaded_files = 0
    downloaded_dirs = 0
    failed_items = []

    try:
        ssh = _ssh_connect(host, port, username, password, timeout)
        sftp = ssh.open_sftp()

        # ========== Phase 1: 用同一个 SSH 连接统计文件总数 ==========
        if task_id:
            def _count_recursive(remote_dir: str):
                nonlocal total_files
                try:
                    items = sftp.listdir_attr(remote_dir)
                except IOError:
                    return
                for item in items:
                    remote_item = remote_dir + "/" + item.filename
                    if item.st_mode & 0o40000:
                        _count_recursive(remote_item)
                    else:
                        total_files += 1

            _set_sync_progress(task_id, status="running", message="正在统计文件数量...")

            if selected_paths:
                for sel_path in selected_paths:
                    try:
                        stat = sftp.stat(sel_path)
                    except IOError:
                        continue
                    if stat.st_mode & 0o40000:
                        _count_recursive(sel_path)
                    else:
                        total_files += 1
            else:
                _count_recursive(remote_path)

            _set_sync_progress(task_id, total_files=total_files,
                               downloaded_files=0, downloaded_dirs=0,
                               status="downloading",
                               message="正在使用 SFTP 下载公共知识库...")

        # ========== Phase 2: 下载文件 ==========
        def _download_recursive(remote_dir: str, local_dir: str) -> None:
            nonlocal downloaded_files, downloaded_dirs
            try:
                items = sftp.listdir_attr(remote_dir)
            except IOError as e:
                failed_items.append({"path": remote_dir, "error": str(e)})
                return

            for item in items:
                remote_item = remote_dir + "/" + item.filename
                local_item = os.path.join(local_dir, item.filename)

                if item.st_mode & 0o40000:
                    try:
                        os.makedirs(local_item, exist_ok=True)
                        downloaded_dirs += 1
                        _download_recursive(remote_item, local_item)
                    except OSError as e:
                        failed_items.append({"path": remote_item, "error": str(e)})
                else:
                    try:
                        sftp.get(remote_item, local_item)
                        downloaded_files += 1
                        if task_id:
                            _set_sync_progress(task_id,
                                               downloaded_files=downloaded_files,
                                               downloaded_dirs=downloaded_dirs,
                                               message=f"正在使用 SFTP 下载公共知识库... ({downloaded_files}/{total_files})")
                    except IOError as e:
                        failed_items.append({"path": remote_item, "error": str(e)})

        if selected_paths:
            for sel_path in selected_paths:
                relative = os.path.relpath(sel_path, remote_path) if sel_path.startswith(remote_path) else sel_path
                local_target = os.path.join(str(local_dir), relative)

                try:
                    stat = sftp.stat(sel_path)
                except IOError as e:
                    failed_items.append({"path": sel_path, "error": str(e)})
                    continue

                if stat.st_mode & 0o40000:
                    os.makedirs(local_target, exist_ok=True)
                    downloaded_dirs += 1
                    _download_recursive(sel_path, local_target)
                else:
                    local_parent = os.path.dirname(local_target)
                    if local_parent:
                        os.makedirs(local_parent, exist_ok=True)
                    try:
                        sftp.get(sel_path, local_target)
                        downloaded_files += 1
                        if task_id:
                            _set_sync_progress(task_id,
                                               downloaded_files=downloaded_files,
                                               downloaded_dirs=downloaded_dirs,
                                               message=f"正在使用 SFTP 下载公共知识库... ({downloaded_files}/{total_files})")
                    except IOError as e:
                        failed_items.append({"path": sel_path, "error": str(e)})
        else:
            _download_recursive(remote_path, str(local_dir))

        return {
            "success": True,
            "local_path": str(local_dir.absolute()),
            "total_files": total_files,
            "downloaded_files": downloaded_files,
            "downloaded_dirs": downloaded_dirs,
            "failed_items": failed_items if failed_items else None,
        }

    except paramiko.AuthenticationException:
        return {"success": False, "error": "SSH 认证失败，请检查用户名和密码"}
    except paramiko.SSHException as e:
        return {"success": False, "error": f"SSH 连接错误: {str(e)}"}
    except socket.timeout:
        return {"success": False, "error": "SSH 连接超时"}
    except Exception as e:
        return {"success": False, "error": f"下载出错: {str(e)}"}
    finally:
        if sftp:
            sftp.close()
        if ssh:
            ssh.close()


def download_directory(host: str, port: int, username: str, password: str,
                       remote_path: str, local_path: str,
                       timeout: int = 30) -> Dict[str, Any]:
    """递归下载远程目录到本地，保持原有目录结构"""
    if not HAS_PARAMIKO:
        return {"success": False, "error": "paramiko 未安装，请运行: pip install paramiko"}

    local_dir = Path(local_path)
    local_dir.mkdir(parents=True, exist_ok=True)

    ssh = None
    sftp = None
    downloaded_files = 0
    downloaded_dirs = 0
    failed_items = []

    try:
        ssh = _ssh_connect(host, port, username, password, timeout)

        sftp = ssh.open_sftp()

        def _download_recursive(remote_dir: str, local_dir: str) -> None:
            nonlocal downloaded_files, downloaded_dirs

            try:
                items = sftp.listdir_attr(remote_dir)
            except IOError as e:
                failed_items.append({"path": remote_dir, "error": str(e)})
                return

            for item in items:
                remote_item = remote_dir + "/" + item.filename
                local_item = os.path.join(local_dir, item.filename)

                if item.st_mode & 0o40000:  # 目录
                    try:
                        os.makedirs(local_item, exist_ok=True)
                        downloaded_dirs += 1
                        _download_recursive(remote_item, local_item)
                    except OSError as e:
                        failed_items.append({"path": remote_item, "error": str(e)})
                else:  # 文件
                    try:
                        sftp.get(remote_item, local_item)
                        downloaded_files += 1
                    except IOError as e:
                        failed_items.append({"path": remote_item, "error": str(e)})

        _download_recursive(remote_path, str(local_dir))

        return {
            "success": True,
            "local_path": str(local_dir.absolute()),
            "downloaded_files": downloaded_files,
            "downloaded_dirs": downloaded_dirs,
            "failed_items": failed_items if failed_items else None,
        }

    except paramiko.AuthenticationException:
        return {"success": False, "error": "SSH 认证失败，请检查用户名和密码"}
    except paramiko.SSHException as e:
        return {"success": False, "error": f"SSH 连接错误: {str(e)}"}
    except socket.timeout:
        return {"success": False, "error": "SSH 连接超时"}
    except Exception as e:
        return {"success": False, "error": f"下载出错: {str(e)}"}
    finally:
        if sftp:
            sftp.close()
        if ssh:
            ssh.close()


def run_full_sync(config: Dict[str, Any] = None,
                  selected_paths: list = None,
                  task_id: str = None) -> Dict[str, Any]:
    """执行完整的同步检测流程

    流程：
    1. 检测本地公共知识库状态
    2. 检测服务器是否可达 + SSH 认证
    3. 若可达，从服务器下载（可指定 selected_paths 进行部分下载）

    若提供 task_id，则会实时更新同步进度供前端轮询。
    """
    if config is None:
        config = load_config()

    host = config.get("host", "")
    port = int(config.get("port", 22))
    username = config.get("username", "root")
    password = config.get("password", "")
    remote_path = config.get("remote_path", "")
    local_path = config.get("local_path", "")

    result = {
        "step": "start",
        "local_path": local_path,
        "remote_path": remote_path,
        "host": host,
    }

    if task_id:
        _set_sync_progress(task_id, status="running", message="正在检查本地知识库...")

    # Step 1: 检测本地公共知识库
    local_check = check_local_kb(local_path)
    result["local_check"] = local_check
    result["step"] = "local_check"

    # Step 2: 检测服务器是否可达
    if not host:
        result["status"] = "no_server_config"
        result["message"] = "未配置服务器 IP，无法同步"
        if task_id:
            _set_sync_progress(task_id, status="error", message=result["message"])
        return result

    if task_id:
        _set_sync_progress(task_id, status="running", message="正在检测服务器连接...")

    reachable = check_server_reachable(host, port)
    result["server_check"] = reachable
    result["step"] = "server_check"

    if not reachable["reachable"]:
        result["status"] = "server_unreachable"
        result["message"] = reachable.get("error", "服务器不可达")
        if task_id:
            _set_sync_progress(task_id, status="error", message=result["message"])
        return result

    # Step 3: 检测 SSH 认证
    auth = check_server_auth(host, port, username, password)
    result["auth_check"] = auth
    result["step"] = "auth_check"

    if not auth["authenticated"]:
        result["status"] = "auth_failed"
        result["message"] = auth.get("error", "SSH 认证失败")
        if task_id:
            _set_sync_progress(task_id, status="error", message=result["message"])
        return result

    # Step 4: 下载公共知识库（同一个 SSH 连接内先计数再下载）
    if task_id:
        _set_sync_progress(task_id, status="running", message="正在准备下载...")

    try:
        download = download_selected_items(host, port, username, password,
                                            remote_path, local_path,
                                            selected_paths=selected_paths,
                                            task_id=task_id)
    except Exception as e:
        download = {"success": False, "error": f"下载异常: {str(e)}"}

    result["download"] = download
    result["step"] = "download"

    # 将 total_files 透出到结果，方便前端读取
    if download.get("total_files"):
        result["total_files"] = download["total_files"]

    if download["success"]:
        result["status"] = "synced"
        dl_files = download.get("downloaded_files", 0)
        dl_dirs = download.get("downloaded_dirs", 0)
        result["message"] = (f"同步成功: 下载 {dl_files} 个文件, "
                             f"{dl_dirs} 个目录到 {local_path}")
        if task_id:
            _set_sync_progress(task_id, status="done", message=result["message"],
                               downloaded_files=dl_files)
    else:
        result["status"] = "download_failed"
        result["message"] = download.get("error", "下载失败")
        if task_id:
            _set_sync_progress(task_id, status="error", message=result["message"])

    return result


def download_single_file(host: str, port: int, username: str, password: str,
                         remote_file_path: str, local_file_path: str,
                         timeout: int = 30) -> Dict[str, Any]:
    """从服务器下载单个文件（供 main.js 的 SCP 加速使用）"""
    if not HAS_PARAMIKO:
        return {"success": False, "error": "paramiko 未安装"}

    ssh = None
    sftp = None
    try:
        ssh = _ssh_connect(host, port, username, password, timeout)
        sftp = ssh.open_sftp()

        local_dir = os.path.dirname(local_file_path)
        if local_dir:
            os.makedirs(local_dir, exist_ok=True)

        sftp.get(remote_file_path, local_file_path)

        file_size = os.path.getsize(local_file_path) if os.path.exists(local_file_path) else 0
        return {
            "success": True,
            "local_path": local_file_path,
            "file_size": file_size,
        }

    except paramiko.AuthenticationException:
        return {"success": False, "error": "SSH 认证失败"}
    except paramiko.SSHException as e:
        return {"success": False, "error": f"SSH 连接错误: {str(e)}"}
    except IOError as e:
        return {"success": False, "error": f"SFTP 文件传输错误: {str(e)}"}
    except Exception as e:
        return {"success": False, "error": f"下载失败: {str(e)}"}
    finally:
        if sftp:
            sftp.close()
        if ssh:
            ssh.close()
