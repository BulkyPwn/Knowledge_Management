# LlamaIndex - Simplified Implementation

简化版的 LlamaIndex 实现，支持多种索引结构和查询模式。

## 项目结构

```
llama_index/
├── document.py      # 文档和节点结构
├── index.py         # 索引结构（Vector, Tree, Keyword）
├── query_engine.py  # 查询引擎
├── llama_index.py   # LlamaIndex 核心
├── api.py           # Flask REST API
├── requirements.txt
└── README.md
```

## 核心概念

LlamaIndex 是一个用于构建 LLM 应用知识索引的框架。

### 核心组件

| 组件 | 说明 |
|------|------|
| **Document** | 原始文档容器 |
| **Node** | 文档分块后的节点 |
| **VectorIndex** | 基于向量相似度的索引 |
| **TreeIndex** | 树形层次索引 |
| **KeywordIndex** | 关键词倒排索引 |
| **QueryEngine** | 多模式查询引擎 |

### 索引模式

1. **Vector Index**: 基于向量嵌入的相似度检索
2. **Tree Index**: 树形层次结构，支持层级遍历
3. **Keyword Index**: 关键词倒排索引
4. **Hybrid**: 混合模式，结合多种检索方式

## 安装依赖

```bash
pip install -r requirements.txt
```

## 启动服务

```bash
python api.py
```

服务将在 `http://localhost:5004` 启动。

## API 接口

### 配置管理
- `GET /api/config` - 获取当前配置
- `PUT /api/config` - 更新配置

### 文档管理
- `POST /api/documents` - 添加文档
- `GET /api/documents` - 列出所有文档
- `GET /api/documents/{doc_id}` - 获取单个文档
- `DELETE /api/documents/{doc_id}` - 删除文档

### 索引构建
- `POST /api/build` - 构建索引
- `GET /api/index/summary` - 获取索引摘要

### 查询
- `POST /api/query` - 查询（支持多种模式）

### 节点管理
- `GET /api/nodes` - 列出所有节点
- `GET /api/nodes/{node_id}` - 获取单个节点

### 树结构
- `GET /api/tree` - 获取树形索引结构

### 状态管理
- `POST /api/save` - 保存状态
- `POST /api/load` - 加载状态
- `GET /api/data/list` - 列出已保存文件
- `POST /api/clear` - 清空数据

## 使用示例

### 添加文档
```bash
curl -X POST http://localhost:5004/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "doc_id": "doc1",
    "text": "深度学习是机器学习的一个分支，它使用多层神经网络来学习数据的特征表示。",
    "metadata": {"source": "wiki"}
  }'
```

### 构建索引
```bash
curl -X POST http://localhost:5004/api/build \
  -H "Content-Type: application/json" \
  -d '{"tree_max_children": 3}'
```

### 查询（向量模式）
```bash
curl -X POST http://localhost:5004/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "什么是深度学习？", "mode": "vector", "top_k": 5}'
```

### 查询（树形模式）
```bash
curl -X POST http://localhost:5004/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "什么是深度学习？", "mode": "tree"}'
```

### 查询（混合模式）
```bash
curl -X POST http://localhost:5004/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "什么是深度学习？", "mode": "hybrid"}'
```

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `chunk_size` | int | 500 | 文档分块大小 |
| `chunk_overlap` | int | 50 | 分块重叠大小 |
| `tree_max_children` | int | 3 | 树节点最大子节点数 |
| `default_top_k` | int | 5 | 默认返回结果数 |
| `default_mode` | str | vector | 默认查询模式 |

## 查询模式

| 模式 | 说明 |
|------|------|
| `vector` | 基于向量相似度检索 |
| `tree` | 基于树形结构遍历 |
| `keyword` | 基于关键词匹配 |
| `hybrid` | 混合多种检索方式 |

## 技术特点

1. **多索引支持**: 支持 Vector、Tree、Keyword 三种索引
2. **混合查询**: 支持多种查询模式组合
3. **自动分块**: 文档自动分块并建立索引
4. **树形结构**: 支持树形层次索引构建
5. **状态持久化**: 支持保存和加载索引状态
