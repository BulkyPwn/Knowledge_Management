"""
Agent 工具注册表与执行器
========================
每个 tool 是一个字典：
  {
    "name": "tool_name",
    "description": "...",
    "parameters": { ... JSON Schema ... },
    "execute": callable(args, context) -> str,
  }
"""

import json
import os
import requests
import traceback
from typing import Dict, Any, Callable, List, Optional


# ──────────────────────────────────────────────────────────────
#  平台 → 工具映射：用于根据启用的平台过滤工具
# ──────────────────────────────────────────────────────────────
PLATFORM_TOOL_MAP = {
    "local": ["knowledge_query"],
    "webSearch": ["web_search"],
    "webFetch": ["fetch_url"],
    "hiDesk": ["unified_search", "fusion_search"],
    "haiwen": ["unified_search"],
}

# 始终可用的工具（不受平台开关控制）
ALWAYS_AVAILABLE_TOOLS = {"get_available_sources", "list_projects", "knowledge_query", "fusion_search"}


class ToolRegistry:
    """工具注册表：注册、查询、执行 tool"""

    def __init__(self):
        self._tools: Dict[str, dict] = {}

    def register(self, name: str, description: str, parameters: dict, execute: Callable):
        """注册一个工具"""
        self._tools[name] = {
            "name": name,
            "description": description,
            "parameters": parameters,
            "execute": execute,
        }

    def list_tools(self, exclude: set = None) -> List[dict]:
        """返回所有工具的 OpenAI function calling 格式定义。
        
        Args:
            exclude: 需要排除的工具名称集合。若提供，则返回的工具不包含这些。
        """
        exclude = exclude or set()
        return [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["parameters"],
                },
            }
            for t in self._tools.values()
            if t["name"] not in exclude
        ]

    def list_tool_info(self) -> List[dict]:
        """返回工具信息（不含 execute 函数，用于 API 展示）"""
        return [
            {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            }
            for t in self._tools.values()
        ]

    def get_tool(self, name: str) -> Optional[dict]:
        return self._tools.get(name)

    def execute_tool(self, name: str, arguments: dict, context: dict = None) -> str:
        """执行指定工具，返回字符串结果"""
        tool = self._tools.get(name)
        if not tool:
            return json.dumps({"error": f"Unknown tool: {name}"}, ensure_ascii=False)
        try:
            result = tool["execute"](arguments, context or {})
            if isinstance(result, str):
                return result
            return json.dumps(result, ensure_ascii=False)
        except Exception as e:
            return json.dumps({
                "error": f"Tool '{name}' execution failed: {str(e)}",
                "traceback": traceback.format_exc()[-300:],
            }, ensure_ascii=False)


def get_disabled_tools(platforms: dict) -> set:
    """根据 platforms 开关，计算需要禁用的工具名称集合。
    
    逻辑：
    - 遍历 PLATFORM_TOOL_MAP，如果平台未启用，其关联工具加入禁用集合
    - 始终可用的工具（ALWAYS_AVAILABLE_TOOLS）不受影响
    - 若任一平台启用了 unified_search，则不禁用它
    """
    platforms = platforms if isinstance(platforms, dict) else {}
    disabled = set()

    for platform_key, tool_names in PLATFORM_TOOL_MAP.items():
        if not platforms.get(platform_key):
            for tn in tool_names:
                if tn not in ALWAYS_AVAILABLE_TOOLS:
                    disabled.add(tn)

    # 特殊处理 unified_search：只要有任一外部平台启用，就保留它
    any_external = any(
        platforms.get(k) for k in ("hiDesk", "haiwen")
    )
    if any_external:
        disabled.discard("unified_search")

    return disabled


