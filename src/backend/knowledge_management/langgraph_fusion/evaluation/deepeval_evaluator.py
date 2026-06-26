"""
DeepEval 检索评估器
==================
基于 DeepEval 框架，对检索结果进行精确率 (Precision)、召回率 (Recall)
和相关性 (Relevancy) 评估。

使用方式：
  1. 批量评估（推荐）：加载测试数据集，批量运行检索并评估
  2. 在线评估：在检索管线中实时计算指标（需要 ground truth）

依赖：
  - deepeval >= 3.0.0
  - 需要提供 LLM 配置（通过 llm_config 参数），使用项目现有的 LLM 端点做评估判断
"""

import logging
import json
import os
import time
from typing import Dict, Any, List, Optional

_logger = logging.getLogger("langgraph_fusion.deepeval_evaluator")

# ── 延迟导入 deepeval（避免未安装时阻塞整个模块加载） ──
_deepeval_available = False
_deepeval_import_error = None

try:
    from deepeval import evaluate
    from deepeval.metrics import (
        ContextualPrecisionMetric,
        ContextualRecallMetric,
        ContextualRelevancyMetric,
    )
    from deepeval.test_case import LLMTestCase
    from deepeval.models import GPTModel
    _deepeval_available = True
except ImportError as e:
    _deepeval_import_error = str(e)
    _logger.warning(f"DeepEval not available: {_deepeval_import_error}. "
                     "Install with: pip install deepeval")


# ── 默认评估阈值 ──
DEFAULT_PRECISION_THRESHOLD = 0.5
DEFAULT_RECALL_THRESHOLD = 0.5
DEFAULT_RELEVANCY_THRESHOLD = 0.5


def _create_eval_model(llm_config: Optional[dict] = None):
    """
    从项目 LLM 配置创建 DeepEval 评估模型。

    DeepEval 需要一个 LLM 来判断检索上下文是否与查询相关。
    优先使用项目配置的自定义 LLM 端点，如果没有则尝试使用环境变量。

    Args:
        llm_config: 项目 LLM 配置 {"llm_url", "llm_api_key", "llm_model"}

    Returns:
        GPTModel 实例 或 None
    """
    if not _deepeval_available:
        return None

    if llm_config and llm_config.get("llm_url"):
        # 使用项目自定义 LLM 端点
        base_url = llm_config["llm_url"].rstrip("/")
        if base_url.endswith("/chat/completions"):
            base_url = base_url[: - len("/chat/completions")]

        model_name = llm_config.get("llm_model", "gpt-3.5-turbo")
        api_key = llm_config.get("llm_api_key", "not-needed")

        _logger.info(
            f"DeepEval using custom LLM: base_url={base_url}, model={model_name}"
        )
        return GPTModel(
            model=model_name,
            api_key=api_key,
            base_url=base_url,
        )

    # 回退：尝试使用环境变量中的 OPENAI_API_KEY
    if os.environ.get("OPENAI_API_KEY"):
        _logger.info("DeepEval using OpenAI API from environment")
        return GPTModel(model="gpt-4o-mini")

    _logger.warning(
        "DeepEval: no LLM configured. "
        "Set OPENAI_API_KEY env var or provide llm_config. "
        "Evaluation will not run."
    )
    return None


def _normalize_contexts(contexts: List[dict]) -> List[str]:
    """
    将检索结果列表标准化为文本列表。

    Args:
        contexts: 检索结果列表 [{text, score, source, ...}, ...]

    Returns:
        文本字符串列表
    """
    texts = []
    for ctx in contexts:
        if isinstance(ctx, str):
            texts.append(ctx)
        elif isinstance(ctx, dict):
            text = ctx.get("text", ctx.get("content", ""))
            if text:
                texts.append(text)
    return texts


def _build_deepeval_metrics(
    eval_model,
    precision_threshold: float = DEFAULT_PRECISION_THRESHOLD,
    recall_threshold: float = DEFAULT_RECALL_THRESHOLD,
    relevancy_threshold: float = DEFAULT_RELEVANCY_THRESHOLD,
    use_async: bool = True,
) -> list:
    """
    构建 DeepEval 评估指标列表。

    Args:
        eval_model: DeepEval 评估模型（GPTModel 实例）
        precision_threshold: 精确率通过阈值
        recall_threshold: 召回率通过阈值
        relevancy_threshold: 相关性通过阈值
        use_async: 是否使用异步模式

    Returns:
        DeepEval 指标列表
    """
    kwargs = {"include_reason": True, "async_mode": use_async}
    if eval_model:
        kwargs["model"] = eval_model

    return [
        ContextualPrecisionMetric(
            threshold=precision_threshold,
            **kwargs,
        ),
        ContextualRecallMetric(
            threshold=recall_threshold,
            **kwargs,
        ),
        ContextualRelevancyMetric(
            threshold=relevancy_threshold,
            **kwargs,
        ),
    ]


