# GraphRAG - Knowledge Graph Enhanced Retrieval-Augmented Generation

基于知识图谱的检索增强生成系统，结合图结构化信息和传统 RAG 检索能力。

## 项目结构

```
graph_rag/
├── graph.py        # 知识图谱数据结构
├── extractor.py     # 实体识别和关系抽取
├── retriever.py    # 图检索器
├── graph_rag.py    # GraphRAG 核心模型
├── api.py          # Flask REST API
├── requirements.txt
└── README.md
```

## 核心原理

GraphRAG 将非结构化文本转换为知识图谱，通过图结构实现更精准的检索和推理。

### 知识图谱结构

```
实体 (Entity)
├── id: 唯一标识
├── name: 名称
├── type: 类型 (PERSON, ORGANIZATION, TECHNOLOGY, etc.)
├── description: 描述
└── properties: 属性

关系 (Relation)
├── id: 唯一标识
├── source_id: 源实体ID
├── target_id: 目标实体ID
├── type: 关系类型
└── weight: 权重
```

### 检索流程

1. **文档解析**: 提取实体和关系构建知识图谱
2. **关键词检索**: 在图中搜索相关实体
3. **子图提取**: 获取相关实体及其邻居
4. **上下文生成**: 基于子图生成检索上下文
5. **答案生成**: LLM 基于上下文生成回答

## 安装依赖

```bash
pip install -r requirements.txt
```

## 启动服务

```bash
python api.py
```

服务将在 `http://localhost:5003` 启动。

## API 接口

### 配置管理
- `GET /api/config` - 获取当前配置
- `PUT /api/config` - 更新配置

### 文档管理
- `POST /api/documents` - 添加文档
- `GET /api/documents` - 列出所有文档
- `DELETE /api/documents/{doc_id}` - 删除文档

### GraphRAG 核心功能
- `POST /api/query` - 查询（检索+生成）
- `GET /api/graph` - 获取完整图谱
- `GET /api/graph/stats` - 获取图谱统计

### 实体管理
- `GET /api/entities` - 列出实体（支持按类型筛选）
- `GET /api/entities/{entity_id}` - 获取实体详情及邻居

### 关系管理
- `GET /api/relations` - 列出所有关系

### 图操作
- `POST /api/subgraph` - 提取子图
- `POST /api/path` - 查找路径

### 状态管理
- `POST /api/save` - 保存状态
- `POST /api/load` - 加载状态
- `GET /api/data/list` - 列出已保存文件
- `POST /api/clear` - 清空数据

## 使用示例

### 添加文档
```bash
curl -X POST http://localhost:5003/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "doc_id": "doc1",
    "content": "OpenAI developed GPT-4. Sam Altman is the CEO of OpenAI.",
    "metadata": {"source": "web"}
  }'
```

### 查询
```bash
curl -X POST http://localhost:5003/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Who is the CEO of OpenAI?"}'
```

### 获取实体详情
```bash
curl http://localhost:5003/api/entities/entity_id_here
```

### 查找路径
```bash
curl -X POST http://localhost:5003/api/path \
  -H "Content-Type: application/json" \
  -d '{"source_id": "entity1", "target_id": "entity2", "max_length": 3}'
```

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `max_context_length` | int | 4096 | 上下文最大长度 |
| `retrieval_top_k` | int | 5 | 检索返回的实体数 |
| `subgraph_depth` | int | 1 | 子图提取深度 |
| `model_name` | str | gpt-4o-mini | 模型名称 |
| `enable_relationship_reasoning` | bool | true | 启用关系推理 |
| `enable_entity_merging` | bool | true | 启用实体合并 |

## 与传统 RAG 的对比

| 维度 | 传统 RAG | GraphRAG |
|------|----------|----------|
| 检索单元 | 文本块 | 实体+关系 |
| 语义理解 | 基于向量相似度 | 基于图结构 |
| 关系推理 | 隐式 | 显式 |
| 上下文连贯性 | 可能断裂 | 结构化关联 |

## 技术特点

1. **实体识别**: 自动从文本中提取多种类型实体
2. **关系抽取**: 自动识别实体间关系
3. **图结构检索**: 支持子图提取、路径查找
4. **邻居扩展**: 自动扩展检索上下文
5. **状态持久化**: 支持保存和加载知识图谱
