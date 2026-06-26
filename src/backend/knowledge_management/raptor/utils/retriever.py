from typing import List, Dict, Any, Optional, Tuple
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from .tree_structure import TreeNode, TreeStructure

class HierarchicalRetriever:
    def __init__(self):
        self.tree = TreeStructure()
    
    def build_tree(self, documents: List[Dict[str, Any]], max_levels: int = 3):
        leaf_nodes = []
        for i, doc in enumerate(documents):
            node = TreeNode(
                node_id=f"doc_{i}",
                content=doc['content'],
                embedding=doc.get('embedding'),
                level=max_levels,
                metadata=doc.get('metadata', {})
            )
            leaf_nodes.append(node)
            self.tree.add_node(node)
        
        self._build_hierarchy(leaf_nodes, max_levels - 1)
    
    def _build_hierarchy(self, nodes: List[TreeNode], level: int):
        if level < 0 or len(nodes) == 0:
            return
        
        chunk_size = 3
        parent_nodes = []
        
        for i in range(0, len(nodes), chunk_size):
            chunk = nodes[i:i + chunk_size]
            merged_content = "\n\n".join([n.content for n in chunk])
            merged_embedding = self._merge_embeddings([n.embedding for n in chunk if n.embedding])
            
            parent_node = TreeNode(
                node_id=f"level_{level}_chunk_{i//chunk_size}",
                content=merged_content,
                embedding=merged_embedding,
                level=level
            )
            parent_nodes.append(parent_node)
            
            for child in chunk:
                self.tree.add_node(child, parent_node.node_id)
        
        self._build_hierarchy(parent_nodes, level - 1)
    
    def _merge_embeddings(self, embeddings: List[List[float]]) -> Optional[List[float]]:
        if not embeddings:
            return None
        return list(np.mean(embeddings, axis=0))
    
    def retrieve(self, query_embedding: List[float], k: int = 5, level: Optional[int] = None) -> List[Tuple[TreeNode, float]]:
        if level is None:
            return self._multi_level_retrieve(query_embedding, k)
        
        nodes = self.tree.get_nodes_by_level(level)
        if not nodes:
            return []
        
        scores = []
        for node in nodes:
            if node.embedding:
                score = cosine_similarity([query_embedding], [node.embedding])[0][0]
                scores.append((node, score))
        
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:k]
    
    def _multi_level_retrieve(self, query_embedding: List[float], k: int) -> List[Tuple[TreeNode, float]]:
        results = []
        
        for level in range(0, 4):
            level_results = self.retrieve(query_embedding, k=k, level=level)
            results.extend(level_results)
        
        results.sort(key=lambda x: x[1], reverse=True)
        unique_results = []
        seen_ids = set()
        
        for node, score in results:
            if node.node_id not in seen_ids:
                seen_ids.add(node.node_id)
                unique_results.append((node, score))
                if len(unique_results) == k:
                    break
        
        return unique_results
    
    def get_context(self, node_ids: List[str]) -> str:
        context_parts = []
        for node_id in node_ids:
            node = self.tree.get_node(node_id)
            if node:
                context_parts.append(node.content)
        return "\n\n".join(context_parts)
