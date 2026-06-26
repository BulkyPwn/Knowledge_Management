"""
Wiki 索引构建器
===============
构建 Wiki 页面、实体、概念的索引。
"""

import logging
import os
from typing import List, Dict, Any, Optional

from llama_index.core import Document, VectorStoreIndex

from langgraph_fusion.adapters.embedding_adapter import EmbeddingFactory
from langgraph_fusion.adapters.vector_store_adapter import VectorStoreAdapter
from .index_registry import IndexRegistry

_logger = logging.getLogger("llama_index.wiki_builder")


class WikiIndexBuilder:
    """
    Wiki 索引构建器。

    负责构建 Wiki 页面相关的索引（wiki_pages, wiki_entities, wiki_concepts）。

    用法:
        builder = WikiIndexBuilder(vector_store_adapter, embedding_factory)
        builder.build(wiki_dir="/path/to/wiki", force=False)
    """

    def __init__(self, vector_store_adapter: VectorStoreAdapter,
                 embedding_factory: EmbeddingFactory):
        self._vs_adapter = vector_store_adapter
        self._embed_factory = embedding_factory
        self.registry: Optional[IndexRegistry] = None

    def build(self, wiki_dir: str, force: bool = False) -> IndexRegistry:
        """
        构建 Wiki 相关索引。

        Args:
            wiki_dir: Wiki 页面根目录
            force: 是否强制重建

        Returns:
            IndexRegistry 实例
        """
        self.registry = IndexRegistry(self._vs_adapter, self._embed_factory)

        embed_model = self._embed_factory.create()

        # 1. Wiki 页面索引（递归扫描所有子目录）
        if force or "wiki_pages" not in self.registry._indexes:
            _logger.info("Building wiki_pages index...")
            docs = self._load_wiki_pages(wiki_dir)
            self.registry._indexes["wiki_pages"] = self._create_index(
                "wiki_pages", docs, embed_model,
            )
            _logger.info(f"wiki_pages index built with {len(docs)} pages")

        # 2. 实体索引
        entities_dir = os.path.join(wiki_dir, "entities")
        if os.path.isdir(entities_dir):
            if force or "wiki_entities" not in self.registry._indexes:
                _logger.info("Building wiki_entities index...")
                docs = self._load_md_files(entities_dir)
                if docs:
                    self.registry._indexes["wiki_entities"] = self._create_index(
                        "wiki_entities", docs, embed_model,
                    )
                    _logger.info(f"wiki_entities index built with {len(docs)} entities")

        # 3. 概念索引
        concepts_dir = os.path.join(wiki_dir, "concepts")
        if os.path.isdir(concepts_dir):
            if force or "wiki_concepts" not in self.registry._indexes:
                _logger.info("Building wiki_concepts index...")
                docs = self._load_md_files(concepts_dir)
                if docs:
                    self.registry._indexes["wiki_concepts"] = self._create_index(
                        "wiki_concepts", docs, embed_model,
                    )
                    _logger.info(f"wiki_concepts index built with {len(docs)} concepts")

        self.registry._is_built = True
        return self.registry

    def incremental_update(self, wiki_dir: str,
                           changed_files: List[str]) -> Dict[str, int]:
        """
        增量更新：仅重建变更文件的 embedding。

        Args:
            wiki_dir: Wiki 页面根目录
            changed_files: 变更的文件路径列表

        Returns:
            {"updated": int, "deleted": int, "total": int}
        """
        if self.registry is None:
            raise RuntimeError("Please call build() first")

        embed_model = self._embed_factory.create()
        updated = 0
        deleted = 0

        for filepath in changed_files:
            abspath = os.path.join(wiki_dir, filepath) if not os.path.isabs(filepath) else filepath

            if not os.path.exists(abspath):
                # 文件已删除
                for index in self.registry.get_all().values():
                    # TODO: LlamaIndex 支持按 metadata 删除节点
                    deleted += 1
                continue

            # 判断文件属于哪个索引
            index_name = _classify_file(filepath)

            try:
                index = self.registry.get(index_name)
                if index is None:
                    continue

                with open(abspath, "r", encoding="utf-8") as f:
                    content = f.read()

                metadata = self._extract_metadata(abspath, content)
                doc = Document(text=content, metadata=metadata)

                # 重建该文档的 embedding
                index.refresh_ref_docs([doc])
                updated += 1
            except Exception as e:
                _logger.warning(f"Failed to update {abspath}: {e}")

        return {"updated": updated, "deleted": deleted, "total": len(changed_files)}

    def _load_wiki_pages(self, wiki_dir: str) -> List[Document]:
        """加载 Wiki 目录下所有 Markdown 文件"""
        return self._load_md_files(wiki_dir, recursive=True, exclude_dirs={"entities", "concepts"})

    def _load_md_files(self, dir_path: str, recursive: bool = False,
                       exclude_dirs: set = None) -> List[Document]:
        """加载目录下的 Markdown 文件"""
        from .index_registry import _load_markdown_documents

        if exclude_dirs is None:
            exclude_dirs = set()

        docs = _load_markdown_documents(dir_path, recursive=recursive)
        # 排除指定子目录中的文件
        filtered = []
        for doc in docs:
            filepath = doc.metadata.get("file_path", "")
            exclude = False
            for edir in exclude_dirs:
                if f"/{edir}/" in filepath or f"\\{edir}\\" in filepath:
                    exclude = True
                    break
            if not exclude:
                filtered.append(doc)
        return filtered

    def _create_index(self, name: str, documents: List[Document],
                      embed_model) -> VectorStoreIndex:
        """创建索引"""
        from llama_index.core import StorageContext

        vector_store = self._vs_adapter.get_vector_store(name)
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        return VectorStoreIndex.from_documents(
            documents,
            embed_model=embed_model,
            storage_context=storage_context,
            show_progress=False,
        )

    def _extract_metadata(self, file_path: str, content: str) -> dict:
        """提取元数据"""
        from .index_registry import _extract_frontmatter_metadata
        return _extract_frontmatter_metadata(file_path, content)


def _classify_file(filepath: str) -> str:
    """根据文件路径判断属于哪个索引"""
    normalized = filepath.replace("\\", "/")
    if "/entities/" in normalized:
        return "wiki_entities"
    if "/concepts/" in normalized:
        return "wiki_concepts"
    return "wiki_pages"
