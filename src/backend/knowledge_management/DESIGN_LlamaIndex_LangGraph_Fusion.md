# LlamaIndex + LangGraph 多源融合检索方案设计

## 一、方案概述

在现有的 One-Stop Desktop Tool 知识管理系统中，引入 **LlamaIndex（官方库）** 作为索引引擎，**LangGraph** 作为检索编排引擎，构建一个多源融合检索系统。该系统对 LLM Wiki 的原始文档、生成的 Wiki 页面进行索引，并与 HiDesk、Web 搜索等外部源做统一融合检索。

### 核心目标

- **索引层**：用 LlamaIndex 对 Wiki 页面、原始文档、实体/概念页面构建多层向量索引
- **图谱层**：用 Neo4j 存储知识图谱，支持多跳推理和子图检索
- **编排层**：用 LangGraph 实现意图解析 → 多源并行检索 → RRF 融合 → LLM Reranker 精排 → 质量评估 → 回答生成
- **融合层**：加权 RRF + LLM Reranker 二阶段融合多源结果

### 技术选型

| 组件 | 选型 | 说明 |
|------|------|------|
| 索引框架 | llama-index >= 0.12.0 | 官方 Python 库 |
| Embedding | OpenAI 兼容 API | 复用现有 `models.json` 配置 |
| 向量存储 | ChromaDB | 当前实现，预留统一接口便于切换 LanceDB |
| 图存储 | Neo4j >= 5.14.0 | 现有依赖已有 |
| 编排引擎 | langgraph >= 0.2.0 | 条件边 + 并行节点 |
| 断点续传 | langgraph-checkpoint-sqlite | SqliteSaver，存储在 `~/.SSSC_AI/` |

## 二、架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LangGraph Orchestration Layer                 │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐  ┌────────────────┐   │
│  │ IngestNode │→ │ IndexNode│→ │ QueryNode │→ │ FusionRankNode │   │
│  └────────────┘  └──────────┘  └───────────┘  └────────────────┘   │
│         ↓              ↓              ↓               ↓              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    LlamaIndex Indexing Layer                   │   │
│  │  ┌──────────┐  ┌───────────┐  ┌─────────────┐  ┌──────────┐ │   │
│  │  │ RawDoc   │  │ WikiPage  │  │ GraphStore  │  │ Vector   │ │   │
│  │  │ Index    │  │ Index     │  │ (KG Index)  │  │ Store    │ │   │
│  │  └──────────┘  └───────────┘  └─────────────┘  └──────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Multi-Source Retrieval Router               │   │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐  │   │
│  │  │ LlamaIndex│  │ GraphRAG  │  │ HiDesk   │  │ WebSearch │  │   │
│  │  │ Query    │  │ Retriever │  │ Adapter  │  │ Adapter   │  │   │
│  │  └──────────┘  └───────────┘  └──────────┘  └───────────┘  │   │
│  │         ↓              ↓              ↓              ↓        │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │           RRF Fusion + LLM Reranker                   │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## 三、关键流程时序

```
用户 Query
  │
  ├─ 1. LangGraph intent_parser 节点
  │     LLM 解析意图 → {topic, focus_areas, search_type, domain}
  │
  ├─ 2. LangGraph query_rewriter 节点
  │     生成多角度查询:
  │       - 原始 query → 用于 HiDesk / Web
  │       - HyDE 假设文档 → 用于 Vector 检索
  │       - 关键词抽取 query → 用于 Keyword Index
  │       - 实体抽取 query → 用于 GraphRAG
  │
  ├─ 3. 并行检索（同时发起 4 路）
  │   ├── LlamaIndex Vector + Keyword (wiki, raw)
  │   ├── GraphRAG KnowledgeGraph
  │   ├── HiDesk API (如果有对应的 kb_sn)
  │   └── Web Search (如果激活)
  │
  ├─ 4. RRF 融合
  │     加权 RRF 合并去重 → top-20 候选
  │
  ├─ 5. LLM Reranker 精排
  │     LLM listwise 排序 → top-5
  │
  ├─ 6. Quality Eval
  │     评估: coverage / relevance / specificity
  │     → score < 0.6 时回退到步骤 2，重写 query (max 2 次)
  │
  └─ 7. Generate Answer
        LLM 基于 top-5 融合 context 生成最终回答
```

## 四、模块结构

