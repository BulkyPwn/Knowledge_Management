from typing import List, Dict, Any, Optional, Tuple
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from .graph import KnowledgeGraph, Entity

class GraphRetriever:
    def __init__(self, knowledge_graph: KnowledgeGraph):
        self.kg = knowledge_graph
    
    def retrieve_by_keywords(self, keywords: List[str], top_k: int = 5) -> List[Tuple[Entity, float]]:
        scores = {}
        
        for entity in self.kg.entities.values():
            name_lower = entity.name.lower()
            score = 0.0
            
            for keyword in keywords:
                if keyword.lower() in name_lower:
                    score += 1.0
            
            if entity.description:
                for keyword in keywords:
                    if keyword.lower() in entity.description.lower():
                        score += 0.5
            
            if score > 0:
                scores[entity.id] = score
        
        results = []
        for eid, score in scores.items():
            if self.kg.entities[eid]:
                results.append((self.kg.entities[eid], score))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]
    
    def retrieve_by_embedding(self, query_embedding: List[float], top_k: int = 5) -> List[Tuple[Entity, float]]:
        results = []
        
        for entity in self.kg.entities.values():
            if entity.embedding:
                score = cosine_similarity([query_embedding], [entity.embedding])[0][0]
                results.append((entity, float(score)))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]
    
    def retrieve_subgraph(self, entity_ids: List[str], depth: int = 1) -> KnowledgeGraph:
        return self.kg.get_subgraph(entity_ids, depth)
    
    def retrieve_path(self, source_id: str, target_id: str, max_length: int = 3) -> List[List[str]]:
        if source_id not in self.kg.graph and target_id not in self.kg.graph:
            return []
        
        if source_id == target_id:
            return [[source_id]]
        
        paths = []
        queue = [(source_id, [source_id])]
        
        while queue:
            current, path = queue.pop(0)
            
            if len(path) > max_length:
                continue
            
            if current == target_id:
                paths.append(path)
                continue
            
            for neighbor in self.kg.graph.get(current, []):
                if neighbor not in path:
                    queue.append((neighbor, path + [neighbor]))
        
        return paths
    
    def retrieve_context(self, entity_ids: List[str], include_relations: bool = True) -> str:
        context_parts = []
        
        for eid in entity_ids:
            entity = self.kg.get_entity(eid)
            if entity:
                context_parts.append(f"## {entity.name} ({entity.entity_type})")
                context_parts.append(entity.description)
                
                if include_relations:
                    out_deg, in_deg = self.kg.get_entity_degree(eid)
                    context_parts.append(f"- 出度: {out_deg}, 入度: {in_deg}")
                    
                    neighbors = self.kg.get_neighbors(eid, depth=1)
                    neighbor_names = [self.kg.get_entity(n).name for n in neighbors if self.kg.get_entity(n)]
                    if neighbor_names:
                        context_parts.append(f"- 关联实体: {', '.join(neighbor_names)}")
                
                context_parts.append("")
        
        return "\n".join(context_parts)
    
    def retrieve_central_entities(self, top_k: int = 10) -> List[Tuple[Entity, float]]:
        centrality_scores = []
        
        for entity in self.kg.entities.values():
            out_deg, in_deg = self.kg.get_entity_degree(entity.id)
            centrality = out_deg + in_deg
            centrality_scores.append((entity, float(centrality)))
        
        centrality_scores.sort(key=lambda x: x[1], reverse=True)
        return centrality_scores[:top_k]
    
    def retrieve_by_type(self, entity_type: str, top_k: int = 10) -> List[Entity]:
        results = []
        for entity in self.kg.entities.values():
            if entity.entity_type == entity_type:
                results.append(entity)
        return results[:top_k]
