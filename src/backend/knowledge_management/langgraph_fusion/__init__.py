# langgraph_fusion — LlamaIndex + LangGraph 多源融合检索
#
# 模块职责：
#   - state.py      — 定义 FusionSearchState / FusionSearchConfig
#   - config.py     — 配置管理（从现有 models.json 读取）
#   - adapters/     — Embedding / VectorStore / Neo4j / HiDesk 适配器
#   - nodes/        — LangGraph 各节点实现
#   - graph.py      — StateGraph 构建 + 条件边 + SqliteSaver
#
# 与现有系统集成：
#   - agent_tools.py 中注册 fusion_search tool
#   - app.py 的 app_refs 中注入适配器引用
#   - 不修改 common_search_researcher.py / agent_loop.py
