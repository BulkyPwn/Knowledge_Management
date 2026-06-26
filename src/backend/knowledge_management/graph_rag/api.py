from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
from datetime import datetime
from graph_rag import GraphRAG, GraphRAGConfig

app = Flask(__name__)
CORS(app)

graph_rag = GraphRAG()
config = GraphRAGConfig()

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'success': True,
        'data': {
            'max_context_length': config.max_context_length,
            'retrieval_top_k': config.retrieval_top_k,
            'subgraph_depth': config.subgraph_depth,
            'model_name': config.model_name,
            'enable_relationship_reasoning': config.enable_relationship_reasoning,
            'enable_entity_merging': config.enable_entity_merging
        }
    })

@app.route('/api/config', methods=['PUT'])
def update_config():
    data = request.get_json()
    if 'max_context_length' in data:
        config.max_context_length = data['max_context_length']
    if 'retrieval_top_k' in data:
        config.retrieval_top_k = data['retrieval_top_k']
    if 'subgraph_depth' in data:
        config.subgraph_depth = data['subgraph_depth']
    if 'model_name' in data:
        config.model_name = data['model_name']
    if 'enable_relationship_reasoning' in data:
        config.enable_relationship_reasoning = data['enable_relationship_reasoning']
    if 'enable_entity_merging' in data:
        config.enable_entity_merging = data['enable_entity_merging']
    return jsonify({'success': True, 'message': '配置更新成功'})

@app.route('/api/documents', methods=['POST'])
def add_document():
    data = request.get_json()
    doc_id = data.get('doc_id', f"doc_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    content = data.get('content')
    metadata = data.get('metadata', {})
    
    if not content:
        return jsonify({'success': False, 'message': '内容不能为空'}), 400
    
    graph_rag.add_document(doc_id, content, metadata)
    
    return jsonify({
        'success': True,
        'message': '文档添加成功',
        'doc_id': doc_id,
        'document_count': len(graph_rag.documents)
    })

@app.route('/api/documents', methods=['GET'])
def list_documents():
    docs = []
    for doc_id, doc in graph_rag.documents.items():
        docs.append({
            'doc_id': doc_id,
            'metadata': doc['metadata'],
            'created_at': doc['created_at']
        })
    return jsonify({'success': True, 'data': docs, 'total': len(docs)})

@app.route('/api/documents/<string:doc_id>', methods=['DELETE'])
def delete_document(doc_id):
    if doc_id not in graph_rag.documents:
        return jsonify({'success': False, 'message': '文档不存在'}), 404
    
    del graph_rag.documents[doc_id]
    return jsonify({'success': True, 'message': '文档删除成功'})

@app.route('/api/query', methods=['POST'])
def query():
    data = request.get_json()
    question = data.get('question')
    
    if not question:
        return jsonify({'success': False, 'message': '问题不能为空'}), 400
    
    result = graph_rag.query(question, max_context_length=config.max_context_length)
    
    return jsonify({'success': True, 'data': result})

@app.route('/api/graph', methods=['GET'])
def get_graph():
    stats = graph_rag.get_graph_stats()
    kg_data = graph_rag.kg.to_dict()
    
    return jsonify({
        'success': True,
        'data': {
            'stats': stats,
            'entities': kg_data['entities'],
            'relations': kg_data['relations']
        }
    })

@app.route('/api/graph/stats', methods=['GET'])
def get_graph_stats():
    stats = graph_rag.get_graph_stats()
    return jsonify({'success': True, 'data': stats})

@app.route('/api/entities', methods=['GET'])
def list_entities():
    entity_type = request.args.get('type')
    top_k = int(request.args.get('top_k', 100))
    
    if entity_type:
        entities = graph_rag.retriever.retrieve_by_type(entity_type, top_k)
    else:
        entities = list(graph_rag.kg.entities.values())[:top_k]
    
    return jsonify({
        'success': True,
        'data': [e.to_dict() for e in entities],
        'total': len(entities)
    })

@app.route('/api/entities/<string:entity_id>', methods=['GET'])
def get_entity(entity_id):
    entity = graph_rag.kg.get_entity(entity_id)
    if not entity:
        return jsonify({'success': False, 'message': '实体不存在'}), 404
    
    neighbors = graph_rag.kg.get_neighbors(entity_id, depth=1)
    neighbor_entities = [graph_rag.kg.get_entity(n).to_dict() for n in neighbors if graph_rag.kg.get_entity(n)]
    
    return jsonify({
        'success': True,
        'data': {
            'entity': entity.to_dict(),
            'neighbors': neighbor_entities
        }
    })

@app.route('/api/relations', methods=['GET'])
def list_relations():
    relations = [r.to_dict() for r in graph_rag.kg.relations.values()]
    return jsonify({'success': True, 'data': relations, 'total': len(relations)})

@app.route('/api/subgraph', methods=['POST'])
def get_subgraph():
    data = request.get_json()
    entity_ids = data.get('entity_ids', [])
    depth = data.get('depth', 1)
    
    if not entity_ids:
        return jsonify({'success': False, 'message': '实体ID列表不能为空'}), 400
    
    subgraph = graph_rag.retriever.retrieve_subgraph(entity_ids, depth)
    
    return jsonify({
        'success': True,
        'data': subgraph.to_dict()
    })

@app.route('/api/path', methods=['POST'])
def find_path():
    data = request.get_json()
    source_id = data.get('source_id')
    target_id = data.get('target_id')
    max_length = data.get('max_length', 3)
    
    if not source_id or not target_id:
        return jsonify({'success': False, 'message': '源实体ID和目标实体ID不能为空'}), 400
    
    paths = graph_rag.retriever.retrieve_path(source_id, target_id, max_length)
    
    return jsonify({
        'success': True,
        'data': {
            'paths': paths,
            'count': len(paths)
        }
    })

@app.route('/api/save', methods=['POST'])
def save_state():
    data = request.get_json()
    filename = data.get('filename', f'graph_rag_state_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    filepath = os.path.join(DATA_DIR, filename)
    
    graph_rag.save_state(filepath)
    
    return jsonify({'success': True, 'message': f'状态已保存到 {filename}'})

@app.route('/api/load', methods=['POST'])
def load_state():
    data = request.get_json()
    filename = data.get('filename')
    
    if not filename:
        return jsonify({'success': False, 'message': '文件名不能为空'}), 400
    
    filepath = os.path.join(DATA_DIR, filename)
    
    try:
        graph_rag.load_state(filepath)
        return jsonify({
            'success': True,
            'message': '状态加载成功',
            'document_count': len(graph_rag.documents)
        })
    except FileNotFoundError:
        return jsonify({'success': False, 'message': '文件不存在'}), 404

@app.route('/api/data/list', methods=['GET'])
def list_saved_states():
    files = []
    for item in os.listdir(DATA_DIR):
        if item.endswith('.json'):
            filepath = os.path.join(DATA_DIR, item)
            files.append({
                'filename': item,
                'size': os.path.getsize(filepath),
                'modified_at': datetime.fromtimestamp(os.path.getmtime(filepath)).isoformat()
            })
    return jsonify({'success': True, 'data': files})

@app.route('/api/clear', methods=['POST'])
def clear_all():
    graph_rag.kg = KnowledgeGraph()
    graph_rag.documents = {}
    graph_rag.retriever = GraphRetriever(graph_rag.kg)
    return jsonify({'success': True, 'message': '所有数据已清空'})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5003)