def evaluate_retrieval(
    query: str,
    retrieved_contexts: List[dict],
    expected_contexts: Optional[List[str]] = None,
    actual_output: Optional[str] = None,
    expected_output: Optional[str] = None,
    llm_config: Optional[dict] = None,
    precision_threshold: float = DEFAULT_PRECISION_THRESHOLD,
    recall_threshold: float = DEFAULT_RECALL_THRESHOLD,
    relevancy_threshold: float = DEFAULT_RELEVANCY_THRESHOLD,
) -> Dict[str, Any]:
    """
    对单次检索结果进行 DeepEval 评估。

    Args:
        query: 用户查询
        retrieved_contexts: 检索返回的上下文列表 [{text, ...}, ...]
        expected_contexts: 期望检索到的上下文文本列表（ground truth），
                          用于计算精确率/召回率。如果不提供，则仅评估相关性。
        actual_output: LLM 最终生成的答案（用于 ContextualRelevancy 评估）
        expected_output: 期望的正确答案（ground truth answer）
        llm_config: 项目 LLM 配置 {"llm_url", "llm_api_key", "llm_model"}，
                    用于创建 DeepEval 评估模型
        precision_threshold: 精确率通过阈值
        recall_threshold: 召回率通过阈值
        relevancy_threshold: 相关性通过阈值

    Returns:
        {
            "success": bool,
            "metrics": {
                "precision": {"score": float, "passed": bool, "reason": str},
                "recall": {"score": float, "passed": bool, "reason": str},
                "relevancy": {"score": float, "passed": bool, "reason": str},
            },
            "overall_passed": bool,
            "error": str or None,
        }
    """
    if not _deepeval_available:
        return {
            "success": False,
            "metrics": {},
            "overall_passed": False,
            "error": f"DeepEval not available: {_deepeval_import_error}",
        }

    retrieval_texts = _normalize_contexts(retrieved_contexts)
    if not retrieval_texts:
        return {
            "success": False,
            "metrics": {},
            "overall_passed": False,
            "error": "No retrieval contexts provided",
        }

    # 创建评估模型
    eval_model = _create_eval_model(llm_config)
    if eval_model is None:
        return {
            "success": False,
            "metrics": {},
            "overall_passed": False,
            "error": "No LLM configured for DeepEval evaluation",
        }

    t_start = time.time()

    try:
        # 构建测试用例
        test_case = LLMTestCase(
            input=query,
            actual_output=actual_output or "",
            expected_output=expected_output or "",
            retrieval_context=retrieval_texts,
        )

        # 构建指标（使用自定义评估模型）
        metrics = _build_deepeval_metrics(
            eval_model=eval_model,
            precision_threshold=precision_threshold,
            recall_threshold=recall_threshold,
            relevancy_threshold=relevancy_threshold,
        )

        # 执行评估
        result = evaluate(
            test_cases=[test_case],
            metrics=metrics,
            print_results=False,
        )

        # 解析结果
        metric_results = {}
        all_passed = True

        for test_result in result:
            for metric_data in test_result.metrics:
                metric_name = metric_data.__class__.__name__
                # 映射指标名称
                name_map = {
                    "ContextualPrecisionMetric": "precision",
                    "ContextualRecallMetric": "recall",
                    "ContextualRelevancyMetric": "relevancy",
                }
                short_name = name_map.get(metric_name, metric_name.lower())

                score = getattr(metric_data, "score", 0.0)
                passed = getattr(metric_data, "success", False)
                reason = getattr(metric_data, "reason", "")

                metric_results[short_name] = {
                    "score": round(float(score), 4) if score else 0.0,
                    "passed": bool(passed),
                    "reason": str(reason) if reason else "",
                }

                if not passed:
                    all_passed = False

        elapsed = time.time() - t_start
        _logger.info(
            f"DeepEval evaluation: query='{query[:50]}...', "
            f"metrics={metric_results}, passed={all_passed}, "
            f"elapsed={elapsed:.2f}s"
        )

        return {
            "success": True,
            "metrics": metric_results,
            "overall_passed": all_passed,
            "elapsed_ms": int(elapsed * 1000),
            "error": None,
        }

    except Exception as e:
        elapsed = time.time() - t_start
        _logger.error(f"DeepEval evaluation failed: {e}", exc_info=True)
        return {
            "success": False,
            "metrics": {},
            "overall_passed": False,
            "error": str(e),
            "elapsed_ms": int(elapsed * 1000),
        }


