"""
融合检索配置管理
================
从现有 models.json / knowledge_management.json 读取配置，
构建 FusionSearchConfig。
"""

import os
import json
import logging
from typing import Optional

from .state import FusionSearchConfig

_logger = logging.getLogger("langgraph_fusion.config")

# 默认值
DEFAULT_CHROMA_DIR_NAME = "chroma"
DEFAULT_CHECKPOINT_DB_NAME = "langgraph_checkpoints.db"
DEFAULT_NEO4J_URI = "bolt://localhost:7687"
DEFAULT_NEO4J_USER = "neo4j"
DEFAULT_NEO4J_PASSWORD = "password"
DEFAULT_MAX_RETRIES = 2
DEFAULT_QUALITY_THRESHOLD = 0.6


def _get_user_config_dir() -> str:
    """用户配置目录 ~/.SSSC_AI"""
    return os.path.join(os.path.expanduser("~"), ".SSSC_AI")


def _load_models_json() -> dict:
    """加载 models.json"""
    path = os.path.join(_get_user_config_dir(), "models.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _load_memory_json() -> dict:
    """加载 knowledge_management.json（memory file）"""
    path = os.path.join(_get_user_config_dir(), "knowledge_management.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def load_llm_config() -> dict:
    """
    从 models.json 读取当前选中的模型配置。
    返回值: {"llm_url", "llm_api_key", "llm_model", "llm_embedding_model"}
    """
    models_data = _load_models_json()
    memory_data = _load_memory_json()

    selected_id = memory_data.get("selectedModelConfigId", "")
    if not selected_id:
        selected_id = models_data.get("DEFAULT_MODEL_ID", "")

    _logger.debug(f"Loading LLM config: selected_id={selected_id}")

    models = models_data.get("MODELS", [])
    for m in models:
        if m.get("id") == selected_id:
            _logger.info(f"LLM config loaded: model={m.get('model')}, embedding={m.get('embeddingModel')}")
            return {
                "llm_url": m.get("url", ""),
                "llm_api_key": m.get("apiKey", ""),
                "llm_model": m.get("model", ""),
                "llm_embedding_model": m.get("embeddingModel", ""),
            }

    if models:
        m = models[0]
        _logger.warning(f"Selected model '{selected_id}' not found, falling back to first model: {m.get('model')}")
        return {
            "llm_url": m.get("url", ""),
            "llm_api_key": m.get("apiKey", ""),
            "llm_model": m.get("model", ""),
            "llm_embedding_model": m.get("embeddingModel", ""),
        }

    _logger.warning("No LLM models configured in models.json")
    return {"llm_url": "", "llm_api_key": "", "llm_model": "", "llm_embedding_model": ""}


def get_neo4j_password() -> str:
    """获取 Neo4j 密码（环境变量或默认值）"""
    return os.environ.get("NEO4J_PASSWORD", DEFAULT_NEO4J_PASSWORD)


def build_fusion_config(
    wiki_dir: str,
    raw_dir: str,
    data_dir: str,
    project_ids: list = None,
    enabled_sources: dict = None,
    llm_config: dict = None,
    neo4j_uri: str = None,
    neo4j_user: str = None,
    neo4j_password: str = None,
    max_retries: int = None,
    quality_threshold: float = None,
    use_deepeval: bool = False,
    ground_truth_contexts: list = None,
    ground_truth_answer: str = None,
) -> FusionSearchConfig:
    """
    构建融合检索配置。

    Args:
        wiki_dir: Wiki 页面目录
        raw_dir: 原始文档目录
        data_dir: 数据目录（用于存储 ChromaDB 等）
        project_ids: 知识库项目 ID 列表
        enabled_sources: 启用的检索源 {"llama_index", "graph_rag", "hidesk", "web"}
        llm_config: LLM 配置（可选，不传则自动从 models.json 加载）
        neo4j_uri: Neo4j URI（可选）
        neo4j_user: Neo4j 用户名（可选）
        neo4j_password: Neo4j 密码（可选）
        max_retries: 最大重试次数（可选）
        quality_threshold: 质量阈值（可选）
        use_deepeval: 是否启用 DeepEval 精确率/召回率评估
        ground_truth_contexts: 期望的检索上下文（ground truth）
        ground_truth_answer: 期望的正确答案
    """
    if enabled_sources is None:
        enabled_sources = {
            "llama_index": True,
            "graph_rag": True,
            "hidesk": False,
            "web": False,
        }

    if llm_config is None:
        llm_config = load_llm_config()

    _logger.info(
        f"Building fusion config: wiki={wiki_dir}, raw={raw_dir}, "
        f"sources={list(k for k, v in enabled_sources.items() if v)}, "
        f"embedding={llm_config.get('llm_embedding_model')}"
    )

    return FusionSearchConfig(
        project_ids=project_ids or [],
        wiki_dir=wiki_dir,
        raw_dir=raw_dir,
        data_dir=data_dir,
        llm_config=llm_config,
        llm_embedding_model=llm_config.get("llm_embedding_model", "text-embedding-3-small"),
        enabled_sources=enabled_sources,
        chroma_persist_dir=os.path.join(data_dir, DEFAULT_CHROMA_DIR_NAME),
        neo4j_uri=neo4j_uri or DEFAULT_NEO4J_URI,
        neo4j_user=neo4j_user or DEFAULT_NEO4J_USER,
        neo4j_password=neo4j_password or get_neo4j_password(),
        checkpoint_db_path=os.path.join(_get_user_config_dir(), DEFAULT_CHECKPOINT_DB_NAME),
        max_retries=max_retries if max_retries is not None else DEFAULT_MAX_RETRIES,
        quality_threshold=quality_threshold if quality_threshold is not None else DEFAULT_QUALITY_THRESHOLD,
        use_deepeval=use_deepeval,
        ground_truth_contexts=ground_truth_contexts or [],
        ground_truth_answer=ground_truth_answer or "",
    )
