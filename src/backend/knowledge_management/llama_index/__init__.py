# 兼容原有简化版 LlamaIndex
from .document import Document, Node, NodeBuilder
from .index import VectorIndex, TreeIndex, KeywordIndex, TreeNode
from .query_engine import QueryEngine, RetrieverQueryEngine
from .llama_index import LlamaIndex, LlamaIndexConfig

# 新增：官方 llama-index 库集成
from .index_registry import IndexRegistry
from .wiki_index_builder import WikiIndexBuilder
from .raw_index_builder import RawIndexBuilder
from .index_sync import IndexSyncManager

__all__ = [
    # 原有
    'Document', 'Node', 'NodeBuilder',
    'VectorIndex', 'TreeIndex', 'KeywordIndex', 'TreeNode',
    'QueryEngine', 'RetrieverQueryEngine',
    'LlamaIndex', 'LlamaIndexConfig',
    # 新增
    'IndexRegistry',
    'WikiIndexBuilder',
    'RawIndexBuilder',
    'IndexSyncManager',
]