def evaluate_from_state(
    state: dict,
    ground_truth_contexts: Optional[List[str]] = None,
    ground_truth_answer: Optional[str] = None,
) -> Dict[str, Any]:
    """
    从 FusionSearchState 中提取信息进行 DeepEval 评估。

    这是与现有检索管线集成的主要入口。

    Args:
        state: FusionSearchState 字典，包含:
            - user_query: 用户查询
            - reranked_results: 精排后的检索结果
            - final_answer: LLM 生成的最终答案
            - config: 融合配置（含 llm_config）
        ground_truth_contexts: 期望的检索上下文（ground truth）
        ground_truth_answer: 期望的正确答案（ground truth）

    Returns:
        与 evaluate_retrieval() 相同格式的评估结果
    """
    query = state.get("user_query", "")
    retrieved = state.get("reranked_results", [])
    final_answer = state.get("final_answer", "")
    llm_config = state.get("config", {}).get("llm_config", {})

    return evaluate_retrieval(
        query=query,
        retrieved_contexts=retrieved,
        expected_contexts=ground_truth_contexts,
        actual_output=final_answer,
        expected_output=ground_truth_answer,
        llm_config=llm_config,
    )


def evaluate_batch(test_cases: List[dict], **kwargs) -> List[Dict[str, Any]]:
    """
    批量评估多个测试用例。

    Args:
        test_cases: 测试用例列表，每个元素:
            {
                "query": str,
                "retrieved_contexts": [{text, ...}, ...],
                "expected_contexts": [str, ...] (可选),
                "actual_output": str (可选),
                "expected_output": str (可选),
            }
        **kwargs: 传递给 evaluate_retrieval() 的其他参数

    Returns:
        每个测试用例的评估结果列表
    """
    results = []
    for i, tc in enumerate(test_cases):
        _logger.info(f"DeepEval batch: evaluating {i + 1}/{len(test_cases)}")
        result = evaluate_retrieval(
            query=tc.get("query", ""),
            retrieved_contexts=tc.get("retrieved_contexts", []),
            expected_contexts=tc.get("expected_contexts"),
            actual_output=tc.get("actual_output"),
            expected_output=tc.get("expected_output"),
            **kwargs,
        )
        result["case_index"] = i
        results.append(result)

    # 汇总统计
    if results:
        success_count = sum(1 for r in results if r.get("success"))
        passed_count = sum(1 for r in results if r.get("overall_passed"))

        _logger.info(
            f"DeepEval batch summary: {len(results)} cases, "
            f"{success_count} evaluated, {passed_count} passed"
        )

    return results


def compute_batch_statistics(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    计算批量评估的统计汇总。

    Args:
        results: evaluate_batch() 返回的结果列表

    Returns:
        {
            "total": int,
            "evaluated": int,
            "passed": int,
            "avg_precision": float,
            "avg_recall": float,
            "avg_relevancy": float,
            "precision_passed_rate": float,
            "recall_passed_rate": float,
            "relevancy_passed_rate": float,
        }
    """
    valid_results = [r for r in results if r.get("success")]
    total = len(results)
    evaluated = len(valid_results)

    if evaluated == 0:
        return {
            "total": total,
            "evaluated": 0,
            "passed": 0,
            "avg_precision": 0.0,
            "avg_recall": 0.0,
            "avg_relevancy": 0.0,
            "precision_passed_rate": 0.0,
            "recall_passed_rate": 0.0,
            "relevancy_passed_rate": 0.0,
        }

    precision_scores = []
    recall_scores = []
    relevancy_scores = []
    precision_passed = 0
    recall_passed = 0
    relevancy_passed = 0

    for r in valid_results:
        metrics = r.get("metrics", {})
        if "precision" in metrics:
            precision_scores.append(metrics["precision"]["score"])
            if metrics["precision"]["passed"]:
                precision_passed += 1
        if "recall" in metrics:
            recall_scores.append(metrics["recall"]["score"])
            if metrics["recall"]["passed"]:
                recall_passed += 1
        if "relevancy" in metrics:
            relevancy_scores.append(metrics["relevancy"]["score"])
            if metrics["relevancy"]["passed"]:
                relevancy_passed += 1

    passed = sum(1 for r in valid_results if r.get("overall_passed"))

    return {
        "total": total,
        "evaluated": evaluated,
        "passed": passed,
        "avg_precision": round(sum(precision_scores) / len(precision_scores), 4) if precision_scores else 0.0,
        "avg_recall": round(sum(recall_scores) / len(recall_scores), 4) if recall_scores else 0.0,
        "avg_relevancy": round(sum(relevancy_scores) / len(relevancy_scores), 4) if relevancy_scores else 0.0,
        "precision_passed_rate": round(precision_passed / len(precision_scores), 4) if precision_scores else 0.0,
        "recall_passed_rate": round(recall_passed / len(recall_scores), 4) if recall_scores else 0.0,
        "relevancy_passed_rate": round(relevancy_passed / len(relevancy_scores), 4) if relevancy_scores else 0.0,
    }


def is_available() -> bool:
    """检查 DeepEval 是否可用"""
    return _deepeval_available
