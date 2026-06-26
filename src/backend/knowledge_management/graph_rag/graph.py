from typing import List, Dict, Any, Optional, Set, Tuple
from dataclasses import dataclass, field
from collections import defaultdict
import json
from datetime import datetime

@dataclass
class Entity:
    id: str
    name: str
    entity_type: str
    description: str = ""
    properties: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'name': self.name,
            'type': self.entity_type,
            'description': self.description,
            'properties': self.properties
        }

@dataclass
class Relation:
    id: str
    source_id: str
    target_id: str
    relation_type: str
    weight: float = 1.0
    properties: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'source': self.source_id,
            'target': self.target_id,
            'type': self.relation_type,
            'weight': self.weight,
            'properties': self.properties
        }

class KnowledgeGraph:
    def __init__(self):
        self.entities: Dict[str, Entity] = {}
        self.relations: Dict[str, Relation] = {}
        self.entity_index: Dict[str, List[str]] = defaultdict(list)
        self.relation_index: Dict[str, List[str]] = defaultdict(list)
        self.graph: Dict[str, List[str]] = defaultdict(list)
        self_reverse_graph: Dict[str, List[str]] = defaultdict(list)
    
    def add_entity(self, entity: Entity) -> str:
        self.entities[entity.id] = entity
        self.entity_index[entity.name.lower()].append(entity.id)
        self.entity_index[entity.entity_type].append(entity.id)
        return entity.id
    
    def add_relation(self, relation: Relation) -> str:
        self.relations[relation.id] = relation
        self.relation_index[relation.relation_type].append(relation.id)
        
        self.graph[relation.source_id].append(relation.target_id)
        self_reverse_graph[relation.target_id].append(relation.source_id)
        
        return relation.id
    
    def get_entity(self, entity_id: str) -> Optional[Entity]:
        return self.entities.get(entity_id)
    
    def get_neighbors(self, entity_id: str, depth: int = 1) -> Set[str]:
        neighbors = set()
        current_level = {entity_id}
        
        for _ in range(depth):
            next_level = set()
            for eid in current_level:
                next_level.update(self.graph.get(eid, []))
                next_level.update(self_reverse_graph.get(eid, []))
            neighbors.update(next_level)
            current_level = next_level - neighbors
        
        return neighbors
    
    def get_subgraph(self, entity_ids: List[str], depth: int = 1) -> 'KnowledgeGraph':
        subgraph = KnowledgeGraph()
        entities_to_add = set(entity_ids)
        
        for eid in entity_ids:
            entities_to_add.update(self.get_neighbors(eid, depth))
        
        for eid in entities_to_add:
            if eid in self.entities:
                subgraph.add_entity(self.entities[eid])
        
        for rid, rel in self.relations.items():
            if rel.source_id in entities_to_add and rel.target_id in entities_to_add:
                subgraph.add_relation(rel)
        
        return subgraph
    
    def search_entities(self, query: str) -> List[Entity]:
        query_lower = query.lower()
        results = []
        
        for name, ids in self.entity_index.items():
            if query_lower in name:
                for eid in ids:
                    if eid in self.entities:
                        results.append(self.entities[eid])
        
        return results
    
    def get_entity_degree(self, entity_id: str) -> Tuple[int, int]:
        out_degree = len(self.graph.get(entity_id, []))
        in_degree = len(self_reverse_graph.get(entity_id, []))
        return out_degree, in_degree
    
    def get_all_types(self) -> Dict[str, List[str]]:
        types = defaultdict(list)
        for entity in self.entities.values():
            types[entity.entity_type].append(entity.id)
        return dict(types)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'entities': [e.to_dict() for e in self.entities.values()],
            'relations': [r.to_dict() for r in self.relations.values()],
            'stats': {
                'entity_count': len(self.entities),
                'relation_count': len(self.relations),
                'types': self.get_all_types()
            }
        }
    
    def save(self, filepath: str):
        data = {
            'entities': [
                {**e.to_dict(), 'embedding': e.embedding} 
                for e in self.entities.values()
            ],
            'relations': [r.to_dict() for r in self.relations.values()],
            'saved_at': datetime.now().isoformat()
        }
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    
    def load(self, filepath: str):
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        self.entities.clear()
        self.relations.clear()
        self.entity_index.clear()
        self.relation_index.clear()
        self.graph.clear()
        self_reverse_graph.clear()
        
        for e_data in data.get('entities', []):
            embedding = e_data.pop('embedding', None)
            entity = Entity(**e_data)
            entity.embedding = embedding
            self.add_entity(entity)
        
        for r_data in data.get('relations', []):
            relation = Relation(**r_data)
            self.add_relation(relation)
