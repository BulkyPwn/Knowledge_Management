from typing import List, Dict, Any, Optional
from .document import Document, Node
from .index import VectorIndex, TreeIndex, KeywordIndex

class QueryEngine:
    def __init__(self, vector_index: VectorIndex, tree_index: Optional[TreeIndex] = None, keyword_index: Optional[KeywordIndex] = None):
        self.vector_index = vector_index
        self.tree_index = tree_index
        self.keyword_index = keyword_index
    
    def query(self, question: str, mode: str = "vector", top_k: int = 5) -> Dict[str, Any]:
        if mode == "vector":
            return self._vector_query(question, top_k)
        elif mode == "tree":
            return self._tree_query(question, top_k)
        elif mode == "keyword":
            return self._keyword_query(question, top_k)
        elif mode == "hybrid":
            return self._hybrid_query(question, top_k)
        else:
            return {"error": f"Unknown query mode: {mode}"}
    
    def _vector_query(self, question: str, top_k: int) -> Dict[str, Any]:
        results = self.vector_index.query(question, top_k)
        
        nodes = [node for node, score in results]
        context = "\n\n".join([n.text for n in nodes])
        answer = self._generate_answer(question, context)
        
        return {
            'question': question,
            'answer': answer,
            'mode': 'vector',
            'results': [{'node_id': n.id, 'text': n.text, 'score': s} for n, s in results],
            'context_length': len(context)
        }
    
    def _tree_query(self, question: str, top_k: int) -> Dict[str, Any]:
        if not self.tree_index:
            return {'error': 'Tree index not available'}
        
        node_ids = self.tree_index.query(question, top_k)
        context = self.tree_index.get_context(node_ids)
        answer = self._generate_answer(question, context)
        
        return {
            'question': question,
            'answer': answer,
            'mode': 'tree',
            'retrieved_nodes': node_ids,
            'context_length': len(context)
        }
    
    def _keyword_query(self, question: str, top_k: int) -> Dict[str, Any]:
        if not self.keyword_index:
            return {'error': 'Keyword index not available'}
        
        keywords = question.split()
        results = self.keyword_index.query(keywords, top_k)
        
        nodes = [node for node, score in results]
        context = "\n\n".join([n.text for n in nodes])
        answer = self._generate_answer(question, context)
        
        return {
            'question': question,
            'answer': answer,
            'mode': 'keyword',
            'results': [{'node_id': n.id, 'text': n.text, 'score': s} for n, s in results],
            'context_length': len(context)
        }
    
    def _hybrid_query(self, question: str, top_k: int) -> Dict[str, Any]:
        vector_results = self.vector_index.query(question, top_k)
        
        all_node_ids = set()
        scores: Dict[str, float] = {}
        
        for node, score in vector_results:
            all_node_ids.add(node.id)
            scores[node.id] = score * 0.6
        
        if self.keyword_index:
            keywords = question.split()
            kw_results = self.keyword_index.query(keywords, top_k)
            for node, score in kw_results:
                all_node_ids.add(node.id)
                scores[node.id] = scores.get(node.id, 0) + score * 0.4
        
        sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)[:top_k]
        
        context_parts = []
        for nid in sorted_ids:
            node = self.vector_index.get_node(nid)
            if node:
                context_parts.append(node.text)
        
        context = "\n\n".join(context_parts)
        answer = self._generate_answer(question, context)
        
        return {
            'question': question,
            'answer': answer,
            'mode': 'hybrid',
            'results': [{'node_id': nid, 'score': scores[nid]} for nid in sorted_ids],
            'context_length': len(context)
        }
    
    def _generate_answer(self, question: str, context: str) -> str:
        if not context.strip():
            return "知识库中暂无相关信息。"
        
        return f"根据索引内容，关于问题 '{question}' 的回答是：\n\n这是一个模拟的 LlamaIndex 回答。实际应用中，这里会调用真实的 LLM 模型进行推理生成。\n\n参考的上下文中包含 {context.count('---') + 1} 个相关节点。"

class RetrieverQueryEngine:
    def __init__(self):
        self.retrievers = []
    
    def add_retriever(self, retriever, weight: float = 1.0):
        self.retrievers.append({'retriever': retriever, 'weight': weight})
    
    def query(self, question: str, top_k: int = 5) -> Dict[str, Any]:
        all_results = []
        
        for retriever_info in self.retrievers:
            retriever = retriever_info['retriever']
            weight = retriever_info['weight']
            
            if hasattr(retriever, 'query'):
                results = retriever.query(question, top_k)
                for node, score in results:
                    all_results.append({
                        'node': node,
                        'score': score * weight,
                        'source': retriever.__class__.__name__
                    })
        
        all_results.sort(key=lambda x: x['score'], reverse=True)
        
        top_results = all_results[:top_k]
        context = "\n\n".join([r['node'].text for r in top_results])
        
        return {
            'question': question,
            'results': [{'node_id': r['node'].id, 'score': r['score'], 'source': r['source']} for r in top_results],
            'context': context
        }
