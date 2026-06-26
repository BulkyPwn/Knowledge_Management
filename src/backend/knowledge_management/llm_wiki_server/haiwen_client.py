"""
海问思答平台集成
=================
提供 W3 登录、海问 Token 获取、MCP 会话初始化和文档搜索功能。
"""

import json
import re
import logging
import httpx
from typing import Optional, Dict, Any


# 海问思答相关 URL
W3_LOGIN_URL = "https://login.huawei.com/login1/rest/hwidcenter/login"
HIWEN_AUTH_URL = "https://hiwen.huawei.com/auth/login?sysid="
MCP_URL = "http://laplace-uat.agents.hisi.huawei.com/mcp"
HIWEN_REFERER = "https://hiwen.huawei.com/"


class HaiwenClient:
    """海问思答客户端，管理登录状态和文档搜索。"""

    def __init__(self, cookie_file: str = ""):
        self._cookie_str: Optional[str] = None
        self._token: Optional[str] = None
        self._mcp_session_id: Optional[str] = None
        self._cookie_file = cookie_file or self._default_cookie_file()
        self._load_cookie()

    @staticmethod
    def _default_cookie_file() -> str:
        import os
        return os.path.join(os.path.expanduser("~"), ".SSSC_AI", "haiwen_cookie.json")

    def _load_cookie(self):
        """从文件加载缓存的 cookie。"""
        try:
            import os
            if os.path.exists(self._cookie_file):
                with open(self._cookie_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._cookie_str = data.get("cookie_str")
                self._token = data.get("token")
                self._mcp_session_id = data.get("mcp_session_id")
        except Exception:
            pass

    def _save_cookie(self):
        """保存 cookie 到文件（不保存账号密码）。"""
        try:
            import os
            os.makedirs(os.path.dirname(self._cookie_file), exist_ok=True)
            with open(self._cookie_file, "w", encoding="utf-8") as f:
                json.dump({
                    "cookie_str": self._cookie_str,
                    "token": self._token,
                    "mcp_session_id": self._mcp_session_id,
                }, f, ensure_ascii=False)
        except Exception:
            pass

    def clear_credentials(self):
        """清除所有凭证（包括缓存文件）。"""
        self._cookie_str = None
        self._token = None
        self._mcp_session_id = None
        try:
            import os
            if os.path.exists(self._cookie_file):
                os.remove(self._cookie_file)
        except Exception:
            pass

    @property
    def is_authenticated(self) -> bool:
        return bool(self._cookie_str and self._token)

    async def login(self, username: str, password: str) -> Dict[str, Any]:
        """
        执行登录流程：
        1. W3 登录获取 cookie
        2. 获取海问 Token
        """
        # 步骤 1: W3 登录
        w3_headers = {
            "Content-Type": "application/json",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/144.0.0.0 Safari/537.36"
            )
        }
        w3_payload = {
            "lang": "zh_CN",
            "loginAccount": username,
            "password": password,
            "uid": username,
        }
        async with httpx.AsyncClient(timeout=30, verify=False, trust_env=False, follow_redirects=True) as client:
            resp = await client.post(W3_LOGIN_URL, json=w3_payload, headers=w3_headers)
            if resp.status_code != 200:
                return {"success": False, "error": f"W3 login failed, HTTP {resp.status_code}"}

            cookies = []
            for cookie in client.cookies.jar:
                cookies.append(f"{cookie.name}={cookie.value}")
            if not cookies:
                return {"success": False, "error": "W3 login success but no valid cookies"}
            self._cookie_str = "; ".join(cookies)

        # 步骤 2: 获取海问 Token
        hiwen_headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/144.0.0.0 Safari/537.36"
            ),
            "Cookie": self._cookie_str,
            "Content-Type": "application/json",
            "Referer": "https://hiwen.huawei.com/home",
        }
        async with httpx.AsyncClient(timeout=30, verify=False, trust_env=False, follow_redirects=True) as client:
            resp = await client.post(HIWEN_AUTH_URL, headers=hiwen_headers)
            if resp.status_code != 200 or "text/html" in resp.headers.get("Content-Type", ""):
                return {"success": False, "error": f"Get Haiwen token failed, HTTP {resp.status_code}"}

            data = resp.json()
            if not data.get("success"):
                return {"success": False, "error": f"Get Haiwen token failed:{json.dumps(data, ensure_ascii=False)}"}
            
            token = data.get("token", "")
            if token.startswith("Bearer "):
                token = token[7:]
            if not token:
                return {"success": False, "error": "Token is empty"}
            self._token = token
            #获取token成功后，追加到cookie_str
            self._cookie_str += f";ADMIN-TOEKN=Bearer%20{self._token}"
        #MCP会话延迟初始化
        self._mcp_session_id = None
        self._save_cookie()
        return {"success": True}

    async def _ensure_mcp_session(self) -> Optional[str]:
        """确保 MCP 会话已初始化。"""
        if self._mcp_session_id:
            return self._mcp_session_id

        init_payload = {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "haiwen-client", "version": "1.0.0"},
            },
        }
        mcp_headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Cookie": self._cookie_str or "",
            "Authorization": f"Bearer {self._token or ''}",
            "Referer": "https://hiwen.huawei.com/home",
        }
        try:
            async with httpx.AsyncClient(timeout=60, verify=False, trust_env=False) as client:
                resp = await client.post(MCP_URL, json=init_payload, headers=mcp_headers)
                if resp.status_code != 200:
                    return None
                session_id = resp.headers.get("Mcp-Session-Id")
                if session_id:
                    self._mcp_session_id = session_id
                    self._save_cookie()
                return session_id
        except Exception:
            return None

    async def document_search(self, query: str, top_k: int = 4) -> Dict[str, Any]:
        """文档搜索。"""
        if not self.is_authenticated:
            return {"success": False, "error": "Not authenticated, please login first"}
        result = await self._call_mcp(
            "hiwen_document_search",
            {
                "main_question": query,
                "expanded_questions": query,
                "bm25_query_groups": query
            },
        )

        if result.get("expired"):
            return result

        if not result.get("success"):
            return result

        # 提取搜索结果的文本
        json_items = result.get("json_items") or []
        print(f"[haiwen_search] json_items: {len(json_items)}")
        text_parts = []
        for item in json_items:
            inner = item.get("result",item)
            if isinstance(inner, dict):
                content_list = inner.get("content", [])
                if isinstance(content_list, list):
                    for c in content_list:
                        if isinstance(c, dict) and c.get("type") == "text":
                            text_parts.append(c.get("text", ""))
        combined = "\n".join(text_parts).strip()
        if not combined:
            combined = self._extract_search_text(result.get("raw_result" ) or "")
        if not combined:
            logging.getLogger('wiki_server').debug(f"[haiwen_search] combined text is empty")
            return {"success": True, "documents": [], "raw_text": ""}
        # 解析 JSON 并提取 documents
        try:
            parsed = json.loads(combined)
            docs_field = parsed.get("documents", "")
            logging.getLogger('wiki_server').debug(f"[haiwen_document_search] docs_field length: {len(str(docs_field))}")
            if isinstance(docs_field, str):
                doc_items=re.split(r'【结果\d+】',docs_field)
                doc_items = [item.strip() for item in doc_items if item.strip()]
                if doc_items and doc_items[0].startswith("搜索关键词"):
                    doc_items = doc_items[1:]
                documents = []
                for item in doc_items[:top_k]:
                    title = ""
                    url = ""
                    for line in item.split("\n"):
                        if line.startswith("标题:"):
                            title = line[3:].strip()
                        elif line.startswith("链接:"):
                            url = line[3:].strip()
                    documents.append({"title": title or "doc", "url": url, "content": item})
            elif isinstance(docs_field, list):
                documents = docs_field[:top_k]
            else:
                documents = []
            return {"success": True, "documents": documents, "raw_text": combined}
        except (json.JSONDecodeError, AttributeError) as e:
            logging.getLogger('wiki_server').debug(f"[haiwen] parse JSON failed: {e}")
            return {"success": True, "documents": [], "raw_text": combined[:2000]}

    async def _call_mcp(self, tool_name: str, arguments: dict) -> Dict[str, Any]:
        """调用 MCP 工具，处理 SSE 流式响应。首次调用时需要初始化会话"""
        logging.getLogger('wiki_server').debug(f"[haiwen] _call_mcp: tool={tool_name}")
        session_id = await self._ensure_mcp_session()
        if not session_id:
            return {"success": False, "error": "init session failed"}
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments,
            },
        }

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json,text/event-stream",
            "Cookie": self._cookie_str or "",
            "Authorization": f"Bearer {self._token or ''}",
            "Referer": "https://hiwen.huawei.com/home?docClName=1",
            "Mcp-Session-Id": self._mcp_session_id,
        }

        async with httpx.AsyncClient(timeout=120,verify=False,trust_env=False) as client:
            async with client.stream("POST", MCP_URL, json=payload, headers=headers) as resp:
                status = resp.status_code

                if status == 401:
                    self.clear_credentials()
                    return {"success": False, "expired": True, "error": "auth expired: (401)"}

                if status == 500:
                    # 读取响应检查是否包含认证过期信息
                    body = await resp.aread()
                    body_text = body.decode("utf-8", errors="replace")
                    if "找不到当前登录" in body_text:
                        self.clear_credentials()
                        return {"success": False, "expired": True, "error": "auth expired: not found current login user"}
                    return {"success": False, "error": f"MCP call failed, HTTP 500: {body_text[:500]}"}

                if status != 200:
                    return {"success": False, "error": f"MCP call failed, HTTP status {status}"}

                # 解析 SSE 流
                return await self._parse_sse_response(resp)

    async def _parse_sse_response(self, resp) -> Dict[str, Any]:
        """解析 SSE 流式响应。"""
        json_items = []
        full_text = ""
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("data:"):
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    # 检查是否包含错误信息
                    if data.get("isError"):
                        content = json.dumps(data.get("content", []))
                        if "找不到当前登录" in content:
                            self.clear_credentials()
                            return {"success": False, "expired": True, "error": "auth expired: not found current login user"}
                    json_items.append(data)
                    full_text += data_str
                except json.JSONDecodeError:
                    continue
        logging.getLogger('wiki_server').debug(f"[haiwen] SSE parsed {len(json_items)} JSON items")
        if json_items:
            logging.getLogger('wiki_server').debug(f"[haiwen] SSE result received")
        return {"success": True, "raw_result": full_text, "json_items": json_items}

    @staticmethod
    def _extract_search_text(raw_result: str) -> str:
        """从 MCP 返回结果中提取文本内容。"""
        if not raw_result:
            return ""

        try:
            # 尝试解析为 JSON
            data = json.loads(raw_result)
        except json.JSONDecodeError:
            return raw_result

        texts = []

        def extract_content(obj):
            """递归提取 content 中的 text 字段。"""
            if isinstance(obj, list):
                for item in obj:
                    extract_content(item)
            elif isinstance(obj, dict):
                result = obj.get("result")
                if result and isinstance(result, dict):
                    content_list = result.get("content", [])
                    if isinstance(content_list, list):
                        for c in content_list:
                            if isinstance(c, dict) and c.get("type") == "text":
                                texts.append(c.get("text", ""))
                    elif isinstance(content_list, dict):
                        if content_list.get("type") == "text":
                            texts.append(content_list.get("text", ""))
                # 递归处理嵌套结构
                for v in obj.values():
                    if isinstance(v, (dict, list)):
                        extract_content(v)

        extract_content(data)
        return "\n".join(texts) if texts else raw_result
