from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
from datetime import datetime
from ..models.raptor import RAPTOR, RAPTORConfig

app = Flask(__name__)
CORS(app)

raptor = RAPTOR()
config = RAPTORConfig()

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
os.makedirs(DATA_DIR, exist_ok=True)

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'success': True,
        'data': {
            'max_levels': config.max_levels,
            'max_context_length': config.max_context_length,
            'retrieval_k': config.retrieval_k,
            'model_name': config.model_name,
            'enable_tree_reasoning': config.enable_tree_reasoning
        }
    })

@app.route('/api/config', methods=['PUT'])
def update_config():
    data = request.get_json()
    if 'max_levels' in data:
        config.max_levels = data['max_levels']
    if 'max_context_length' in data:
        config.max_context_length = data['max_context_length']
    if 'retrieval_k' in data:
        config.retrieval_k = data['retrieval_k']
    if 'model_name' in data:
        config.model_name = data['model_name']
    if 'enable_tree_reasoning' in data:
        config.enable_tree_reasoning = data['enable_tree_reasoning']
    return jsonify({'success': True, 'message': '配置更新成功'})

@app.route('/api/documents', methods=['POST'])
def ingest_document():
    data = request.get_json()
    content = data.get('content')
    metadata = data.get('metadata', {})
    
    if not content:
        return jsonify({'success': False, 'message': '内容不能为空'}), 400
    
    raptor.ingest_document(content, metadata)
    return jsonify({'success': True, 'message': '文档添加成功', 'document_count': len(raptor.documents)})

@app.route('/api/documents/batch', methods=['POST'])
def ingest_batch():
    data = request.get_json()
    documents = data.get('documents', [])
    
    if not documents:
        return jsonify({'success': False, 'message': '文档列表不能为空'}), 400
    
    for doc in documents:
        content = doc.get('content')
        metadata = doc.get('metadata', {})
        if content:
            raptor.ingest_document(content, metadata)
    
    return jsonify({'success': True, 'message': f'批量添加成功，共添加 {len(documents)} 个文档', 'document_count': len(raptor.documents)})

@app.route('/api/documents', methods=['GET'])
def list_documents():
    docs = []
    for i, doc in enumerate(raptor.documents):
        docs.append({
            'id': doc['id'],
            'content_preview': doc['content'][:200] + '...' if len(doc['content']) > 200 else doc['content'],
            'metadata': doc['metadata'],
            'created_at': doc.get('created_at')
        })
    return jsonify({'success': True, 'data': docs, 'total': len(docs)})

@app.route('/api/documents/<string:doc_id>', methods=['GET'])
def get_document(doc_id):
    doc = next((d for d in raptor.documents if d['id'] == doc_id), None)
    if not doc:
        return jsonify({'success': False, 'message': '文档不存在'}), 404
    return jsonify({'success': True, 'data': doc})

@app.route('/api/documents/<string:doc_id>', methods=['DELETE'])
def delete_document(doc_id):
    index = next((i for i, d in enumerate(raptor.documents) if d['id'] == doc_id), None)
    if index is None:
        return jsonify({'success': False, 'message': '文档不存在'}), 404
    
    del raptor.documents[index]
    return jsonify({'success': True, 'message': '文档删除成功'})

@app.route('/api/build', methods=['POST'])
def build_hierarchy():
    if not raptor.documents:
        return jsonify({'success': False, 'message': '没有文档需要构建层次结构'}), 400
    
    raptor.build_hierarchy(max_levels=config.max_levels)
    summary = raptor.get_tree_summary()
    
    return jsonify({
        'success': True,
        'message': '层次结构构建成功',
        'summary': summary
    })

@app.route('/api/query', methods=['POST'])
def query():
    data = request.get_json()
    question = data.get('question')
    
    if not question:
        return jsonify({'success': False, 'message': '问题不能为空'}), 400
    
    result = raptor.query(question, max_context_length=config.max_context_length)
    
    return jsonify({
        'success': True,
        'data': result
    })

@app.route('/api/tree', methods=['GET'])
def get_tree():
    summary = raptor.get_tree_summary()
    return jsonify({'success': True, 'data': summary})

@app.route('/api/save', methods=['POST'])
def save_state():
    data = request.get_json()
    filename = data.get('filename', f'raptor_state_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    filepath = os.path.join(DATA_DIR, filename)
    
    raptor.save_state(filepath)
    return jsonify({'success': True, 'message': f'状态已保存到 {filename}'})

@app.route('/api/load', methods=['POST'])
def load_state():
    data = request.get_json()
    filename = data.get('filename')
    
    if not filename:
        return jsonify({'success': False, 'message': '文件名不能为空'}), 400
    
    filepath = os.path.join(DATA_DIR, filename)
    
    try:
        raptor.load_state(filepath)
        return jsonify({'success': True, 'message': f'状态加载成功', 'document_count': len(raptor.documents)})
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
    raptor.documents = []
    raptor.retriever = type(raptor.retriever)()
    raptor.tree = type(raptor.tree)()
    return jsonify({'success': True, 'message': '所有数据已清空'})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5002)
