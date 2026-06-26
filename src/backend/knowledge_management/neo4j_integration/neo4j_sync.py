import os
import re
import sys
from typing import Dict, List, Any, Optional
from datetime import datetime

from .neo4j_client import Neo4jClient, get_neo4j_client


class Neo4jWikiSync:
    WIKI_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
    HEADING_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)
    FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
    TAG_RE = re.compile(r"#(\w+)")
    ENTITY_RE = re.compile(r"`([A-Z][a-zA-Z_]{2,})`")
    PAGE_TYPE_RE = re.compile(r"type:\s*(\w+)", re.IGNORECASE)

    def __init__(self, client: Optional[Neo4jClient] = None):
        self._client = client

    @property
    def client(self) -> Optional[Neo4jClient]:
        if self._client is None:
            self._client = get_neo4j_client()
        return self._client

    @property
    def available(self) -> bool:
        return self.client is not None and self.client.available

    def sync_project(
        self,
        project_name: str,
        wiki_dir: str,
        clear_first: bool = False,
    ) -> Dict[str, Any]:
        if not self.available:
            return {"success": False, "message": "Neo4j is not available"}

        if not os.path.isdir(wiki_dir):
            return {"success": False, "message": f"Wiki directory not found: {wiki_dir}"}

        if clear_first:
            self.client.clear_project(project_name)

        stats = {"pages_synced": 0, "relationships_created": 0, "errors": 0}

        page_data_list = []
        for filename in os.listdir(wiki_dir):
            if not filename.endswith(".md"):
                continue

            filepath = os.path.join(wiki_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
            except Exception as e:
                sys.stderr.write(f"[neo4j] Failed to read {filepath}: {e}\n")
                stats["errors"] += 1
                continue

            title = filename[:-3]
            stat = os.stat(filepath)
            page_data = self._parse_page(title, filepath, content, project_name, stat)
            page_data_list.append((page_data, content))

        for page_data, content in page_data_list:
            if self.client.upsert_node(
                node_id=page_data["title"],
                labels=page_data["labels"],
                properties=page_data["properties"],
            ):
                stats["pages_synced"] += 1
            else:
                stats["errors"] += 1

        for page_data, content in page_data_list:
            links = self.WIKI_LINK_RE.findall(content)
            for target_title in links:
                target_title = target_title.strip()
                if not target_title:
                    continue
                if self.client.upsert_relationship(
                    source_id=page_data["title"],
                    target_id=target_title,
                    rel_type="LINKS_TO",
                    properties={"weight": 1.0},
                ):
                    stats["relationships_created"] += 1
                else:
                    pass

        return {"success": True, "stats": stats}

    def _parse_page(
        self,
        title: str,
        filepath: str,
        content: str,
        project_name: str,
        stat: os.stat_result,
    ) -> Dict[str, Any]:
        page_type = self._extract_type(content)
        heading = self._extract_heading(content)
        tags = self.TAG_RE.findall(content)
        entities = self.ENTITY_RE.findall(content)
        links = self.WIKI_LINK_RE.findall(content)
        display_title = heading or title.replace("-", " ").title()

        labels = ["WikiPage", page_type.capitalize() if page_type else "Other"]

        properties = {
            "title": title,
            "display_title": display_title,
            "path": filepath,
            "project": project_name,
            "page_type": page_type,
            "tags": tags,
            "link_count": len(links),
            "entity_count": len(entities),
            "size_bytes": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "content_preview": content[:500],
        }

        return {"title": title, "labels": labels, "properties": properties}

    def _extract_type(self, content: str) -> str:
        match = self.PAGE_TYPE_RE.search(content)
        if match:
            return match.group(1).lower()
        for line in content.split("\n"):
            stripped = line.strip()
            if stripped.startswith("type:"):
                return (
                    stripped.removeprefix("type:")
                    .strip()
                    .strip('"')
                    .strip("'")
                    .lower()
                )
        return "other"

    def _extract_heading(self, content: str) -> str:
        match = self.HEADING_RE.search(content)
        if match:
            return match.group(1).strip()
        return ""

    def sync_page(
        self,
        project_name: str,
        title: str,
        content: str,
        filepath: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self.available:
            return {"success": False, "message": "Neo4j is not available"}

        now = datetime.now()
        page_type = self._extract_type(content)
        heading = self._extract_heading(content)
        tags = self.TAG_RE.findall(content)
        entities = self.ENTITY_RE.findall(content)
        links = self.WIKI_LINK_RE.findall(content)
        display_title = heading or title.replace("-", " ").title()

        labels = ["WikiPage", page_type.capitalize() if page_type else "Other"]

        properties = {
            "title": title,
            "display_title": display_title,
            "path": filepath or "",
            "project": project_name,
            "page_type": page_type,
            "tags": tags,
            "link_count": len(links),
            "entity_count": len(entities),
            "size_bytes": len(content.encode("utf-8")),
            "modified_at": now.isoformat(),
            "content_preview": content[:500],
        }

        if not self.client.upsert_node(title, labels, properties):
            return {"success": False, "message": "Failed to upsert node"}

        relationship_count = 0
        if links:
            self._remove_stale_relationships(title)
            for target_title in links:
                target_title = target_title.strip()
                if not target_title:
                    continue
                if self.client.upsert_relationship(
                    source_id=title,
                    target_id=target_title,
                    rel_type="LINKS_TO",
                    properties={"weight": 1.0},
                ):
                    relationship_count += 1

        return {
            "success": True,
            "title": title,
            "labels": labels,
            "link_count": len(links),
            "relationships_created": relationship_count,
        }

    def delete_page(self, title: str) -> Dict[str, Any]:
        if not self.available:
            return {"success": False, "message": "Neo4j is not available"}

        ok = self.client.delete_node(title, "WikiPage")
        return {"success": ok, "title": title}

    def _remove_stale_relationships(self, title: str):
        if not self.client:
            return
        try:
            self.client.run(
                "MATCH (a:WikiPage {title: $title})-[r:LINKS_TO]->() DELETE r",
                {"title": title},
            )
        except Exception:
            pass
