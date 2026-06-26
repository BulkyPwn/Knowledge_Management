"""
统一 Embedding 适配器
=====================
从现有 models.json 配置创建 LlamaIndex OpenAIEmbedding 实例，
支持 OpenAI 兼容 API（远程）。
"""

import logging
from llama_index.embeddings.openai import OpenAIEmbedding

_logger = logging.getLogger("langgraph_fusion.embedding")


class EmbeddingFactory:
    """
    从 llm_config 字典创建 Embedding 实例。

    用法:
        factory = EmbeddingFactory(llm_config)
        embed_model = factory.create()
    """

    def __init__(self, llm_config: dict):
        """
        Args:
            llm_config: 来自 config.load_llm_config() 的配置字典
                包含: llm_url, llm_api_key, llm_embedding_model
        """
        self._config = llm_config

    @property
    def model_name(self) -> str:
        return self._config.get("llm_embedding_model", "text-embedding-3-small")

    @property
    def api_base(self) -> str:
        return self._config.get("llm_url", "")

    @property
    def api_key(self) -> str:
        return self._config.get("llm_api_key", "")

    def create(self, **kwargs) -> OpenAIEmbedding:
        """
        创建 OpenAIEmbedding 实例。

        Args:
            **kwargs: 传递给 OpenAIEmbedding 的额外参数（会覆盖默认值）

        Returns:
            OpenAIEmbedding 实例
        """
        params = {
            "model": self.model_name,
            "api_key": self.api_key,
            "api_base": self.api_base,
            "embed_batch_size": 50,
        }
        params.update(kwargs)
        _logger.info(
            f"Creating embedding: model={params['model']}, "
            f"batch_size={params['embed_batch_size']}, "
            f"api_base={params['api_base'][:60]}..."
        )
        return OpenAIEmbedding(**params)

    def is_configured(self) -> bool:
        """检查 embedding 配置是否有效"""
        return bool(self.api_base and self.api_key)
