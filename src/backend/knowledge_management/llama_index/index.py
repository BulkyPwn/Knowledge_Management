from typing import List, Dict, Any, Optional, Tuple
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from .document import Document, Node, NodeBuilder

class VectorIndex:
    def __init__(self):
        self.nodes: Dict[str, Node] = {}
        self.documents: Dict[str, Document] = {}
        self.embeddings: Dict[str, List[float]] = {}
    
    def add_document(self, doc: Document, chunk_size: int = 500, overlap: int = 50):
        self.documents[doc.id] = doc
        
        nodes = NodeBuilder.build_nodes_from_document(doc, chunk_size, overlap)
        
        for node in nodes:
            self.nodes[node.id] = node
            if doc.embedding:
                node.embedding = doc.embedding
                self.embeddings[node.id] = doc.embedding
            else:
                self.embeddings[node.id] = self._generate_embedding(node.text)
    
    def add_node(self, node: Node):
        self.nodes[node.id] = node
        self.embeddings[node.id] = self._generate_embedding(node.text)
    
    def _generate_embedding(self, text: str) -> List[float]:
        import hashlib
        hash_val = int(hashlib.md5(text.encode()).hexdigest(), 16)
        embedding = []
        for i in range(768):
            embedding.append((hash_val >> (i * 8)) % 256 / 255.0)
        return embedding
    
    def query(self, query_text: str, top_k: int = 5) -> List[Tuple[Node, float]]:
        query_embedding = self._generate_embedding(query_text)
        
        scores = []
        for node_id, embedding in self.embeddings.items():
            if node_id in self.nodes:
                score = cosine_similarity([query_embedding], [embedding])[0][0]
                scores.append((self.nodes[node_id], float(score)))
        
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_k]
    
    def get_node(self, node_id: str) -> Optional[Node]:
        return self.nodes.get(node_id)
    
    def get_all_nodes(self) -> List[Node]:
        return list(self.nodes.values())
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'document_count': len(self.documents),
            'node_count': len(self.nodes),
            'documents': [doc.to_dict() for doc in self.documents.values()],
            'nodes': [node.to_dict() for node in self.nodes.values()]
        }

class TreeNode:
    def __init__(self, node_id: str, text: str, children: List['TreeNode'] = None):
        self.node_id = node_id
        self.text = text
        self.children = children or []
        self.embedding = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'node_id': self.node_id,
            'text': self.text,
            'children': [c.to_dict() for c in self.children]
        }

class TreeIndex:
    def __init__(self):
        self.root: Optional[TreeNode] = None
        self.all_nodes: Dict[str, TreeNode] = {}
        self.leaf_nodes: List[TreeNode] = []
    
    def build_from_nodes(self, nodes: List[Node], max_children_per_node: int = 3):
        leaf_treenodes = []
        for node in nodes:
            treenode = TreeNode(node_id=node.id, text=node.text)
            self.all_nodes[node.id] = treenode
            leaf_treenodes.append(treenode)
        
        self.leaf_nodes = leaf_treenodes
        
        if len(leaf_treenodes) <= max_children_per_node:
            self.root = TreeNode(node_id="root", text="Root", children=leaf_treenodes)
            for tn in leaf_treenodes:
                self.all_nodes[tn.node_id] = tn
            return
        
        current_level = leaf_treenodes
        level = 1
        
        while len(current_level) > 1:
            next_level = []
            
            for i in range(0, len(current_level), max_children_per_node):
                chunk = current_level[i:i + max_children_per_node]
                if len(chunk) == 0:
                    continue
                
                combined_text = "\n\n".join([c.text for c in chunk])
                parent_id = f"level_{level}_node_{len(next_level)}"
                parent_node = TreeNode(node_id=parent_id, text=combined_text[:200], children=chunk)
                next_level.append(parent_node)
                self.all_nodes[parent_id] = parent_node
            
            current_level = next_level
            level += 1
        
        self.root = current_level[0] if current_level else None
    
    def query(self, query_text: str, top_k: int = 3) -> List[str]:
        if not self.root:
            return []
        
        results = []
        
        def traverse(node: TreeNode, depth: int = 0):
            if query_text.lower() in node.text.lower():
                results.append((node.node_id, depth))
            
            for child in node.children:
                traverse(child, depth + 1)
        
        traverse(self.root)
        
        results.sort(key=lambda x: x[1])
        return [node_id for node_id, _ in results[:top_k]]
    
    def get_context(self, node_ids: List[str]) -> str:
        texts = []
        for nid in node_ids:
            if nid in self.all_nodes:
                texts.append(self.all_nodes[nid].text)
        return "\n\n".join(texts)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'root': self.root.to_dict() if self.root else None,
            'node_count': len(self.all_nodes),
            'leaf_count': len(self.leaf_nodes)
        }

class KeywordIndex:
    def __init__(self):
        self.keyword_to_nodes: Dict[str, List[str]] = {}
        self.nodes: Dict[str, Node] = {}
    
    def add_node(self, node: Node):
        self.nodes[node.id] = node
        
        words = node.text.lower().split()
        for word in words:
            if len(word) > 3:
                if word not in self.keyword_to_nodes:
                    self.keyword_to_nodes[word] = []
                self.keyword_to_nodes[word].append(node.id)
    
    def query(self, keywords: List[str], top_k: int = 5) -> List[Tuple[Node, int]]:
        node_scores: Dict[str, int] = {}
        
        for keyword in keywords:
            keyword_lower = keyword.lower()
            for word, node_ids in self.keyword_to_nodes.items():
                if keyword_lower in word:
                    for nid in node_ids:
                        node_scores[nid] = node_scores.get(nid, 0) + 1
        
        results = []
        for nid, score in node_scores.items():
            if nid in self.nodes:
                results.append((self.nodes[nid], score))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'keyword_count': len(self.keyword_to_nodes),
            'node_count': len(self.nodes)
        }
