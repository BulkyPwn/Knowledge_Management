from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os

app = Flask(__name__)
CORS(app)

KNOWLEDGE_FILE = 'knowledge_base.json'

def load_knowledge_base():
    if os.path.exists(KNOWLEDGE_FILE):
        with open(KNOWLEDGE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_knowledge_base(knowledge_base):
    with open(KNOWLEDGE_FILE, 'w', encoding='utf-8') as f:
        json.dump(knowledge_base, f, ensure_ascii=False, indent=2)

@app.route('/api/knowledge', methods=['GET'])
def get_all_knowledge():
    knowledge_base = load_knowledge_base()
    return jsonify({'success': True, 'data': knowledge_base})

@app.route('/api/knowledge/<string:knowledge_id>', methods=['GET'])
def get_knowledge_by_id(knowledge_id):
    knowledge_base = load_knowledge_base()
    knowledge = next((k for k in knowledge_base if k['id'] == knowledge_id), None)
    if knowledge:
        return jsonify({'success': True, 'data': knowledge})
    return jsonify({'success': False, 'message': 'Knowledge entry not found'}), 404

@app.route('/api/knowledge', methods=['POST'])
def create_knowledge():
    data = request.get_json()
    if not data or 'title' not in data:
        return jsonify({'success': False, 'message': 'Missing required fields'}), 400
    
    knowledge_base = load_knowledge_base()
    new_id = str(len(knowledge_base) + 1)
    
    new_knowledge = {
        'id': new_id,
        'title': data['title'],
        'content': data.get('content', ''),
        'category': data.get('category', 'Uncategorized'),
        'tags': data.get('tags', []),
        'created_at': data.get('created_at'),
        'updated_at': data.get('updated_at')
    }
    
    knowledge_base.append(new_knowledge)
    save_knowledge_base(knowledge_base)
    
    return jsonify({'success': True, 'data': new_knowledge}), 201

@app.route('/api/knowledge/<string:knowledge_id>', methods=['PUT'])
def update_knowledge(knowledge_id):
    data = request.get_json()
    knowledge_base = load_knowledge_base()
    
    index = next((i for i, k in enumerate(knowledge_base) if k['id'] == knowledge_id), None)
    if index is None:
        return jsonify({'success': False, 'message': 'Knowledge entry not found'}), 404
    
    if 'title' in data:
        knowledge_base[index]['title'] = data['title']
    if 'content' in data:
        knowledge_base[index]['content'] = data['content']
    if 'category' in data:
        knowledge_base[index]['category'] = data['category']
    if 'tags' in data:
        knowledge_base[index]['tags'] = data['tags']
    if 'updated_at' in data:
        knowledge_base[index]['updated_at'] = data['updated_at']
    
    save_knowledge_base(knowledge_base)
    
    return jsonify({'success': True, 'data': knowledge_base[index]})

@app.route('/api/knowledge/<string:knowledge_id>', methods=['DELETE'])
def delete_knowledge(knowledge_id):
    knowledge_base = load_knowledge_base()
    index = next((i for i, k in enumerate(knowledge_base) if k['id'] == knowledge_id), None)
    
    if index is None:
        return jsonify({'success': False, 'message': 'Knowledge entry not found'}), 404
    
    deleted = knowledge_base.pop(index)
    save_knowledge_base(knowledge_base)
    
    return jsonify({'success': True, 'data': deleted})

@app.route('/api/knowledge/categories', methods=['GET'])
def get_categories():
    knowledge_base = load_knowledge_base()
    categories = set(k['category'] for k in knowledge_base)
    return jsonify({'success': True, 'data': list(categories)})

@app.route('/api/knowledge/search', methods=['GET'])
def search_knowledge():
    query = request.args.get('q', '')
    category = request.args.get('category', '')
    
    knowledge_base = load_knowledge_base()
    results = knowledge_base
    
    if query:
        query = query.lower()
        results = [k for k in results if query in k['title'].lower() or query in k['content'].lower()]
    
    if category:
        results = [k for k in results if k['category'] == category]
    
    return jsonify({'success': True, 'data': results})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
