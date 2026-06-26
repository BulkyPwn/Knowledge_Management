import os
import json
import sys
import time
import logging
import traceback
import argparse
import requests
from typing import Optional
from mcp.server.fastmcp import FastMCP

# ---- Logging Setup ----
LOG_LEVEL = os.environ.get("MCP_LOG_LEVEL", "INFO").upper()
_log_format = logging.Formatter(
    "[%(asctime)s] [%(levelname)-5s] [mcp-server] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_log_handler = logging.StreamHandler(sys.stderr)
_log_handler.setFormatter(_log_format)

logger = logging.getLogger("mcp-server")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
logger.addHandler(_log_handler)
logger.propagate = False

# ---- Internal Diagnostics State ----
_START_TIME = time.time()
_request_stats = {"total": 0, "success": 0, "error": 0}
_last_error = None  # (timestamp, error_message)
_last_request = None  # (timestamp, method, path, status)

LLM_WIKI_SERVER_URL = os.environ.get("LLM_WIKI_SERVER_URL", "http://127.0.0.1:5002")

_DEFAULT_PORTS = {
    "stdio": 9010,
    "streamable-http": 9011,
    "sse": 9012,
}

mcp = FastMCP(
    name="KMA MCP Server",
    instructions="MCP Server for KMA knowledge management — access projects, wiki pages, search, and knowledge graphs.",
    stateless_http=True,
)


def _record_request(method: str, path: str, success: bool):
    """Record request stats for diagnostics."""
    global _request_stats, _last_request, _last_error
    _request_stats["total"] += 1
    if success:
        _request_stats["success"] += 1
    else:
        _request_stats["error"] += 1
    _last_request = (time.time(), method, path, "ok" if success else "error")


def _record_error(error_message: str):
    """Record last error for diagnostics."""
    global _last_error
    _last_error = (time.time(), error_message)


def _api_get(path: str, params: Optional[dict] = None, timeout: int = 30) -> dict:
    url = f"{LLM_WIKI_SERVER_URL}{path}"
    start = time.time()
    logger.debug("GET %s params=%s", url, params)
    try:
        resp = requests.get(url, params=params, timeout=timeout)
        elapsed = time.time() - start
        logger.info("GET %s -> %s (%.2fms)", resp.url, resp.status_code, elapsed * 1000)
        resp.raise_for_status()
        _record_request("GET", path, True)
        return resp.json()
    except Exception:
        elapsed = time.time() - start
        logger.error("GET %s FAILED after %.2fms\n%s", url, elapsed * 1000, traceback.format_exc())
        _record_request("GET", path, False)
        raise


def _api_post(path: str, body: Optional[dict] = None, timeout: int = 30) -> dict:
    url = f"{LLM_WIKI_SERVER_URL}{path}"
    start = time.time()
    logger.debug("POST %s body=%s", url, json.dumps(body or {}, ensure_ascii=False)[:200])
    try:
        resp = requests.post(url, json=body or {}, timeout=timeout)
        elapsed = time.time() - start
        logger.info("POST %s -> %s (%.2fms)", resp.url, resp.status_code, elapsed * 1000)
        resp.raise_for_status()
        _record_request("POST", path, True)
        return resp.json()
    except Exception:
        elapsed = time.time() - start
        logger.error("POST %s FAILED after %.2fms\n%s", url, elapsed * 1000, traceback.format_exc())
        _record_request("POST", path, False)
        raise


def _api_put(path: str, body: Optional[dict] = None, timeout: int = 30) -> dict:
    url = f"{LLM_WIKI_SERVER_URL}{path}"
    start = time.time()
    logger.debug("PUT %s body=%s", url, json.dumps(body or {}, ensure_ascii=False)[:200])
    try:
        resp = requests.put(url, json=body or {}, timeout=timeout)
        elapsed = time.time() - start
        logger.info("PUT %s -> %s (%.2fms)", resp.url, resp.status_code, elapsed * 1000)
        resp.raise_for_status()
        _record_request("PUT", path, True)
        return resp.json()
    except Exception:
        elapsed = time.time() - start
        logger.error("PUT %s FAILED after %.2fms\n%s", url, elapsed * 1000, traceback.format_exc())
        _record_request("PUT", path, False)
        raise


def _api_delete(path: str, timeout: int = 30) -> dict:
    url = f"{LLM_WIKI_SERVER_URL}{path}"
    start = time.time()
    logger.debug("DELETE %s", url)
    try:
        resp = requests.delete(url, timeout=timeout)
        elapsed = time.time() - start
        logger.info("DELETE %s -> %s (%.2fms)", resp.url, resp.status_code, elapsed * 1000)
        resp.raise_for_status()
        _record_request("DELETE", path, True)
        return resp.json()
    except Exception:
        elapsed = time.time() - start
        logger.error("DELETE %s FAILED after %.2fms\n%s", url, elapsed * 1000, traceback.format_exc())
        _record_request("DELETE", path, False)
        raise


def _ok(data: dict, message: str = "success") -> str:
    return json.dumps({"ok": True, "message": message, "data": data}, ensure_ascii=False)


def _err(message: str) -> str:
    return json.dumps({"ok": False, "error": message}, ensure_ascii=False)


# ============================================================
#  Server tools
# ============================================================


# ============================================================
#  Diagnostics tool — MCP self-health
# ============================================================

@mcp.tool(description="Get the internal health and diagnostics of the MCP server itself")
def get_mcp_health() -> str:
    """Report MCP server internal diagnostics: uptime, request stats, last error."""
    uptime_sec = time.time() - _START_TIME
    last_err_info = None
    if _last_error:
        last_err_info = {
            "time": _last_error[0],
            "elapsed_sec": _last_error[0] - _START_TIME,
            "message": _last_error[1],
        }
    last_req_info = None
    if _last_request:
        last_req_info = {
            "time": _last_request[0],
            "method": _last_request[1],
            "path": _last_request[2],
            "status": _last_request[3],
        }
    return _ok({
        "uptime_seconds": round(uptime_sec, 2),
        "uptime_human": f"{int(uptime_sec // 3600)}h {int((uptime_sec % 3600) // 60)}m {int(uptime_sec % 60)}s",
        "backend_url": LLM_WIKI_SERVER_URL,
        "python_version": sys.version,
        "log_level": LOG_LEVEL,
        "request_stats": dict(_request_stats),
        "last_request": last_req_info,
        "last_error": last_err_info,
    })


# ============================================================
#  Server tools
# ============================================================


@mcp.tool(description="Check the health and configuration of the KMA server")
def get_server_health() -> str:
    try:
        result = _api_get("/api/v1/server/health")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Get the KMA server schema configuration")
def get_server_schema() -> str:
    try:
        result = _api_get("/api/v1/server/schema")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Project tools
# ============================================================


@mcp.tool(description="List all available KMA projects")
def list_projects() -> str:
    try:
        result = _api_get("/api/v1/projects")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Get an overview and statistics for a specific project")
def get_project_overview(project_id: str) -> str:
    try:
        result = _api_get(f"/api/v1/projects/{project_id}/overview")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="List files in a project. root can be 'wiki', 'sources', or 'all'")
