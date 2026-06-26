from typing import List, Dict, Any, Optional, Tuple
import re
import hashlib
from .graph import Entity, Relation, KnowledgeGraph

class EntityExtractor:
    def __init__(self):
        self.entity_templates = {
            'PERSON': r'\b([A-Z][a-z]+ [A-Z][a-z]+)\b',
            'ORGANIZATION': r'\b([A-Z][a-z]*(?:Company|Corp|Inc|Ltd|University|Institute))\b',
            'LOCATION': r'\b([A-Z][a-z]+(?: City|Country|Region|Area))\b',
            'TECHNOLOGY': r'\b([A-Z][a-z]+(?:Net|ML|AI|LLM|GPT|Transformer))\b',
            'CONCEPT': r'\b([A-Z][a-z]+(?:ism|tion|ing|ness))\b'
        }
    
    def extract_entities(self, text: str) -> List[Dict[str, Any]]:
        entities = []
        seen = set()
        
        for entity_type, pattern in self.entity_templates.items():
            matches = re.findall(pattern, text)
            for match in matches:
                if match not in seen:
                    seen.add(match)
                    entity_id = self._generate_id(match)
                    entities.append({
                        'id': entity_id,
                        'name': match,
                        'type': entity_type,
                        'description': self._generate_description(match, entity_type, text)
                    })
        
        return entities
    
    def _generate_id(self, name: str) -> str:
        return hashlib.md5(name.encode()).hexdigest()[:12]
    
    def _generate_description(self, name: str, entity_type: str, context: str) -> str:
        sentences = context.split('.')
        relevant = [s for s in sentences if name.lower() in s.lower()]
        if relevant:
            return relevant[0].strip()[:200]
        return f"{entity_type}: {name}"

class RelationExtractor:
    def __init__(self):
        self.relation_patterns = [
            (r'(\w+)\s+is\s+a\s+(\w+)', 'IS_A'),
            (r'(\w+)\s+works?\s+(?:for|at)\s+(\w+)', 'WORKS_AT'),
            (r'(\w+)\s+developed\s+(\w+)', 'DEVELOPED'),
            (r'(\w+)\s+is\s+related\s+to\s+(\w+)', 'RELATED_TO'),
            (r'(\w+)\s+uses?\s+(\w+)', 'USES'),
            (r'(\w+)\s+belongs?\s+to\s+(\w+)', 'BELONGS_TO'),
            (r'(\w+)\s+part\s+of\s+(\w+)', 'PART_OF'),
            (r'(\w+)\s+located\s+in\s+(\w+)', 'LOCATED_IN'),
            (r'(\w+)\s+founded\s+(?:by\s+)?(\w+)', 'FOUNDED_BY'),
        ]
    
    def extract_relations(self, text: str, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        relations = []
        entity_names = {e['name'] for e in entities}
        
        for pattern, rel_type in self.relation_patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            for match in matches:
                if len(match) == 2:
                    source, target = match
                    if source in entity_names and target in entity_names:
                        relation_id = self._generate_id(source, target, rel_type)
                        relations.append({
                            'id': relation_id,
                            'source': source,
                            'target': target,
                            'type': rel_type,
                            'weight': 1.0
                        })
        
        return relations
    
    def _generate_id(self, source: str, target: str, rel_type: str) -> str:
        content = f"{source}:{target}:{rel_type}"
        return hashlib.md5(content.encode()).hexdigest()[:12]

class GraphExtractor:
    def __init__(self):
        self.entity_extractor = EntityExtractor()
        self.relation_extractor = RelationExtractor()
    
    def extract(self, text: str, doc_id: str = "") -> KnowledgeGraph:
        kg = KnowledgeGraph()
        
        entities = self.entity_extractor.extract_entities(text)
        for e_data in entities:
            entity = Entity(
                id=f"{doc_id}_{e_data['id']}" if doc_id else e_data['id'],
                name=e_data['name'],
                entity_type=e_data['type'],
                description=e_data['description']
            )
            kg.add_entity(entity)
        
        relations = self.relation_extractor.extract_relations(text, entities)
        for r_data in relations:
            source_ids = [e.id for e in kg.entities.values() if e.name == r_data['source']]
            target_ids = [e.id for e in kg.entities.values() if e.name == r_data['target']]
            
            if source_ids and target_ids:
                relation = Relation(
                    id=r_data['id'],
                    source_id=source_ids[0],
                    target_id=target_ids[0],
                    relation_type=r_data['type'],
                    weight=r_data['weight']
                )
                kg.add_relation(relation)
        
        return kg
    
    def merge_graphs(self, graphs: List[KnowledgeGraph]) -> KnowledgeGraph:
        merged = KnowledgeGraph()
        
        for graph in graphs:
            for entity in graph.entities.values():
                if entity.id not in merged.entities:
                    merged.add_entity(entity)
            
            for relation in graph.relations.values():
                if relation.id not in merged.relations:
                    merged.add_relation(relation)
        
        return merged
