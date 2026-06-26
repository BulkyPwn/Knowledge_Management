"""
FusionSearch 状态定义
=====================
定义 LangGraph 多源融合检索的状态类型和配置类型。
"""

from typing import TypedDict, List, Optional, Dict, Any


class FusionSearchConfig(TypedDict, total=False):
    """融合检索配置"""
    # ── 项目路径 ──
    project_ids: List[str]
    wiki_dir: str
    raw_dir: str
    data_dir: str

    # ── LLM 配置 ──
    llm_config: dict                   # 来自 load_llm_config()
    llm_embedding_model: str           # embedding 模型名

    # ── 源开关 ──
    enabled_sources: dict              # {"llama_index": bool, "graph_rag": bool, "hidesk": bool, "web": bool}

    # ── 存储配置 ──
    chroma_persist_dir: str            # ChromaDB 持久化目录
    neo4j_uri: str                     # Neo4j 连接 URI
    neo4j_user: str
    neo4j_password: str

    # ── LangGraph 配置 ──
    checkpoint_db_path: str            # SqliteSaver 数据库路径
    max_retries: int                   # 最大重试次数（默认 2）
    quality_threshold: float           # 质量阈值（默认 0.6）

    # ── DeepEval 配置 ──
    use_deepeval: bool                 # 是否启用 DeepEval 精确率/召回率评估
    ground_truth_contexts: List[str]   # 期望的检索上下文（用于精确率/召回率计算）
    ground_truth_answer: str           # 期望的正确答案


class FusionSearchState(TypedDict, total=False):
    """融合检索运行时状态"""
    # ── 输入 ──
    user_query: str
    config: FusionSearchConfig

    # ── 意图解析 ──
    parsed_intent: Optional[dict]          # {topic, focus_areas, search_type, domain, timeliness}
    rewritten_queries: Dict[str, Any]     # {hyde, keyword, entity, original}

    # ── 各源检索结果 ──
    llama_index_hits: List[dict]          # [{text, score, metadata, node_id}]
    graph_rag_hits: List[dict]            # [{entity, relations, path}]
    hidesk_hits: List[dict]               # [{title, content, url, score}]
    web_hits: List[dict]                  # [{title, content, url, score}]

    # ── 融合后 ──
    fused_candidates: List[dict]          # RRF 粗排 top-20
    reranked_results: List[dict]          # LLM Reranker 精排 top-5

    # ── 控制与输出 ──
    quality_score: float
    quality_assessment: dict              # {coverage, relevance, specificity, missing, total_score}
    deepeval_result: Optional[dict]       # DeepEval 评估结果 {metrics, overall_passed, error}
    retry_count: int
    final_answer: Optional[str]
    final_sources: List[dict]             # [{text, source, score}]
    error: Optional[str]
