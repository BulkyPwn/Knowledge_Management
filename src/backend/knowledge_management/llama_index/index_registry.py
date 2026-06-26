"""
索引注册表
==========
管理所有 LlamaIndex 索引实例，提供统一注册、查询、构建入口。
"""

import logging
import os
from typing import Dict, Optional, List

from llama_index.core import VectorStoreIndex, StorageContext, Settings
from llama_index.core.schema import Document
from llama_index.core.node_parser import MarkdownNodeParser

from langgraph_fusion.adapters.embedding_adapter import EmbeddingFactory
from langgraph_fusion.adapters.vector_store_adapter import VectorStoreAdapter

_logger = logging.getLogger("llama_index.registry")


class IndexRegistry:
    """
    索引注册表。

    管理:
    - raw_sources: 原始文档索引
    - wiki_pages: Wiki 页面索引
    - wiki_entities: 实体页面索引
    - wiki_concepts: 概念页面索引

    用法:
        registry = IndexRegistry(vector_store_adapter, embedding_factory)
        registry.build_all(wiki_dir="/path/to/wiki", raw_dir="/path/to/raw")
        index = registry.get("wiki_pages")
        retriever = index.as_retriever(similarity_top_k=10)
    """

    INDEX_NAMES = ["raw_sources", "wiki_pages", "wiki_entities", "wiki_concepts"]

    def __init__(self, vector_store_adapter: VectorStoreAdapter, embedding_factory: EmbeddingFactory):
        """
        Args:
            vector_store_adapter: 向量存储适配器
            embedding_factory: Embedding 工厂
        """
        self._vs_adapter = vector_store_adapter
        self._embed_factory = embedding_factory
        self._indexes: Dict[str, VectorStoreIndex] = {}
        self._is_built = False

    def get(self, name: str) -> Optional[VectorStoreIndex]:
        """获取指定名称的索引"""
        return self._indexes.get(name)

    def get_all(self) -> Dict[str, VectorStoreIndex]:
        """获取所有索引"""
        return dict(self._indexes)

    def is_built(self) -> bool:
        """检查索引是否已构建"""
        return self._is_built and len(self._indexes) > 0

    def list_index_names(self) -> List[str]:
        """列出已构建的索引名称"""
        return list(self._indexes.keys())

    def build_all(self, wiki_dir: str, raw_dir: str, force: bool = False):
        """
        全量构建所有索引。
        """
        embed_model = self._embed_factory.create()

        if not self._embed_factory.is_configured():
            _logger.error("Embedding not configured: api_base or api_key is missing")
            raise RuntimeError("Embedding not configured")

        _logger.info(f"Building all indexes: wiki={wiki_dir}, raw={raw_dir}, force={force}")

        # 1. 原始文档索引
        if force or "raw_sources" not in self._indexes:
            _logger.info("Building raw_sources index...")
            self._build_index(name="raw_sources", dir_path=raw_dir,
                              embed_model=embed_model, recursive=False)

        # 2. Wiki 页面索引
        if force or "wiki_pages" not in self._indexes:
            _logger.info("Building wiki_pages index...")
            self._build_index(name="wiki_pages", dir_path=wiki_dir,
                              embed_model=embed_model, recursive=True)

        # 3. 实体索引
        if force or "wiki_entities" not in self._indexes:
            _logger.info("Building wiki_entities index...")
            entities_dir = os.path.join(wiki_dir, "entities")
            self._build_index(name="wiki_entities", dir_path=entities_dir,
                              embed_model=embed_model, recursive=False)

        # 4. 概念索引
        if force or "wiki_concepts" not in self._indexes:
            _logger.info("Building wiki_concepts index...")
            concepts_dir = os.path.join(wiki_dir, "concepts")
            self._build_index(name="wiki_concepts", dir_path=concepts_dir,
                              embed_model=embed_model, recursive=False)

        self._is_built = True
        _logger.info(f"All indexes built: {self.list_index_names()}")

    def _build_index(self, name: str, dir_path: str, embed_model,
                     recursive: bool = False):
        """
        构建单个索引。

        Args:
            name: 索引名称
            dir_path: 文档目录
            embed_model: Embedding 模型
            recursive: 是否递归扫描子目录
        """
        if not os.path.isdir(dir_path):
            _logger.warning(f"Directory not found: {dir_path}, skipping '{name}'")
            return

        # 加载 markdown 文档
        documents = _load_markdown_documents(dir_path, recursive=recursive)
        if not documents:
            _logger.warning(f"No documents found in: {dir_path}")
            return

        _logger.info(f"Indexing {len(documents)} documents for '{name}'...")

        # 获取对应的 VectorStore
        vector_store = self._vs_adapter.get_vector_store(name)
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        # 构建索引
        index = VectorStoreIndex.from_documents(
            documents,
            embed_model=embed_model,
            storage_context=storage_context,
            transformations=[MarkdownNodeParser()],
            show_progress=False,
        )

        self._indexes[name] = index
        _logger.info(f"Index '{name}' built with {len(documents)} documents")

    def reload(self, name: str):
        """
        从已有的 ChromaDB collection 重新加载索引（不重建 embedding）。

        适用于应用重启后恢复索引。
        """
        embed_model = self._embed_factory.create()
        vector_store = self._vs_adapter.get_vector_store(name)
        index = VectorStoreIndex.from_vector_store(
            vector_store,
            embed_model=embed_model,
        )
        self._indexes[name] = index
        _logger.info(f"Index '{name}' reloaded from vector store")

    def reload_all(self):
        """重新加载所有已存在的索引（不重建）"""
        for name in self.INDEX_NAMES:
            try:
                self.reload(name)
            except Exception as e:
                _logger.debug(f"Cannot reload '{name}': {e}")
        self._is_built = len(self._indexes) > 0

    def rebuild_one(self, name: str, dir_path: str):
        """重建单个索引"""
        embed_model = self._embed_factory.create()

        # 删除旧 collection
        self._vs_adapter.delete_collection(name)

        self._build_index(name, dir_path, embed_model)
        _logger.info(f"Index '{name}' rebuilt")


