import os
import re
import json
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional


class WikiManager:
    def __init__(self, wiki_dir: str):
        self.wiki_dir = wiki_dir

    def extract_links(self, content: str) -> List[str]:
        return re.findall(r"\[\[([^\]]+)\]\]", content)

    def extract_tags(self, content: str) -> List[str]:
        return re.findall(r"#(\w+)", content)

    def extract_title(self, content: str) -> str:
        match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
        if match:
            return match.group(1).strip()
        return ""

    def extract_type(self, content: str) -> str:
        for line in content.split("\n"):
            if line.strip().startswith("type:"):
                return (
                    line.strip()
                    .removeprefix("type:")
                    .strip()
                    .strip('"')
                    .strip("'")
                    .lower()
                )
        return "other"

    def list_pages(self) -> List[Dict[str, Any]]:
        if not os.path.exists(self.wiki_dir):
            return []
        pages = []
        for item in os.listdir(self.wiki_dir):
            if item.endswith(".md"):
                filepath = os.path.join(self.wiki_dir, item)
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
                stat = os.stat(filepath)
                pages.append(
                    {
                        "title": item[:-3],
                        "filename": item,
                        "page_type": self.extract_type(content),
                        "links": self.extract_links(content),
                        "tags": self.extract_tags(content),
                        "size": stat.st_size,
                        "modified_at": datetime.fromtimestamp(
                            stat.st_mtime
                        ).isoformat(),
                    }
                )
        return pages

    def get_page(self, title: str) -> Optional[Dict[str, Any]]:
        filepath = os.path.join(self.wiki_dir, f"{title}.md")
        if not os.path.exists(filepath):
            return None
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        stat = os.stat(filepath)
        return {
            "title": title,
            "content": content,
            "page_type": self.extract_type(content),
            "links": self.extract_links(content),
            "tags": self.extract_tags(content),
            "size": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        }

    def create_page(self, title: str, content: str) -> Dict[str, Any]:
        filepath = os.path.join(self.wiki_dir, f"{title}.md")
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return {"success": True, "path": filepath, "title": title}

    def update_page(self, title: str, content: str) -> Dict[str, Any]:
        filepath = os.path.join(self.wiki_dir, f"{title}.md")
        if not os.path.exists(filepath):
            return {"success": False, "message": f"Page not found: {title}"}
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return {"success": True, "path": filepath, "title": title}

    def delete_page(self, title: str) -> Dict[str, Any]:
        filepath = os.path.join(self.wiki_dir, f"{title}.md")
        if not os.path.exists(filepath):
            return {"success": False, "message": f"Page not found: {title}"}
        os.remove(filepath)
        return {"success": True, "title": title}

    def find_orphan_pages(self) -> List[str]:
        pages = self.list_pages()
        all_titles = {page["title"] for page in pages}
        all_links = set()
        for page in pages:
            all_links.update(page["links"])
        return [link for link in all_links if link not in all_titles]

    def find_weak_links(self) -> List[str]:
        pages = self.list_pages()
        return [page["title"] for page in pages if len(page["links"]) < 2]

    def find_outdated_pages(self, days: int = 30) -> List[Dict[str, str]]:
        threshold = datetime.now() - timedelta(days=days)
        outdated = []
        for item in os.listdir(self.wiki_dir):
            if item.endswith(".md"):
                filepath = os.path.join(self.wiki_dir, item)
                mtime = datetime.fromtimestamp(os.stat(filepath).st_mtime)
                if mtime < threshold:
                    outdated.append(
                        {
                            "title": item[:-3],
                            "last_modified": mtime.isoformat(),
                        }
                    )
        return outdated

    def lint(self) -> Dict[str, Any]:
        return {
            "orphan_pages": self.find_orphan_pages(),
            "weak_links": self.find_weak_links(),
            "outdated_pages": self.find_outdated_pages(),
        }

    def build_graph(self) -> Dict[str, Any]:
        nodes = []
        edges = []
        pages = self.list_pages()
        for page in pages:
            nodes.append(
                {
                    "id": page["title"],
                    "label": page["title"],
                    "node_type": page.get("page_type", "other"),
                }
            )
            for link in page["links"]:
                edges.append({"source": page["title"], "target": link})
        return {"nodes": nodes, "edges": edges}

    def search_pages(self, query: str) -> List[Dict[str, Any]]:
        query_lower = query.lower()
        results = []
        pages = self.list_pages()
        for page in pages:
            page_data = self.get_page(page["title"])
            if page_data is None:
                continue
            content_lower = page_data["content"].lower()
            if (
                query_lower in page["title"].lower()
                or query_lower in content_lower
            ):
                idx = content_lower.find(query_lower)
                start = max(0, idx - 100)
                end = min(len(content_lower), idx + 200)
                preview = page_data["content"][start:end]
                results.append(
                    {
                        "title": page["title"],
                        "preview": preview + "..."
                        if end < len(content_lower)
                        else preview,
                    }
                )
        return results
