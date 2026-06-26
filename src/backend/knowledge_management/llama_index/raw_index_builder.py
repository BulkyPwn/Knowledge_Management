"""
原始文档索引构建器
=================
构建 raw/sources/ 下原始文档的索引。
"""

import logging
import os
from typing import Optional

from llama_index.core import Document, VectorStoreIndex, StorageContext

from langgraph_fusion.adapters.embedding_adapter import EmbeddingFactory
from langgraph_fusion.adapters.vector_store_adapter import VectorStoreAdapter

_logger = logging.getLogger("llama_index.raw_builder")


class RawIndexBuilder:
    """
    原始文档索引构建器。

    负责构建 raw/sources/ 下的原始文档索引。

    用法:
        builder = RawIndexBuilder(vector_store_adapter, embedding_factory)
        index = builder.build(raw_dir="/path/to/raw", force=False)
    """

    def __init__(self, vector_store_adapter: VectorStoreAdapter,
                 embedding_factory: EmbeddingFactory):
        self._vs_adapter = vector_store_adapter
        self._embed_factory = embedding_factory
        self._index: Optional[VectorStoreIndex] = None

    def build(self, raw_dir: str, force: bool = False) -> Optional[VectorStoreIndex]:
        """
        构建原始文档索引。

        Args:
            raw_dir: 原始文档目录
            force: 是否强制重建

        Returns:
            VectorStoreIndex 实例，如果目录为空则返回 None
        """
        if not os.path.isdir(raw_dir):
            _logger.warning(f"Raw directory not found: {raw_dir}")
            return None

        embed_model = self._embed_factory.create()
        documents = self._load_raw_documents(raw_dir)

        if not documents:
            _logger.warning(f"No documents found in: {raw_dir}")
            return None

        _logger.info(f"Building raw_sources index with {len(documents)} documents...")

        vector_store = self._vs_adapter.get_vector_store("raw_sources")
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        self._index = VectorStoreIndex.from_documents(
            documents,
            embed_model=embed_model,
            storage_context=storage_context,
            show_progress=False,
        )

        _logger.info(f"raw_sources index built")
        return self._index

    def get_index(self) -> Optional[VectorStoreIndex]:
        """获取已构建的索引"""
        return self._index

    def reload(self) -> Optional[VectorStoreIndex]:
        """从已有 collection 重新加载索引"""
        embed_model = self._embed_factory.create()
        vector_store = self._vs_adapter.get_vector_store("raw_sources")
        self._index = VectorStoreIndex.from_vector_store(
            vector_store,
            embed_model=embed_model,
        )
        return self._index

    def _load_raw_documents(self, raw_dir: str) -> list:
        """加载原始文档目录下的所有文件"""
        from .index_registry import _load_markdown_documents

        docs = _load_markdown_documents(raw_dir, recursive=True)

        # 标记为原始文档
        for doc in docs:
            doc.metadata["source_type"] = "raw_document"

        return docs
