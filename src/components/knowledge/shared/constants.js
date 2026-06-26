// 知识管理页面全局常量

// KMA Server 基础地址
export const WIKI_BASE = 'http://127.0.0.1:5002/api/v1';

// 默认模型配置（当用户未配置时使用）
export const DEFAULT_MODELS = [];
export const DEFAULT_MODEL_ID = 'deepseek-v4-flash';

// PPT 生成默认提示词与 Agent
export const DEFAULT_PPT_PROMPT =
  '在当前目录下的ppt文件夹下生成一份ppt，无需确认方案直接生成；你可以使用llm-wiki MCP尝试获取需要的知识；ppt生成要求如下：';
export const DEFAULT_PPT_AGENT = 'Code-with-LLM-wiki';

// 代码生成默认提示词与 Agent
export const DEFAULT_CODE_PROMPT =
  '在当前目录下的code文件夹下生成代码，无需确认方案直接生成；你可以使用llm-wiki MCP尝试获取需要的知识；代码生成要求如下：';
export const DEFAULT_CODE_AGENT = 'Code';