def build_tool_registry(app_ref) -> ToolRegistry:
    """构建默认工具注册表。
    
    app_ref 是一个字典，包含 app.py 中已有的函数/对象引用：
      - client: LLMWikiClient 实例
      - safe_call_llm_wiki: 安全调用函数
      - load_llm_config: 加载 LLM 配置
      - build_chat_completions_url: 构建 chat URL
      - _get_current_project: 获取当前项目
      - _search_project: 搜索项目
      - _do_web_search: 网络搜索
      - _fetch_web_content: 抓取网页内容
      - write_log: 日志写入
      - _log: 控制台日志
    """
    registry = ToolRegistry()

    def _normalize_platforms(platforms: dict, ctx: dict = None) -> dict:
        ctx = ctx or {}
        platforms = platforms if isinstance(platforms, dict) else {}
        ctx_platforms = ctx.get("platforms") if isinstance(ctx.get("platforms"), dict) else {}
        merged = {
            "local": True,
            "hiDesk": False,
            "haiwen": False,
            "webSearch": False,
        }
        merged.update(ctx_platforms)
        merged.update(platforms)
        return merged

    def _source_catalog(platforms: dict = None, ctx: dict = None) -> List[dict]:
        enabled = _normalize_platforms(platforms or {}, ctx or {})
        return [
            {
                "id": "local",
                "name": "本地知识库",
                "tool": "knowledge_query",
                "enabled": bool(enabled.get("local")),
                "status": "available",
                "description": "搜索当前项目或指定 project_ids 下的 Wiki、文档和导入资料。",
            },
            {
                "id": "hiDesk",
                "name": "HiDesk",
                "tool": "unified_search",
                "enabled": bool(enabled.get("hiDesk")),
                "status": "reserved" if not bool(enabled.get("hiDesk")) else "pending_connector",
                "description": "企业服务台/工单知识来源。当前后端已有统一检索入口和预留适配器，真正检索取决于 HiDesk API 配置。",
            },
            {
                "id": "haiwen",
                "name": "海问思答",
                "tool": "unified_search",
                "enabled": bool(enabled.get("haiwen")),
                "status": "reserved" if not bool(enabled.get("haiwen")) else "pending_connector",
                "description": "海问思答平台来源。当前后端已有统一检索入口和预留适配器，真正检索取决于平台 API 配置。",
            },
            {
                "id": "webSearch",
                "name": "互联网搜索",
                "tool": "web_search",
                "enabled": bool(enabled.get("webSearch")),
                "status": "available",
                "description": "通过 DuckDuckGo、Bing 或 SearXNG 搜索公开互联网信息。",
            },
            {
                "id": "webFetch",
                "name": "网页抓取",
                "tool": "fetch_url",
                "enabled": True,
                "status": "available",
                "description": "读取指定 URL 的网页正文，用于深入分析单篇文章或文档。",
            },
            {
                "id": "model",
                "name": "模型内置知识",
                "tool": None,
                "enabled": True,
                "status": "available",
                "description": "语言模型训练阶段获得的通用知识；涉及最新事实时应优先使用可检索来源核验。",
            },
        ]

    # ── 1. 知识库查询 ──────────────────────────────────────────
    def _kb_query(args: dict, ctx: dict) -> str:
        """查询知识库内容，支持多 project 聚合搜索"""
        query = args.get("query", "")
        project_id = args.get("project_id")
        mode = args.get("mode", "normal")
        top_k = args.get("top_k", 5)

        if not query:
            return json.dumps({"error": "query is required"}, ensure_ascii=False)

        _search = app_ref["_search_project"]
        _get_proj = app_ref["_get_current_project"]

        # 决定要搜索的 project_ids 列表
        search_ids: List[str] = []
        if project_id:
            search_ids = [project_id]
        elif ctx.get("project_ids"):
            search_ids = list(ctx["project_ids"])
        else:
            project = _get_proj()
            if project:
                search_ids = [project.get("id", "")]

        if not search_ids:
            return json.dumps({"error": "No project available, please specify project_id"}, ensure_ascii=False)

        # 多 project 聚合：每个 project 各取 top_k 条，合并后按 score 排序取 top_k
        all_contexts = []
        all_sources = []
        seen_paths = set()
        for pid in search_ids:
            try:
                contexts, sources = _search(pid, query, mode)
                for c in contexts[:top_k]:
                    path_key = c.get("path", "")
                    if path_key not in seen_paths:
                        seen_paths.add(path_key)
                        c["_project_id"] = pid
                        all_contexts.append(c)
                for s in sources[:top_k]:
                    s_path = s.get("path", "")
                    if s_path not in {x.get("path") for x in all_sources}:
                        all_sources.append(s)
            except Exception as _e:
                continue

        # 按 score 排序（降序）
        all_contexts.sort(key=lambda x: x.get("score", 0), reverse=True)

        if not all_contexts:
            return json.dumps({
                "answer": "No relevant content found in knowledge base.",
                "sources": [],
                "count": 0,
                "projects_searched": search_ids,
            }, ensure_ascii=False)

        results = [
            {
                "index": c.get("index", i),
                "path": c["path"],
                "score": c.get("score", 0),
                "project_id": c.get("_project_id", ""),
                "content": c["content"][:500],  # 截断避免太长
            }
            for i, c in enumerate(all_contexts[:top_k])
        ]
        return json.dumps({
            "answer": f"Found {len(results)} relevant results from {len(search_ids)} project(s).",
            "results": results,
            "sources": all_sources[:top_k],
            "count": len(results),
            "projects_searched": search_ids,
        }, ensure_ascii=False)

    registry.register(
        name="knowledge_query",
        description="Search and query knowledge base content. Returns relevant wiki pages and their content. Supports searching across multiple projects simultaneously when context project_ids are provided.",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query / question about the knowledge base",
                },
                "project_id": {
                    "type": "string",
                    "description": "Project ID (optional, uses context project_ids or current project if omitted). Only specify to search a specific project.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["normal", "graph"],
                    "description": "Search mode: 'normal' for keyword search, 'graph' for graph-enhanced search",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of results to return (default 5)",
                },
            },
            "required": ["query"],
        },
        execute=_kb_query,
    )

    # ── 2. 网络搜索 ────────────────────────────────────────────
    def _web_search(args: dict, ctx: dict) -> str:
        """执行网络搜索"""
        query = args.get("query", "")
        max_results = args.get("max_results", 8)

        if not query:
            return json.dumps({"error": "query is required"}, ensure_ascii=False)

        _do_search = app_ref["_do_web_search"]
        results, engine, diagnostics = _do_search(query, max_results=max_results)

        return json.dumps({
            "engine": engine,
            "results": results,
            "count": len(results),
        }, ensure_ascii=False)

    registry.register(
        name="web_search",
        description="Search the internet using DuckDuckGo, Bing, or SearXNG. Returns titles, URLs, and snippets.",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query for the web",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results (default 8, max 30)",
                },
            },
            "required": ["query"],
        },
        execute=_web_search,
    )

    # ── 3. 获取网页内容 ────────────────────────────────────────
    def _fetch_url(args: dict, ctx: dict) -> str:
        """抓取网页内容"""
        url = args.get("url", "")
        if not url:
            return json.dumps({"error": "url is required"}, ensure_ascii=False)

        _fetch = app_ref.get("_fetch_web_content")
        if not _fetch:
            return json.dumps({"error": "fetch_web_content not available"}, ensure_ascii=False)

        try:
            content = _fetch(url)
            if isinstance(content, dict) and content.get("error"):
                return json.dumps(content, ensure_ascii=False)
            # 截断过长内容
            text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            if len(text) > 8000:
                text = text[:8000] + "\n... [truncated]"
            return json.dumps({
                "url": url,
                "content": text,
                "length": len(text),
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"error": f"Failed to fetch: {str(e)}"}, ensure_ascii=False)

    registry.register(
        name="fetch_url",
        description="Fetch and extract text content from a web page URL. Useful for reading articles, documentation, etc.",
        parameters={
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL of the web page to fetch",
                },
            },
            "required": ["url"],
        },
        execute=_fetch_url,
    )

    # ── 4. 列出知识库项目 ──────────────────────────────────────
    def _list_projects(args: dict, ctx: dict) -> str:
        """列出所有知识库项目"""
        _client = app_ref["client"]
        _safe_call = app_ref["safe_call_llm_wiki"]

        result = _safe_call(_client.list_projects)
        if result.get("ok") is False:
            return json.dumps({"error": result.get("error", "Failed to list projects")}, ensure_ascii=False)

        projects = result.get("projects", [])
        current = result.get("currentProject")
        return json.dumps({
            "projects": [
                {
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "path": p.get("path"),
                    "description": p.get("description", ""),
                }
                for p in projects
            ],
            "current_project": current,
            "count": len(projects),
        }, ensure_ascii=False)

    registry.register(
        name="list_projects",
        description="List all knowledge base projects with their IDs, names, and paths.",
        parameters={
            "type": "object",
            "properties": {},
        },
        execute=_list_projects,
    )

    # ── 5. 获取当前时间 ────────────────────────────────────────
    def _get_available_sources(args: dict, ctx: dict) -> str:
        """Return the data-source catalog visible to the assistant."""
        args = args or {}
        ctx = ctx or {}
        platforms = args.get("platforms") if isinstance(args, dict) else {}
        sources = _source_catalog(platforms, ctx)
        return json.dumps({
            "answer": "Available knowledge sources are returned in sources. Sources with status=pending_connector are known to the assistant but need backend connector/API configuration before real search results are available.",
            "sources": sources,
            "enabled_sources": [s for s in sources if s.get("enabled")],
            "count": len(sources),
        }, ensure_ascii=False)

    registry.register(
        name="get_available_sources",
        description="List the assistant's known knowledge sources and their current availability. Use this when the user asks what knowledge sources, platforms, or search channels you have, including HiDesk and 海问思答.",
        parameters={
            "type": "object",
            "properties": {
                "platforms": {
                    "type": "object",
                    "description": "Optional platform switches, e.g. {local:true, hiDesk:true, haiwen:false, webSearch:true}",
                    "additionalProperties": True,
                },
            },
        },
        execute=_get_available_sources,
    )

    def _unified_search(args: dict, ctx: dict) -> str:
        """Search selected enterprise/local/web sources through unified adapters."""
        args = args or {}
        ctx = ctx or {}
        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required"}, ensure_ascii=False)

        mode = args.get("mode") or ctx.get("search_mode") or "normal"
        platforms = _normalize_platforms(args.get("platforms"), ctx)
        project_ids = args.get("project_ids") or ctx.get("project_ids") or []
        domains = args.get("domains") or ctx.get("domains") or []

        adapters = []
        if platforms.get("local"):
            adapters.append(("local", lambda: app_ref["_search_platform_local"](query, project_ids)))
        if platforms.get("hiDesk"):
            adapters.append(("hiDesk", lambda: app_ref["_search_platform_hidesk"](query, domains)))
        if platforms.get("haiwen"):
            adapters.append(("haiwen", lambda: app_ref["_search_platform_haiwen"](query)))
        if platforms.get("webSearch"):
            adapters.append(("web", lambda: app_ref["_search_platform_web"](query)))

        all_results = []
        platforms_used = []
        quality_scores = {}

        for platform_name, search_fn in adapters:
            try:
                result = search_fn()
                all_results.append(result)
                platforms_used.append(platform_name)
                quality_scores[platform_name] = result.get("quality_score", 0)
                if mode != "deep" and result.get("quality_score", 0) >= 60:
                    break
            except Exception as e:
                all_results.append({
                    "results": [],
                    "sources": [],
                    "quality_score": 0,
                    "platform": platform_name,
                    "error": str(e),
                })

        build_context = app_ref.get("_build_unified_context")
        synthesize = app_ref.get("_llm_synthesize")
        context_text, unified_sources = ("", [])
        if build_context:
            context_text, unified_sources = build_context(all_results, deep_mode=(mode == "deep"))

        answer = ""
        if context_text and synthesize:
            answer = synthesize(query, context_text, unified_sources, mode)

        return json.dumps({
            "query": query,
            "answer": answer,
            "sources": unified_sources,
            "platforms_used": platforms_used,
            "quality_scores": quality_scores,
            "raw_results": all_results[:4],
            "source_catalog": _source_catalog(platforms, ctx),
            "mode": mode,
        }, ensure_ascii=False)

    registry.register(
        name="unified_search",
        description="Search selected sources with one call: local knowledge base, HiDesk, 海问思答, and internet search. Prefer this when the user selected multiple platforms or asks to search HiDesk/海问思答 together with other sources.",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query / user question"},
                "mode": {"type": "string", "enum": ["normal", "deep"], "description": "normal cascades sources; deep searches all enabled sources"},
                "platforms": {
                    "type": "object",
                    "description": "Platform switches: local, hiDesk, haiwen, webSearch",
                    "additionalProperties": True,
                },
                "project_ids": {"type": "array", "items": {"type": "string"}, "description": "Knowledge base project IDs"},
                "domains": {"type": "array", "items": {"type": "string"}, "description": "Relevant HiDesk domains/topics"},
            },
            "required": ["query"],
        },
        execute=_unified_search,
    )

    def _get_time(args: dict, ctx: dict) -> str:
        """获取当前时间"""
        from datetime import datetime
        now = datetime.now()
        return json.dumps({
            "datetime": now.isoformat(),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"),
            "weekday": now.strftime("%A"),
        }, ensure_ascii=False)

    registry.register(
        name="get_current_time",
        description="Get the current date and time.",
        parameters={
            "type": "object",
            "properties": {},
        },
        execute=_get_time,
    )

    # ── 6. 计算器 ──────────────────────────────────────────────
    def _calculator(args: dict, ctx: dict) -> str:
        """安全计算数学表达式"""
        expression = args.get("expression", "")
        if not expression:
            return json.dumps({"error": "expression is required"}, ensure_ascii=False)
        try:
            # 安全计算：仅允许基本数学运算
            allowed = set("0123456789+-*/().% ")
            if not all(c in allowed for c in expression):
                return json.dumps({"error": "Expression contains disallowed characters"}, ensure_ascii=False)
            result = eval(expression, {"__builtins__": {}}, {})
            return json.dumps({
                "expression": expression,
                "result": result,
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"error": f"Calculation failed: {str(e)}"}, ensure_ascii=False)

    registry.register(
        name="calculator",
        description="Evaluate a mathematical expression safely. Supports +, -, *, /, %, parentheses.",
        parameters={
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "Mathematical expression to evaluate, e.g. '(1 + 2) * 3'",
                },
            },
            "required": ["expression"],
        },
        execute=_calculator,
    )

    # ── 7. 多源融合检索（LlamaIndex + LangGraph）──────────────────
    def _fusion_search(args: dict, ctx: dict) -> str:
        """LangGraph 多源融合检索：并行搜索本地 Wiki（LlamaIndex）、知识图谱（GraphRAG）、HiDesk、Web"""
        import time as _time
        _t_total_start = _time.time()

        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required"}, ensure_ascii=False)

        try:
            # 延迟导入，避免循环依赖
            import sys as _sys
            _kb_mgmt_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            if _kb_mgmt_path not in _sys.path:
                _sys.path.insert(0, _kb_mgmt_path)

            from langgraph_fusion.state import FusionSearchState
            from langgraph_fusion.config import build_fusion_config
            from langgraph_fusion.graph import (
                build_fusion_search_graph, create_sqlite_checkpointer,
                run_fusion_search, set_write_log,
            )
            from langgraph_fusion.adapters.embedding_adapter import EmbeddingFactory
            from langgraph_fusion.adapters.vector_store_adapter import ChromaDBAdapter
            from langgraph_fusion.adapters.neo4j_adapter import Neo4jAdapter
            from langgraph_fusion.adapters.hidesk_adapter import HiDeskAdapter
            from langgraph_fusion.nodes.llama_index_retriever import set_index_registry
            from langgraph_fusion.nodes.graph_rag_retriever import set_neo4j_adapter
            from langgraph_fusion.nodes.hidesk_retriever import set_hidesk_adapter
            from langgraph_fusion.nodes.web_retriever import set_web_search_fn
            from llama_index.index_registry import IndexRegistry

            import uuid

            # ── 获取配置 ──
            app_ref = ctx.get("_app_refs", {})
            load_llm_cfg = app_ref.get("load_llm_config") or (lambda: {})
            llm_config = load_llm_cfg()
            get_data_dir = app_ref.get("_get_data_dir") or (
                lambda: os.path.join(os.path.expanduser("~"), ".SSSC_AI", "config")
            )

            get_wiki_dir = app_ref.get("_get_wiki_dir")
            get_raw_dir = app_ref.get("_get_raw_dir")

            wiki_dir = get_wiki_dir() if get_wiki_dir else ""
            raw_dir = get_raw_dir() if get_raw_dir else ""
            data_dir = get_data_dir()

            if not wiki_dir:
                return json.dumps({
                    "error": "No active wiki project. Please open a knowledge base first.",
                }, ensure_ascii=False)

            # ── 注入日志回调 ──
            write_log_fn = app_ref.get("write_log")

            # 包装 write_log 以同时写入 trace ringbuffer
            def _wrapped_write_log(event_type, data, level="info"):
                # 先写入 trace
                try:
                    import trace_recorder
                    trace_recorder.record(event_type, data, level)
                except Exception:
                    pass
                # 再调用原有回调
                if write_log_fn:
                    try:
                        write_log_fn(event_type, data, level=level)
                    except Exception:
                        pass

            set_write_log(_wrapped_write_log)

            # ── 构建配置 ──
            source_overrides = {}
            platforms = ctx.get("platforms", {})
            if isinstance(platforms, dict):
                source_overrides["graph_rag"] = platforms.get("graph_rag", False)
                source_overrides["hidesk"] = platforms.get("hidesk", False)
                source_overrides["web"] = platforms.get("webSearch", False)

            _t_config_start = _time.time()
            config = build_fusion_config(
                wiki_dir=wiki_dir,
                raw_dir=raw_dir,
                data_dir=data_dir,
                project_ids=ctx.get("project_ids", []),
                llm_config=llm_config,
                enabled_sources=source_overrides,
            )
            _t_config_elapsed = _time.time() - _t_config_start

            # ── 初始化适配器 ──
            _t_adapter_start = _time.time()

            chroma = ChromaDBAdapter(config.get("chroma_persist_dir", ""))
            embed_factory = EmbeddingFactory(llm_config)

            registry = IndexRegistry(chroma, embed_factory)
            index_loaded = 0
            try:
                registry.reload_all()
                index_loaded = len(registry.list_index_names())
            except Exception:
                pass
            set_index_registry(registry)

            graph_rag_ok = False
            if source_overrides.get("graph_rag"):
                try:
                    neo4j = Neo4jAdapter(
                        uri=config.get("neo4j_uri", "bolt://localhost:7687"),
                        user=config.get("neo4j_user", "neo4j"),
                        password=config.get("neo4j_password", "password"),
                    )
                    if neo4j.is_connected():
                        set_neo4j_adapter(neo4j)
                        graph_rag_ok = True
                except Exception:
                    pass

            hidesk_ok = False
            if source_overrides.get("hidesk"):
                hidesk_base = ctx.get("hidesk_base_url", "")
                hidesk_kb_sn = ctx.get("hidesk_kb_sn", "")
                if hidesk_base:
                    hidesk_adapter = HiDeskAdapter(base_url=hidesk_base, kb_sn=hidesk_kb_sn)
                    set_hidesk_adapter(hidesk_adapter)
                    hidesk_ok = True

            web_ok = False
            if source_overrides.get("web"):
                web_fn = app_ref.get("_search_platform_web")
                if web_fn:
                    set_web_search_fn(web_fn)
                    web_ok = True

            _t_adapter_elapsed = _time.time() - _t_adapter_start

            # ── 初始化 LangGraph ──
            _t_graph_start = _time.time()
            checkpoint_path = config.get("checkpoint_db_path", "")
            checkpointer = create_sqlite_checkpointer(checkpoint_path) if checkpoint_path else None
            graph = build_fusion_search_graph(checkpointer=checkpointer)
            _t_graph_elapsed = _time.time() - _t_graph_start

            # ── 日志：初始化完成 ──
            if write_log_fn:
                write_log_fn("fusion_search_init", {
                    "query": query[:200],
                    "wiki_dir": wiki_dir,
                    "llm_model": llm_config.get("llm_model", ""),
                    "embedding_model": llm_config.get("llm_embedding_model", ""),
                    "sources": {k: v for k, v in [
                        ("llama_index", index_loaded > 0),
                        ("graph_rag", graph_rag_ok),
                        ("hidesk", hidesk_ok),
                        ("web", web_ok),
                    ]},
                    "checkpointer": bool(checkpointer),
                    "index_count": index_loaded,
                    "init_timings": {
                        "config": f"{_t_config_elapsed:.2f}s",
                        "adapters": f"{_t_adapter_elapsed:.2f}s",
                        "graph": f"{_t_graph_elapsed:.2f}s",
                    },
                })

            # ── 构建初始状态 ──
            state: FusionSearchState = {
                "user_query": query,
                "config": config,
                "retry_count": 0,
            }

            # ── 执行融合检索 ──
            thread_id = ctx.get("thread_id", str(uuid.uuid4()))
            result = run_fusion_search(graph, state, thread_id=thread_id)

            _t_total = _time.time() - _t_total_start
            if write_log_fn:
                write_log_fn("fusion_search_result", {
                    "answer_length": len(result.get("final_answer", "")),
                    "sources_count": len(result.get("final_sources", [])),
                    "quality_score": result.get("quality_score", 0),
                    "total_time": f"{_t_total:.2f}s",
                    "error": result.get("error"),
                })

            return json.dumps({
                "answer": result.get("final_answer", ""),
                "sources": result.get("final_sources", []),
                "quality_score": result.get("quality_score", 0),
                "error": result.get("error"),
            }, ensure_ascii=False)

        except ImportError as e:
            return json.dumps({
                "error": f"Fusion search module not available: {str(e)}. "
                         "Please install dependencies: llama-index, chromadb, langgraph",
            }, ensure_ascii=False)
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            if write_log_fn:
                try:
                    write_log_fn("fusion_search_error", {
                        "error": str(e),
                        "traceback": tb[-500:],
                    }, level="error")
                except Exception:
                    pass
            return json.dumps({
                "error": f"Fusion search failed: {str(e)}",
                "traceback": tb[-500:],
            }, ensure_ascii=False)

    registry.register(
        name="fusion_search",
        description=(
            "Multi-source fusion search with LlamaIndex + LangGraph. "
            "Searches local Wiki (LlamaIndex vector index), knowledge graph (Neo4j GraphRAG), "
            "HiDesk enterprise knowledge base, and web search in parallel. "
            "Uses RRF fusion + LLM reranker for precision ranking. "
            "Automatically retries with rewritten query if quality is insufficient."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query / user question",
                },
            },
            "required": ["query"],
        },
        execute=_fusion_search,
    )

    return registry
