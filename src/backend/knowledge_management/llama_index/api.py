from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
from datetime import datetime
from llama_index import LlamaIndex, LlamaIndexConfig

app = Flask(__name__)
CORS(app)

llama_index = LlamaIndex()
config = LlamaIndexConfig()

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'success': True,
        'data': {
            'chunk_size': config.chunk_size,
            'chunk_overlap': config.chunk_overlap,
            'tree_max_children': config.tree_max_children,
            'default_top_k': config.default_top_k,
            'default_mode': config.default_mode
        }
    })

@app.route('/api/config', methods=['PUT'])
def update_config():
    data = request.get_json()
    if 'chunk_size' in data:
        config.chunk_size = data['chunk_size']
    if 'chunk_overlap' in data:
        config.chunk_overlap = data['chunk_overlap']
    if 'tree_max_children' in data:
        config.tree_max_children = data['tree_max_children']
    if 'default_top_k' in data:
        config.default_top_k = data['default_top_k']
    if 'default_mode' in data:
        config.default_mode = data['default_mode']
    return jsonify({'success': True, 'message': 'Configuration updated successfully'})

@app.route('/api/documents', methods=['POST'])
def add_document():
    data = request.get_json()
    doc_id = data.get('doc_id', f"doc_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    text = data.get('text')
    metadata = data.get('metadata', {})
    
    if not text:
        return jsonify({'success': False, 'message': 'Text content cannot be empty'}), 400
    
    llama_index.add_document(doc_id, text, metadata)
    
    return jsonify({
        'success': True,
        'message': 'Document added successfully',
        'doc_id': doc_id,
        'document_count': len(llama_index.documents)
    })

@app.route('/api/documents', methods=['GET'])
def list_documents():
    docs = []
    for doc_id, doc in llama_index.documents.items():
        docs.append(doc.to_dict())
    return jsonify({'success': True, 'data': docs, 'total': len(docs)})

@app.route('/api/documents/<string:doc_id>', methods=['GET'])
def get_document(doc_id):
    if doc_id not in llama_index.documents:
        return jsonify({'success': False, 'message': 'Document not found'}), 404
    
    doc = llama_index.documents[doc_id]
    return jsonify({'success': True, 'data': doc.to_dict()})

@app.route('/api/documents/<string:doc_id>', methods=['DELETE'])
def delete_document(doc_id):
    if doc_id not in llama_index.documents:
        return jsonify({'success': False, 'message': 'Document not found'}), 404
    
    del llama_index.documents[doc_id]
    llama_index.is_built = False
    
    return jsonify({'success': True, 'message': 'Document deleted successfully'})

@app.route('/api/build', methods=['POST'])
def build_index():
    data = request.get_json() or {}
    tree_max_children = data.get('tree_max_children', config.tree_max_children)
    
    llama_index.build(tree_max_children=tree_max_children)
    summary = llama_index.get_index_summary()
    
    return jsonify({
        'success': True,
        'message': 'Index built successfully',
        'summary': summary
    })

@app.route('/api/query', methods=['POST'])
def query():
    data = request.get_json()
    question = data.get('question')
    mode = data.get('mode', config.default_mode)
    top_k = data.get('top_k', config.default_top_k)
    
    if not question:
        return jsonify({'success': False, 'message': 'Question cannot be empty'}), 400
    
    result = llama_index.query(question, mode, top_k)
    
    return jsonify({'success': True, 'data': result})

@app.route('/api/index/summary', methods=['GET'])
def get_index_summary():
    summary = llama_index.get_index_summary()
    return jsonify({'success': True, 'data': summary})

@app.route('/api/nodes', methods=['GET'])
def list_nodes():
    doc_id = request.args.get('doc_id')
    top_k = int(request.args.get('top_k', 100))
    
    nodes = []
    for node in llama_index.vector_index.get_all_nodes():
        if doc_id is None or node.document_id == doc_id:
            nodes.append(node.to_dict())
    
    return jsonify({
        'success': True,
        'data': nodes[:top_k],
        'total': len(nodes)
    })

@app.route('/api/nodes/<string:node_id>', methods=['GET'])
def get_node(node_id):
    node = llama_index.vector_index.get_node(node_id)
    if not node:
        return jsonify({'success': False, 'message': 'Node not found'}), 404
    
    return jsonify({'success': True, 'data': node.to_dict()})

@app.route('/api/tree', methods=['GET'])
def get_tree():
    tree_dict = llama_index.tree_index.to_dict()
    return jsonify({'success': True, 'data': tree_dict})

@app.route('/api/save', methods=['POST'])
def save_state():
    data = request.get_json()
    filename = data.get('filename', f'llama_index_state_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    filepath = os.path.join(DATA_DIR, filename)
    
    llama_index.save_state(filepath)
    
    return jsonify({'success': True, 'message': f'State saved to {filename}'})

@app.route('/api/load', methods=['POST'])
def load_state():
    data = request.get_json()
    filename = data.get('filename')
    
    if not filename:
        return jsonify({'success': False, 'message': 'Filename cannot be empty'}), 400
    
    filepath = os.path.join(DATA_DIR, filename)
    
    try:
        llama_index.load_state(filepath)
        return jsonify({
            'success': True,
            'message': 'State loaded successfully',
            'document_count': len(llama_index.documents)
        })
    except FileNotFoundError:
        return jsonify({'success': False, 'message': 'File not found'}), 404

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
    llama_index.documents.clear()
    llama_index.vector_index = VectorIndex()
    llama_index.tree_index = TreeIndex()
    llama_index.keyword_index = KeywordIndex()
    llama_index.query_engine = QueryEngine(llama_index.vector_index, llama_index.tree_index, llama_index.keyword_index)
    llama_index.is_built = False
    return jsonify({'success': True, 'message': 'All data cleared'})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5004)