def list_project_files(
    project_id: str,
    root: str = "wiki",
    recursive: bool = True,
    max_files: int = 2000,
) -> str:
    try:
        result = _api_get(
            f"/api/v1/projects/{project_id}/files",
            params={
                "root": root,
                "recursive": str(recursive).lower(),
                "maxFiles": max_files,
            },
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Read the content of a file in a project by path")
def get_file_content(project_id: str, path: str) -> str:
    try:
        result = _api_get(
            f"/api/v1/projects/{project_id}/files/content",
            params={"path": path},
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Search tools
# ============================================================


@mcp.tool(description="Search for content within a specific project using semantic or keyword search")
def search_project(
    project_id: str,
    query: str,
    top_k: int = 10,
    include_content: bool = False,
) -> str:
    try:
        result = _api_post(
            f"/api/v1/projects/{project_id}/search",
            body={
                "query": query,
                "topK": top_k,
                "includeContent": include_content,
            },
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Search for content across ALL available projects")
def search_all_projects(query: str, top_k: int = 10) -> str:
    try:
        result = _api_post(
            "/api/v1/search",
            body={"query": query, "topK": top_k},
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Graph tools
# ============================================================


@mcp.tool(description="Get the knowledge graph for a project showing nodes and edges")
def get_project_graph(
    project_id: str,
    q: Optional[str] = None,
    node_type: Optional[str] = None,
    limit: int = 200,
) -> str:
    try:
        params: dict = {"limit": limit}
        if q:
            params["q"] = q
        if node_type:
            params["nodeType"] = node_type
        result = _api_get(f"/api/v1/projects/{project_id}/graph", params=params)
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Wiki page tools (local server wiki)
# ============================================================


@mcp.tool(description="List all wiki pages managed by the KMA server")
def list_wiki_pages() -> str:
    try:
        result = _api_get("/api/v1/wiki/pages")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Get the full content and metadata of a specific wiki page by title")
def get_wiki_page(title: str) -> str:
    try:
        result = _api_get(f"/api/v1/wiki/page/{title}")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Create a new wiki page with a title and markdown content")
def create_wiki_page(title: str, content: str) -> str:
    try:
        result = _api_post(
            "/api/v1/wiki/page",
            body={"title": title, "content": content},
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Update an existing wiki page's content by title")
def update_wiki_page(title: str, content: str) -> str:
    try:
        result = _api_put(
            f"/api/v1/wiki/page/{title}",
            body={"content": content},
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Delete a wiki page by title")
def delete_wiki_page(title: str) -> str:
    try:
        result = _api_delete(f"/api/v1/wiki/page/{title}")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Wiki utility tools
# ============================================================


@mcp.tool(description="Run lint checks on the wiki to find orphan pages, weak links, and outdated pages")
def lint_wiki() -> str:
    try:
        result = _api_get("/api/v1/wiki/lint")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Search wiki pages by keyword in titles and content")
def search_wiki(query: str) -> str:
    try:
        result = _api_get("/api/v1/wiki/search", params={"q": query})
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Get the local wiki knowledge graph showing page nodes and link edges")
def get_wiki_graph() -> str:
    try:
        result = _api_get("/api/v1/wiki/graph")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Project wiki tools (operate on project-specific wiki via project id)
# ============================================================


@mcp.tool(description="List wiki pages within a specific project by project ID")
def list_project_wiki_pages(project_id: str) -> str:
    try:
        result = _api_get(f"/api/v1/projects/{project_id}/wiki/pages")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Get a wiki page from a specific project by project ID and page title")
def get_project_wiki_page(project_id: str, title: str) -> str:
    try:
        result = _api_get(f"/api/v1/projects/{project_id}/wiki/page/{title}")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Update a wiki page within a specific project")
def update_project_wiki_page(project_id: str, title: str, content: str) -> str:
    try:
        result = _api_put(
            f"/api/v1/projects/{project_id}/wiki/page/{title}",
            body={"content": content},
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Delete a wiki page from a specific project")
def delete_project_wiki_page(project_id: str, title: str) -> str:
    try:
        result = _api_delete(
            f"/api/v1/projects/{project_id}/wiki/page/{title}"
        )
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


@mcp.tool(description="Get the knowledge graph of a specific project's wiki")
def get_project_wiki_graph(project_id: str) -> str:
    try:
        result = _api_get(f"/api/v1/projects/{project_id}/wiki/graph")
        return _ok(result)
    except Exception as e:
        _record_error(str(e))
        return _err(str(e))


# ============================================================
#  Resources — expose wiki pages and schema as URI resources
# ============================================================


@mcp.resource("wiki://index")
def resource_list_pages() -> str:
    try:
        result = _api_get("/api/v1/wiki/pages")
        data = result.get("data", [])
        lines = ["# Wiki Pages", ""]
        for page in data:
            title = page.get("title", "unknown")
            page_type = page.get("page_type", "other")
            tags = ", ".join(page.get("tags", []))
            lines.append(f"- **{title}**  [{page_type}]  {tags}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


@mcp.resource("wiki://page/{title}")
def resource_wiki_page(title: str) -> str:
    try:
        result = _api_get(f"/api/v1/wiki/page/{title}")
        data = result.get("data", {})
        return data.get("content", f"Page '{title}' has no content")
    except Exception as e:
        return f"Error: {e}"


@mcp.resource("wiki://schema")
def resource_schema() -> str:
    try:
        result = _api_get("/api/v1/server/schema")
        return json.dumps(result.get("data", {}), ensure_ascii=False, indent=2)
    except Exception as e:
        return f"Error: {e}"


@mcp.resource("wiki://graph")
def resource_wiki_graph() -> str:
    try:
        result = _api_get("/api/v1/wiki/graph")
        data = result.get("data", {})
        nodes = data.get("nodes", [])
        edges = data.get("edges", [])
        lines = [f"# Wiki Graph ({len(nodes)} nodes, {len(edges)} edges)", ""]
        lines.append("## Nodes")
        for node in nodes:
            lines.append(f"- [{node.get('node_type', '?')}] {node.get('label', node.get('id', '?'))}")
        lines.append("")
        lines.append("## Edges")
        for edge in edges:
            lines.append(f"- {edge.get('source', '?')} -> {edge.get('target', '?')}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


def _check_dependencies(transport: str, host: str, port: int):
    missing = []
    try:
        import mcp  # noqa: F401
    except ImportError:
        missing.append("mcp")
    try:
        import requests  # noqa: F401
    except ImportError:
        missing.append("requests")
    if missing:
        logger.critical("FATAL: Missing dependencies: %s", ", ".join(missing))
        logger.critical("Run: pip install mcp requests")
        sys.exit(1)
    logger.info("Starting (API backend: %s)", LLM_WIKI_SERVER_URL)
    logger.info("Transport: %s", transport)
    if transport in ("sse", "streamable-http"):
        logger.info("Listening on: http://%s:%s", host, port)
    logger.info("Python: %s", sys.executable)
    logger.info("Log level: %s", LOG_LEVEL)


def parse_args():
    VALID_TRANSPORTS = ("stdio", "sse", "streamable-http")
    parser = argparse.ArgumentParser(description="KMA MCP Server")
    parser.add_argument(
        "--transport", "-t",
        choices=VALID_TRANSPORTS,
        default="stdio",
        help="Transport protocol (default: stdio)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind for SSE/HTTP modes (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=None,
        help=f"Port to bind (defaults: stdio={_DEFAULT_PORTS['stdio']}, "
             f"streamable-http={_DEFAULT_PORTS['streamable-http']}, "
             f"sse={_DEFAULT_PORTS['sse']})",
    )
    args = parser.parse_args()
    if args.port is None:
        args.port = _DEFAULT_PORTS[args.transport]
    return args


if __name__ == "__main__":
    args = parse_args()
    _check_dependencies(args.transport, args.host, args.port)
    mcp.settings.host = args.host
    mcp.settings.port = args.port
    mcp.run(transport=args.transport)
