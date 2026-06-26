"""
索引增量同步
=============
基于 wiki/log.md 检测变更，增量更新索引。
"""

import logging
import os
import re
from typing import List, Set, Optional
from datetime import datetime

_logger = logging.getLogger("llama_index.sync")


class IndexSyncManager:
    """
    索引增量同步管理器。

    监听 wiki/log.md 中的操作记录，检测需要重新索引的文件。

    用法:
        sync = IndexSyncManager(wiki_dir="/path/to/wiki")
        changed = sync.detect_changes()
        if changed:
            builder.incremental_update(wiki_dir, changed)
    """

    def __init__(self, wiki_dir: str):
        """
        Args:
            wiki_dir: Wiki 页面根目录
        """
        self._wiki_dir = wiki_dir
        self._log_path = os.path.join(wiki_dir, "log.md")
        self._last_checkpoint: Optional[str] = None  # 上次检查的 log.md 内容或时间戳

    def get_log_path(self) -> str:
        """获取 log.md 路径"""
        return self._log_path

    def detect_changes(self, since: datetime = None) -> List[str]:
        """
        检测自上次检查或指定时间以来的变更文件。
        """
        if not os.path.exists(self._log_path):
            _logger.debug(f"log.md not found: {self._log_path}")
            return []

        try:
            with open(self._log_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            _logger.warning(f"Failed to read log.md: {e}")
            return []

        changed_files = self._parse_log_entries(content, since=since)
        self._last_checkpoint = datetime.now().isoformat()
        _logger.info(f"detect_changes: found {len(changed_files)} changed files (since={since})")
        return changed_files

    def _parse_log_entries(self, content: str, since: datetime = None) -> List[str]:
        """
        解析 log.md 中的操作记录。

        提取模式:
        - Added `path`
        - Updated `path`
        - Created `path`
        - Modified `path`
        - Deleted `path`
        - Ingested source `path`

        Args:
            content: log.md 全文内容
            since: 从该时间点开始解析（格式: YYYY-MM-DD）

        Returns:
            变更的文件路径列表（wiki 下的相对路径）
        """
        changed_files: List[str] = set()

        # 按日期分组
        entries = re.split(r'\n## (\d{4}-\d{2}-\d{2})\n', content)

        for i in range(1, len(entries), 2):
            date_str = entries[i]
            entry_content = entries[i + 1] if i + 1 < len(entries) else ""

            # 如果指定了 since，跳过早于 since 的日期
            if since:
                try:
                    entry_date = datetime.strptime(date_str, "%Y-%m-%d")
                    if entry_date < since:
                        continue
                except ValueError:
                    pass

            # 提取文件路径
            # 匹配模式: Added `path`  / Updated `path`  / etc.
            path_pattern = r'(?:Added|Updated|Created|Modified|Deleted)\s+`([^`]+)`'
            for match in re.finditer(path_pattern, entry_content):
                filepath = match.group(1)
                # 标准化路径
                filepath = filepath.strip()
                if filepath:
                    if isinstance(changed_files, set):
                        changed_files.add(filepath)
                    else:
                        changed_files.append(filepath)

        return list(changed_files)

    def get_all_wiki_files(self) -> List[str]:
        """获取 wiki 目录下所有 markdown 文件列表"""
        files = []

        for root, _, filenames in os.walk(self._wiki_dir):
            for fn in filenames:
                if fn.endswith(".md"):
                    relpath = os.path.relpath(
                        os.path.join(root, fn), self._wiki_dir
                    )
                    files.append(relpath)

        return files

    def compare_with_index(self, indexed_files: Set[str]) -> dict:
        """
        对比文件系统与已索引文件的变化。
        """
        current_files = set(self.get_all_wiki_files())

        added = current_files - indexed_files
        removed = indexed_files - current_files
        unchanged = current_files & indexed_files

        _logger.info(
            f"Index comparison: total={len(current_files)}, "
            f"added={len(added)}, removed={len(removed)}, unchanged={len(unchanged)}"
        )

        return {
            "added": list(added),
            "removed": list(removed),
            "unchanged": list(unchanged),
        }
