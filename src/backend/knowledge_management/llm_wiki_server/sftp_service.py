"""
轻量 SFTP + 文件系统服务
独立于 KMA Server (5002)，运行在端口 5003。
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import json
import sys
import subprocess
import string as _string_ascii
from pathlib import Path
from datetime import datetime
import logging

# 确保 knowledge_management 父目录在 sys.path 中
_LOCAL_DIR = str(Path(__file__).resolve().parent)
_kb_mgmt_path = str(Path(__file__).resolve().parent.parent)
if _kb_mgmt_path not in sys.path:
    sys.path.insert(0, _kb_mgmt_path)

# 仅导入 SFTP 相关函数，不依赖 LLM Wiki
from common_kb_sync import download_single_file, HAS_PARAMIKO

app = Flask(__name__)
CORS(app)

# 设置日志格式
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
_logger = logging.getLogger("sftp-service")

# 禁用 Werkzeug 正常 200 请求日志，仅打印非 200 状态
_werkzeug_logger = logging.getLogger('werkzeug')
class _Non200Filter(logging.Filter):
    def filter(self, record):
        return '" 200 ' not in record.getMessage()
_werkzeug_logger.addFilter(_Non200Filter())


def _get_logs_dir():
    p = os.path.join(_LOCAL_DIR, "logs")
    os.makedirs(p, exist_ok=True)
    return p


def write_log(action: str, details):
    log_file = os.path.join(_get_logs_dir(), f"{datetime.now().strftime('%Y-%m-%d')}.log")
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "action": action,
        "details": details,
    }
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")


_pid_file = os.path.join(_LOCAL_DIR, "sftp_service.pid")


# ============================================================
#  SFTP 单文件下载
# ============================================================

@app.route("/api/v1/sftp/download-file", methods=["POST"])
def sftp_download_file():
    """通过 SFTP 从服务器下载单个文件"""
    if not HAS_PARAMIKO:
        return jsonify({"success": False, "error": "paramiko 未安装"}), 500

    data = request.get_json() or {}
    host = data.get("host", "")
    port = int(data.get("port", 22))
    username = data.get("username", "root")
    password = data.get("password", "")
    remote_file_path = data.get("remote_file_path", "")
    local_file_path = data.get("local_file_path", "")

    if not host or not remote_file_path or not local_file_path:
        return jsonify({"success": False, "error": "缺少必要参数: host, remote_file_path, local_file_path"}), 400

    write_log("sftp_download_file", {"host": host, "remote": remote_file_path})
    result = download_single_file(host, port, username, password,
                                  remote_file_path, local_file_path)
    return jsonify(result)


# ============================================================
#  文件系统浏览
# ============================================================

@app.route("/api/v1/filesystem/list", methods=["GET"])
def list_filesystem():
    path = request.args.get("path", "")
    if not path and os.name == "nt":
        drives = []
        for letter in _string_ascii.ascii_uppercase:
            d = f"{letter}:\\"
            if os.path.exists(d):
                norm = f"{letter}:/"
                drives.append({"name": f"{letter}:/", "path": norm, "is_dir": True})
        return jsonify({"success": True, "data": {"path": "", "entries": drives}})

    if not path:
        path = os.path.expanduser("~")

    target = os.path.abspath(os.path.expanduser(path))
    if not os.path.exists(target):
        return jsonify({"success": False, "message": f"Path not found: {path}"}), 404
    if not os.path.isdir(target):
        return jsonify({"success": False, "message": f"Not a directory: {path}"}), 400

    parent = os.path.dirname(target).replace("\\", "/")
    entries = [{"name": "..", "path": parent, "is_dir": True, "is_parent": True}]

    try:
        items = sorted(os.listdir(target), key=lambda x: (not os.path.isdir(os.path.join(target, x)), x.lower()))
        for item in items:
            item_path = os.path.join(target, item)
            entries.append({
                "name": item,
                "path": item_path.replace("\\", "/"),
                "is_dir": os.path.isdir(item_path),
                "is_parent": False,
            })
    except PermissionError:
        return jsonify({"success": False, "message": f"Permission denied: {path}"}), 403

    return jsonify({"success": True, "data": {"path": target.replace("\\", "/"), "entries": entries}})


@app.route("/api/v1/browse", methods=["GET"])
def browse_directory_listing():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"success": False, "message": "path is required"}), 400
    target = os.path.abspath(path)
    if not os.path.isdir(target):
        return jsonify({"success": False, "message": f"Not a directory: {path}"}), 400
    try:
        items = sorted(os.listdir(target), key=lambda x: (not os.path.isdir(os.path.join(target, x)), x.lower()))
        entries = []
        for item in items:
            item_path = os.path.join(target, item)
            entries.append({
                "name": item,
                "path": item_path.replace("\\", "/"),
                "is_dir": os.path.isdir(item_path),
            })
        return jsonify({"success": True, "data": {"path": target.replace("\\", "/"), "entries": entries}})
    except PermissionError:
        return jsonify({"success": False, "message": f"Permission denied: {path}"}), 403


@app.route("/api/v1/browse-directory", methods=["POST"])
def browse_directory():
    try:
        ps_script = r"""
Add-Type -AssemblyName System.Windows.Forms
$fbd = New-Object System.Windows.Forms.FolderBrowserDialog
$fbd.Description = 'Select Folder'
$fbd.ShowNewFolderButton = $true
$result = $fbd.ShowDialog()
if ($result -eq 'OK') { Write-Output $fbd.SelectedPath }
"""
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True, 
            encoding="utf-8", 
            errors="replace",
            timeout=60,
        )
        path = proc.stdout.strip()
        if path and os.path.exists(path):
            return jsonify({"success": True, "data": {"path": path}})
        return jsonify({"success": False, "message": "No folder selected"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/v1/browse-file", methods=["POST"])
def browse_file():
    try:
        ps_script = r"""
Add-Type -AssemblyName System.Windows.Forms
$ofd = New-Object System.Windows.Forms.OpenFileDialog
$ofd.Filter = 'All Files (*.*)|*.*|Markdown (*.md)|*.md|Text Files (*.txt)|*.txt|PDF (*.pdf)|*.pdf'
$ofd.FilterIndex = 1
$ofd.Title = 'Select File'
$result = $ofd.ShowDialog()
if ($result -eq 'OK') { Write-Output $ofd.FileName }
"""
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True, 
            encoding="utf-8", 
            errors="replace",
            timeout=60,
        )
        path = proc.stdout.strip()
        if path and os.path.exists(path):
            return jsonify({"success": True, "data": {"path": path}})
        return jsonify({"success": False, "message": "No file selected"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("SFTP_SERVICE_PORT", 5003))
    with open(_pid_file, "w") as f:
        f.write(str(os.getpid()))
    _logger.info("SFTP 服务启动，端口: %s, PID: %s", port, os.getpid())
    app.run(debug=False, host="0.0.0.0", port=port)
