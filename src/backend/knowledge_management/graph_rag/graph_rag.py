from typing import List, Dict, Any, Optional
import json
import os
from datetime import datetime
from .graph import KnowledgeGraph, Entity, Relation
from .extractor import GraphExtractor
from .retriever import GraphRetriever

class GraphRAG:
    def __init__(self, model_name: str = "gpt-4o-mini"):
        self.kg = KnowledgeGraph()
        self.extractor = GraphExtractor()
        self.retriever = GraphRetriever(self.kg)
        self.model_name = model_name
        self.documents = {}
    
    def add_document(self, doc_id: str, content: str, metadata: Optional[Dict[str, Any]] = None):
        self.documents[doc_id] = {
            'content': content,
            'metadata': metadata or {},
            'created_at': datetime.now().isoformat()
        }
        
        graph = self.extractor.extract(content, doc_id)
        
        for entity in graph.entities.values():
            entity.id = f"{doc_id}_{entity.id}"
            self.kg.add_entity(entity)
        
        for relation in graph.relations.values():
            relation.id = f"{doc_id}_{relation.id}"
            source_ids = [e.id for e in self.kg.entities.values() if e.name == relation.source_id]
            target_ids = [e.id for e in self.kg.entities.values() if e.name == relation.target_id]
            
            if source_ids and target_ids:
                relation.source_id = source_ids[0]
                relation.target_id = target_ids[0]
                self.kg.add_relation(relation)
    
    def query(self, question: str, max_context_length: int = 4096) -> Dict[str, Any]:
        keywords = self._extract_keywords(question)
        
        keyword_results = self.retriever.retrieve_by_keywords(keywords, top_k=5)
        entity_ids = [e.id for e, _ in keyword_results]
        
        if not entity_ids and self.kg.entities:
            central = self.retriever.retrieve_central_entities(top_k=3)
            entity_ids = [e.id for e, _ in central]
        
        subgraph = self.retriever.retrieve_subgraph(entity_ids, depth=1)
        
        context = self.retriever.retrieve_context(entity_ids, include_relations=True)
        
        if len(context) > max_context_length:
            context = context[:max_context_length] + "\n\n...(上下文过长，已截断)"
        
        answer = self._generate_answer(question, context)
        
        return {
            'question': question,
            'answer': answer,
            'retrieved_entities': [e.to_dict() for e, _ in keyword_results],
            'context': context,
            'context_length': len(context)
        }
    
    def _extract_keywords(self, text: str) -> List[str]:
        import re
        words = re.findall(r'\b[a-zA-Z]{4,}\b', text.lower())
        stop_words = {'what', 'which', 'where', 'when', 'how', 'that', 'this', 'from', 'with', 'have', 'been', 'were', 'they', 'their'}
        keywords = [w for w in words if w not in stop_words]
        return keywords[:5]
    
    def _generate_answer(self, question: str, context: str) -> str:
        prompt = f"""基于以下知识图谱上下文回答问题：

上下文：
{context}

问题：{question}

请提供详细的回答，如果上下文没有相关信息，请说明。
"""
        
        if not context.strip():
            return "知识库中暂无相关信息。"
        
        return f"根据知识图谱内容，关于问题 '{question}' 的回答是：\n\n这是一个模拟的 GraphRAG 回答。实际应用中，这里会调用真实的 LLM 模型进行推理生成。\n\n参考的上下文中包含 {context.count('##')} 个相关实体节点。"
    
    def get_graph_stats(self) -> Dict[str, Any]:
        entity_types = {}
        for entity in self.kg.entities.values():
            if entity.entity_type not in entity_types:
                entity_types[entity.entity_type] = 0
            entity_types[entity.entity_type] += 1
        
        relation_types = {}
        for relation in self.kg.relations.values():
            if relation.relation_type not in relation_types:
                relation_types[relation.relation_type] = 0
            relation_types[relation.relation_type] += 1
        
        return {
            'document_count': len(self.documents),
            'entity_count': len(self.kg.entities),
            'relation_count': len(self.kg.relations),
            'entity_types': entity_types,
            'relation_types': relation_types
        }
    
    def save_state(self, filepath: str):
        state = {
            'documents': self.documents,
            'model_name': self.model_name,
            'saved_at': datetime.now().isoformat()
        }
        
        kg_path = filepath.replace('.json', '_kg.json')
        self.kg.save(kg_path)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    
    def load_state(self, filepath: str):
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"文件不存在: {filepath}")
        
        with open(filepath, 'r', encoding='utf-8') as f:
            state = json.load(f)
        
        self.documents = state.get('documents', {})
        self.model_name = state.get('model_name', 'gpt-4o-mini')
        
        kg_path = filepath.replace('.json', '_kg.json')
        if os.path.exists(kg_path):
            self.kg.load(kg_path)
            self.retriever = GraphRetriever(self.kg)

class GraphRAGConfig:
    def __init__(self):
        self.max_context_length = 4096
        self.retrieval_top_k = 5
        self.subgraph_depth = 1
        self.model_name = "gpt-4o-mini"
        self.enable_relationship_reasoning = True
        self.enable_entity_merging = True