```
src/backend/knowledge_management/
├── langgraph_fusion/                    # 新增模块
│   ├── __init__.py
│   ├── state.py                         # FusionSearchState / FusionSearchConfig
│   ├── config.py                        # 配置管理
│   ├── nodes/
│   │   ├── __init__.py
│   │   ├── intent_parser.py             # LLM 意图解析
│   │   ├── query_rewriter.py            # 多角度 query 重写 + HyDE
│   │   ├── llama_index_retriever.py     # LlamaIndex 检索
│   │   ├── graph_rag_retriever.py       # Neo4j KG 检索
│   │   ├── hidesk_retriever.py          # HiDesk 检索
│   │   ├── web_retriever.py             # Web 检索
│   │   ├── fusion_ranker.py             # RRF 融合 + LLM Reranker
│   │   ├── quality_evaluator.py         # 检索质量评估
│   │   └── answer_generator.py          # 回答生成
│   ├── graph.py                         # LangGraph StateGraph 构建
│   └── adapters/
│       ├── __init__.py
│       ├── embedding_adapter.py         # 统一 Embedding 接口
│       ├── vector_store_adapter.py       # 统一向量库接口（ChromaDB 实现）
│       ├── neo4j_adapter.py             # Neo4j 知识图谱适配器
│       └── hidesk_adapter.py            # HiDesk 搜索适配器
│
├── llama_index/                         # 升级为官方库版本
│   ├── __init__.py
│   ├── wiki_index_builder.py            # Wiki 页面索引构建器
│   ├── raw_index_builder.py             # 原始文档索引构建器
│   ├── index_registry.py                # 索引注册表
│   └── index_sync.py                    # 基于 log.md 的增量更新
│
├── graph_rag/                           # 增强（保留现有 + 新增 Neo4j）
│   └── (保留现有 graph.py / extractor.py / retriever.py)
│
└── langgraph_fusion/
    └── adapters/
        └── neo4j_adapter.py
```

## 五、索引策略

### 5.1 四层索引体系

| 索引层 | LlamaIndex 组件 | 索引对象 | 存储 |
|--------|----------------|---------|------|
| Raw Source Index | VectorStoreIndex | raw/sources/ 下原始文档 | ChromaDB: `raw_sources` |
| Wiki Page Index | VectorStoreIndex | wiki/ 下所有 LLM 生成页面 | ChromaDB: `wiki_pages` |
| Entity Index | VectorStoreIndex | wiki/entities/ 实体页面 | ChromaDB: `wiki_entities` |
| Concept Index | VectorStoreIndex | wiki/concepts/ 概念页面 | ChromaDB: `wiki_concepts` |

### 5.2 知识图谱索引

- 利用现有 `graph_rag/extractor.py` 的 `GraphExtractor` 从 Wiki 页面抽取实体和关系
- 同步到 Neo4j 支持多跳查询
- 保留内存 `KnowledgeGraph` 作为本地缓存

### 5.3 增量更新

- 基于 `wiki/log.md` 检测新增/修改的 Wiki 页面
- 仅重建变更页面的 embedding
- 增量更新 Neo4j 中的实体/关系

## 六、融合策略

### 6.1 加权 RRF 粗排

```
score(d) = Σ( w_source / (k + rank_in_source) )
```

权重配置：
- `w_wiki = 1.2`（Wiki 页面质量最高）
- `w_hidesk = 1.0`
- `w_raw_doc = 0.9`
- `w_graph_rag = 0.8`
- `w_web = 0.7`

### 6.2 LLM Reranker 精排

- 输入：query + top-20 RRF 候选
- 输出：top-5 精排结果 + 每篇相关性解释

## 七、LangGraph 状态设计

```python
class FusionSearchState(TypedDict):
    user_query: str                      # 用户原始查询
    config: FusionSearchConfig           # 配置（平台开关、路径等）
    parsed_intent: Optional[dict]        # 意图解析结果
    rewritten_queries: dict              # 多角度重写查询
    llama_index_hits: List[dict]         # LlamaIndex 检索结果
    graph_rag_hits: List[dict]           # 知识图谱检索结果
    hidesk_hits: List[dict]              # HiDesk 检索结果
    web_hits: List[dict]                 # Web 检索结果
    fused_candidates: List[dict]         # RRF 融合 top-20
    reranked_results: List[dict]         # LLM Reranker 精排 top-5
    quality_score: float                 # 检索质量分
    quality_assessment: dict             # 质量评估详情
    retry_count: int                     # 重试次数
    final_answer: Optional[str]          # 最终回答
    final_sources: List[dict]            # 引用来源
    error: Optional[str]                 # 错误信息
```

## 八、条件边逻辑

```
intent_parser → query_rewriter
query_rewriter → [llama_index_retriever, graph_rag_retriever, hidesk_retriever, web_retriever] (并行)
各检索节点 → fusion_ranker
fusion_ranker → quality_evaluator
quality_evaluator:
  ├── score >= 0.6 → answer_generator → END
  └── score < 0.6 AND retry_count < 2 → query_rewriter (重试)
  └── score < 0.6 AND retry_count >= 2 → answer_generator → END (强制结束)
```

## 九、与现有系统集成

- 在 `agent_tools.py` 中注册 `fusion_search` tool
- 在 `app.py` 的 `app_refs` 中注入融合检索相关的适配器引用
- 不修改现有 `common_search_researcher.py` 和 `agent_loop.py`
- Neo4j 路由已通过 `neo4j_integration` 模块集成

## 十、实施顺序

| 序号 | 模块 | 内容 |
|------|------|------|
| 1 | adapters/ | embedding、vector_store、neo4j、hidesk 适配器 |
| 2 | llama_index/ | wiki_index_builder、raw_index_builder、index_registry |
| 3 | langgraph_fusion/state.py | State + Config 定义 |
| 4 | langgraph_fusion/nodes/ | 各节点实现 |
| 5 | langgraph_fusion/graph.py | StateGraph 构建 |
| 6 | agent_tools.py | 注册 fusion_search tool |
| 7 | requirements.txt | 更新依赖 |
