from typing import List, Dict, Any, Optional
import json
import os
from datetime import datetime
from .document import Document, Node
from .index import VectorIndex, TreeIndex, KeywordIndex
from .query_engine import QueryEngine

class LlamaIndex:
    def __init__(self):
        self.documents: Dict[str, Document] = {}
        self.vector_index = VectorIndex()
        self.tree_index = TreeIndex()
        self.keyword_index = KeywordIndex()
        self.query_engine = QueryEngine(self.vector_index, self.tree_index, self.keyword_index)
        self.is_built = False
    
    def add_document(self, doc_id: str, text: str, metadata: Optional[Dict[str, Any]] = None):
        doc = Document(
            id=doc_id,
            text=text,
            metadata=metadata or {}
        )
        self.documents[doc_id] = doc
        self.vector_index.add_document(doc)
        
        for node in self.vector_index.nodes.values():
            if node.document_id == doc_id:
                self.keyword_index.add_node(node)
        
        self.is_built = False
    
    def build(self, tree_max_children: int = 3):
        nodes = list(self.vector_index.nodes.values())
        
        self.tree_index = TreeIndex()
        self.tree_index.build_from_nodes(nodes, max_children_per_node=tree_max_children)
        
        self.query_engine = QueryEngine(
            self.vector_index,
            self.tree_index,
            self.keyword_index
        )
        
        self.is_built = True
    
    def query(self, question: str, mode: str = "vector", top_k: int = 5) -> Dict[str, Any]:
        return self.query_engine.query(question, mode, top_k)
    
    def get_index_summary(self) -> Dict[str, Any]:
        return {
            'document_count': len(self.documents),
            'vector_index': {
                'node_count': len(self.vector_index.nodes)
            },
            'tree_index': self.tree_index.to_dict(),
            'keyword_index': self.keyword_index.to_dict(),
            'is_built': self.is_built
        }
    
    def save_state(self, filepath: str):
        state = {
            'documents': {
                doc_id: {
                    'id': doc.id,
                    'text': doc.text,
                    'metadata': doc.metadata,
                    'created_at': doc.created_at
                }
                for doc_id, doc in self.documents.items()
            },
            'saved_at': datetime.now().isoformat()
        }
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    
    def load_state(self, filepath: str):
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"文件不存在: {filepath}")
        
        with open(filepath, 'r', encoding='utf-8') as f:
            state = json.load(f)
        
        self.documents.clear()
        self.vector_index = VectorIndex()
        self.keyword_index = KeywordIndex()
        
        for doc_data in state.get('documents', {}).values():
            doc = Document(
                id=doc_data['id'],
                text=doc_data['text'],
                metadata=doc_data.get('metadata', {})
            )
            self.add_document(doc.id, doc.text, doc.metadata)
        
        self.is_built = False

class LlamaIndexConfig:
    def __init__(self):
        self.chunk_size = 500
        self.chunk_overlap = 50
        self.tree_max_children = 3
        self.default_top_k = 5
        self.default_mode = "vector"
