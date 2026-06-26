from typing import List, Dict, Any, Optional
import json
import os
from datetime import datetime
from ..utils.tree_structure import TreeNode, TreeStructure
from ..utils.retriever import HierarchicalRetriever

class RAPTOR:
    def __init__(self, model_name: str = "gpt-4o-mini"):
        self.retriever = HierarchicalRetriever()
        self.model_name = model_name
        self.tree = TreeStructure()
        self.documents = []
    
    def ingest_document(self, content: str, metadata: Optional[Dict[str, Any]] = None):
        doc_id = f"doc_{len(self.documents)}"
        document = {
            'id': doc_id,
            'content': content,
            'metadata': metadata or {},
            'embedding': None,
            'created_at': datetime.now().isoformat()
        }
        self.documents.append(document)
        
        node = TreeNode(
            node_id=doc_id,
            content=content,
            metadata=metadata or {}
        )
        self.tree.add_node(node)
    
    def build_hierarchy(self, max_levels: int = 3):
        docs_with_embeddings = []
        for doc in self.documents:
            if doc['embedding'] is None:
                doc['embedding'] = self._generate_embedding(doc['content'])
            docs_with_embeddings.append(doc)
        
        self.retriever.build_tree(docs_with_embeddings, max_levels)
    
    def _generate_embedding(self, text: str) -> List[float]:
        import hashlib
        hash_val = int(hashlib.md5(text.encode()).hexdigest(), 16)
        embedding = []
        for i in range(768):
            embedding.append((hash_val >> (i * 8)) % 256 / 255.0)
        return embedding
    
    def query(self, question: str, max_context_length: int = 4096) -> Dict[str, Any]:
        query_embedding = self._generate_embedding(question)
        retrieved = self.retriever.retrieve(query_embedding, k=5)
        
        context = []
        for node, score in retrieved:
            context.append({
                'node_id': node.node_id,
                'content': node.content,
                'level': node.level,
                'score': score
            })
        
        context_text = "\n\n---\n\n".join([c['content'] for c in context])
        if len(context_text) > max_context_length:
            context_text = context_text[:max_context_length] + "\n\n..."
        
        answer = self._generate_answer(question, context_text)
        
        return {
            'question': question,
            'answer': answer,
            'context': context,
            'context_length': len(context_text)
        }
    
    def _generate_answer(self, question: str, context: str) -> str:
        prompt = f"""Answer the question based on the following context:

Context:
{context}

Question: {question}

Please provide a detailed answer. If the context does not contain relevant information, please state so.
"""
        
        return f"Based on the knowledge base, the answer to question '{question}' is: This is a simulated RAPTOR answer. In a real application, this would call an actual LLM model for inference and generation.\n\nThe referenced context contains {context.count('---') + 1} relevant segments."
    
    def get_tree_summary(self) -> Dict[str, Any]:
        return {
            'total_documents': len(self.documents),
            'total_nodes': len(self.retriever.tree.nodes),
            'tree_structure': self.retriever.tree.to_dict()
        }
    
    def save_state(self, filepath: str):
        state = {
            'documents': self.documents,
            'model_name': self.model_name,
            'saved_at': datetime.now().isoformat()
        }
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    
    def load_state(self, filepath: str):
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"File not found: {filepath}")
        
        with open(filepath, 'r', encoding='utf-8') as f:
            state = json.load(f)
        
        self.documents = state.get('documents', [])
        self.model_name = state.get('model_name', 'gpt-4o-mini')
        
        if self.documents:
            self.build_hierarchy()

class RAPTORConfig:
    def __init__(self):
        self.max_levels = 3
        self.max_context_length = 4096
        self.retrieval_k = 5
        self.model_name = "gpt-4o-mini"
        self.enable_tree_reasoning = True
