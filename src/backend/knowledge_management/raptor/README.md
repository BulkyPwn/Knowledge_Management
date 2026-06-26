# RAPTOR - Retrieval-Augmented Text Generation with Tree-Structured Reasoning

基于 RAPTOR 论文实现的检索增强生成系统，采用树形结构进行分层检索和推理。

## 项目结构

```
raptor/
├── api/
│   └── app.py          # Flask REST API
├── models/
│   ├── __init__.py
│   └── raptor.py       # RAPTOR 核心模型
├── utils/
│   ├── __init__.py
│   ├── tree_structure.py  # 树形数据结构
│   └── retriever.py       # 分层检索器
├── data/               # 数据存储目录
├── __init__.py
├── requirements.txt    # 依赖配置
└── README.md           # 项目说明
```

## RAPTOR 核心原理

RAPTOR (Retrieval-Augmented Text Generation with Tree-Structured Retrieval) 是一种基于树形结构的检索增强生成方法。

### 树形层次结构

```
Level 0 (根节点)
    ├── Level 1 (章节/主题)
    │       ├── Level 2 (段落/小节)
    │       │       └── Level 3 (句子/事实)
    │       └── Level 2 (段落/小节)
    └── Level 1 (章节/主题)
            └── Level 2 (段落/小节)
```

### 检索流程

1. **分层检索**: 从顶层开始，逐层向下检索相关节点
2. **上下文聚合**: 将多层检索结果聚合为统一上下文
3. **生成回答**: 基于聚合的上下文生成最终回答

## 安装依赖

```bash
pip install -r requirements.txt
```

## 启动服务

```bash
python -m raptor.api.app
```

服务将在 `http://localhost:5002` 启动。

## API 接口

### 配置管理
- `GET /api/config` - 获取当前配置
- `PUT /api/config` - 更新配置

### 文档管理
- `POST /api/documents` - 添加单个文档
- `POST /api/documents/batch` - 批量添加文档
- `GET /api/documents` - 列出所有文档
- `GET /api/documents/{id}` - 获取单个文档
- `DELETE /api/documents/{id}` - 删除文档

### RAPTOR 核心功能
- `POST /api/build` - 构建树形层次结构
- `POST /api/query` - 检索并生成回答
- `GET /api/tree` - 获取树形结构摘要

### 状态管理
- `POST /api/save` - 保存当前状态
- `POST /api/load` - 加载已保存的状态
- `GET /api/data/list` - 列出已保存的状态文件
- `POST /api/clear` - 清空所有数据

## 使用示例

### 添加文档
```bash
curl -X POST http://localhost:5002/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "content": "深度学习是机器学习的一个分支，它使用多层神经网络来学习数据的特征表示。",
    "metadata": {"category": "AI", "source": "Wikipedia"}
  }'
```

### 构建层次结构
```bash
curl -X POST http://localhost:5002/api/build
```

### 查询
```bash
curl -X POST http://localhost:5002/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "什么是深度学习？"}'
```

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `max_levels` | int | 3 | 树形结构的最大层数 |
| `max_context_length` | int | 4096 | 上下文最大长度 |
| `retrieval_k` | int | 5 | 每层检索的节点数 |
| `model_name` | str | gpt-4o-mini | 使用的模型名称 |
| `enable_tree_reasoning` | bool | true | 是否启用树形推理 |

## 技术特点

1. **分层检索**: 支持多级别树形检索，从粗粒度到细粒度
2. **上下文聚合**: 自动聚合多层检索结果
3. **状态持久化**: 支持保存和加载检索器状态
4. **模块化设计**: 清晰的代码结构，易于扩展

## 参考论文

RAPTOR: Retrieval-Augmented Text Generation with Tree-Structured Retrieval