def _load_markdown_documents(dir_path: str, recursive: bool = False) -> List[Document]:
    """
    加载目录下的 Markdown 文件为 LlamaIndex Document 列表。

    Args:
        dir_path: 目录路径
        recursive: 是否递归

    Returns:
        Document 列表
    """
    documents = []

    def _walk(path: str):
        try:
            entries = os.listdir(path)
        except OSError:
            return

        for entry in entries:
            full_path = os.path.join(path, entry)
            if os.path.isfile(full_path) and entry.endswith(".md"):
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        content = f.read()
                except Exception as e:
                    _logger.warning(f"Failed to read {full_path}: {e}")
                    continue

                if not content.strip():
                    continue

                # 提取 YAML frontmatter 元数据
                metadata = _extract_frontmatter_metadata(full_path, content)
                metadata["file_path"] = full_path

                doc = Document(
                    text=content,
                    metadata=metadata,
                )
                documents.append(doc)

            elif os.path.isdir(full_path) and recursive:
                _walk(full_path)

    _walk(dir_path)
    return documents


def _extract_frontmatter_metadata(file_path: str, content: str) -> dict:
    """
    从 Markdown YAML frontmatter 中提取元数据。

    LLM Wiki 的每个页面都有 YAML frontmatter:
    ---
    type: entity | concept | source | ...
    title: ...
    tags: [...]
    related: [...]
    created: YYYY-MM-DD
    updated: YYYY-MM-DD
    ---

    Returns:
        dict
    """
    import re
    import yaml as _yaml_lib  # 可选

    metadata = {}

    # 提取 YAML frontmatter
    match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
    if match:
        yaml_text = match.group(1)
        try:
            fm = _yaml_lib.safe_load(yaml_text)
            if isinstance(fm, dict):
                metadata.update(fm)
        except Exception:
            # PyYAML 不可用或解析失败，手动提取
            for key in ("type", "title", "tags", "related", "created", "updated"):
                m = re.search(rf'^{key}\s*:\s*(.+)', yaml_text, re.MULTILINE)
                if m:
                    val = m.group(1).strip()
                    if key in ("tags", "related"):
                        val = [v.strip() for v in val.strip("[]").split(",") if v.strip()]
                    metadata[key] = val

    # 提取 wikilink
    wikilinks = re.findall(r'\[\[([^\]]+)\]\]', content)
    if wikilinks:
        metadata["wikilinks"] = wikilinks

    # 从文件名推断信息
    filename = os.path.basename(file_path).replace(".md", "")
    if "title" not in metadata:
        metadata["title"] = filename

    return metadata
