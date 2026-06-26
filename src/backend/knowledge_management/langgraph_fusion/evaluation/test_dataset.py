"""
测试数据集管理
==============
管理检索评估的测试数据集：加载 / 保存 / 创建。

数据集格式 (JSON):
[
    {
        "query": "什么是 RAG？",
        "expected_contexts": ["RAG 是检索增强生成...", "RAG 结合了检索和生成..."],
        "expected_output": "RAG (Retrieval-Augmented Generation) 是一种...",
        "tags": ["RAG", "基础概念"]
    },
    ...
]
"""

import json
import os
import logging
from typing import Dict, Any, List, Optional

_logger = logging.getLogger("langgraph_fusion.test_dataset")

DEFAULT_DATASET_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "data",
)


class RetrievalTestDataset:
    """检索评估测试数据集"""

    def __init__(self, name: str = "default", data_dir: str = None):
        """
        Args:
            name: 数据集名称
            data_dir: 数据集存储目录，默认 langgraph_fusion/data/
        """
        self.name = name
        self.data_dir = data_dir or DEFAULT_DATASET_DIR
        self.cases: List[dict] = []

    @property
    def file_path(self) -> str:
        return os.path.join(self.data_dir, f"retrieval_testset_{self.name}.json")

    def load(self) -> List[dict]:
        """从文件加载测试数据集"""
        if not os.path.exists(self.file_path):
            _logger.warning(f"Test dataset not found: {self.file_path}")
            return []

        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                self.cases = json.load(f)
            _logger.info(f"Loaded {len(self.cases)} test cases from {self.file_path}")
            return self.cases
        except (json.JSONDecodeError, IOError) as e:
            _logger.error(f"Failed to load test dataset: {e}")
            return []

    def save(self) -> bool:
        """保存测试数据集到文件"""
        os.makedirs(self.data_dir, exist_ok=True)
        try:
            with open(self.file_path, "w", encoding="utf-8") as f:
                json.dump(self.cases, f, ensure_ascii=False, indent=2)
            _logger.info(f"Saved {len(self.cases)} test cases to {self.file_path}")
            return True
        except IOError as e:
            _logger.error(f"Failed to save test dataset: {e}")
            return False

    def add_case(self, query: str, expected_contexts: List[str],
                 expected_output: str = "", tags: List[str] = None) -> dict:
        """
        添加测试用例。

        Args:
            query: 查询文本
            expected_contexts: 期望检索到的上下文列表
            expected_output: 期望的答案
            tags: 标签列表

        Returns:
            添加的测试用例
        """
        case = {
            "query": query,
            "expected_contexts": expected_contexts,
            "expected_output": expected_output,
            "tags": tags or [],
        }
        self.cases.append(case)
        return case

    def remove_case(self, index: int) -> Optional[dict]:
        """按索引删除测试用例"""
        if 0 <= index < len(self.cases):
            return self.cases.pop(index)
        return None

    def get_case(self, index: int) -> Optional[dict]:
        """按索引获取测试用例"""
        if 0 <= index < len(self.cases):
            return self.cases[index]
        return None

    def filter_by_tag(self, tag: str) -> List[dict]:
        """按标签筛选测试用例"""
        return [c for c in self.cases if tag in c.get("tags", [])]

    def __len__(self) -> int:
        return len(self.cases)

    def __iter__(self):
        return iter(self.cases)


def load_test_dataset(name: str = "default", data_dir: str = None) -> RetrievalTestDataset:
    """便捷方法：加载指定名称的测试数据集"""
    ds = RetrievalTestDataset(name=name, data_dir=data_dir)
    ds.load()
    return ds


def create_sample_dataset(name: str = "sample", data_dir: str = None) -> RetrievalTestDataset:
    """
    创建一个示例测试数据集。

    用于快速验证 DeepEval 评估管线。
    """
    ds = RetrievalTestDataset(name=name, data_dir=data_dir)

    ds.add_case(
        query="什么是 LangGraph？",
        expected_contexts=[
            "LangGraph 是 LangChain 团队开发的一个库，用于构建有状态的多参与者应用程序。",
            "LangGraph 支持循环图、条件分支和状态持久化。",
        ],
        expected_output="LangGraph 是一个用于构建有状态多参与者应用的库，支持循环、条件和持久化。",
        tags=["langgraph", "基础概念"],
    )

    ds.add_case(
        query="LlamaIndex 如何与 ChromaDB 集成？",
        expected_contexts=[
            "LlamaIndex 提供 ChromaVectorStore 来与 ChromaDB 集成。",
            "使用 llama-index-vector-stores-chroma 包可以将 ChromaDB 作为向量存储后端。",
        ],
        expected_output="LlamaIndex 通过 llama-index-vector-stores-chroma 包与 ChromaDB 集成。",
        tags=["llamaindex", "chromadb"],
    )

    ds.add_case(
        query="RAG 系统中如何评估检索质量？",
        expected_contexts=[
            "检索质量评估通常使用精确率（Precision）和召回率（Recall）指标。",
            "精确率衡量检索结果中相关文档的比例。",
            "召回率衡量所有相关文档中被检索到的比例。",
        ],
        expected_output="RAG 检索质量通过精确率和召回率评估，精确率关注检索结果的相关性，召回率关注覆盖面。",
        tags=["RAG", "评估"],
    )

    ds.save()
    return ds
