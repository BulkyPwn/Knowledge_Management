"""
统一向量存储适配器
==================
提供统一的向量存储接口，当前实现为 ChromaDB，
预留接口便于后续切换到 LanceDB。
"""

from abc import ABC, abstractmethod
from typing import Optional

import chromadb
from llama_index.vector_stores.chroma import ChromaVectorStore


class VectorStoreAdapter(ABC):
    """统一向量库接口"""

    @abstractmethod
    def get_vector_store(self, collection_name: str):
        """获取指定 collection 的 VectorStore 实例"""
        ...

    @abstractmethod
    def list_collections(self) -> list:
        """列出所有已存在的 collection"""
        ...

    @abstractmethod
    def delete_collection(self, collection_name: str) -> None:
        """删除指定 collection"""
        ...


class ChromaDBAdapter(VectorStoreAdapter):
    """
    ChromaDB 实现：持久化模式。

    用法:
        adapter = ChromaDBAdapter(persist_dir="~/.SSSC_AI/chroma")
        vector_store = adapter.get_vector_store("wiki_pages")
    """

    def __init__(self, persist_dir: str):
        """
        Args:
            persist_dir: ChromaDB 持久化目录
        """
        self._persist_dir = persist_dir
        self._client: Optional[chromadb.PersistentClient] = None

    @property
    def client(self) -> chromadb.PersistentClient:
        """延迟创建 PersistentClient"""
        if self._client is None:
            self._client = chromadb.PersistentClient(path=self._persist_dir)
        return self._client

    def get_vector_store(self, collection_name: str) -> ChromaVectorStore:
        """获取或创建指定 collection 的 ChromaVectorStore"""
        col = self.client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        return ChromaVectorStore(chroma_collection=col)

    def list_collections(self) -> list:
        """列出所有 collection 名称"""
        return self.client.list_collections()

    def delete_collection(self, collection_name: str) -> None:
        """删除指定 collection（如果存在）"""
        try:
            self.client.delete_collection(collection_name)
        except Exception:
            pass  # collection 不存在则忽略

    def reset_all(self) -> None:
        """重置所有索引（删除所有 collection）"""
        for col in self.list_collections():
            self.delete_collection(col)
