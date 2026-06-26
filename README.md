# AI 一站式桌面 (AI One-Stop Desktop)

AI 一站式桌面应用 — 基于 Electron + React 的桌面工具，集成**文档设计、代码开发、问题定位、知识管理、Agent 对话**五大 AI 辅助工作模式。

## 功能概览

| 模式 | 说明 |
|---|---|
| **一键设计** | 选择项目/模块与参考文档，指定工作路径后一键生成设计文档。支持生成历史追踪。 |
| **代码开发** | Monaco 编辑器 + 文件浏览器 + 代码问答面板。内置 xterm.js 终端（Ctrl+Shift+`）、命令面板（Ctrl+P）、Problems/Output 面板、状态栏。 |
| **问题定位** | 上传日志与代码文件，选择分析工具（日志解析/代码分析/依赖检查/性能分析），输出分类结果。 |
| **知识管理** | 知识库创建/文件导入/文件列表管理，支持 MiniMax、GLM-5、GLM-4 及自定义模型配置，RAG 式知识库问答与图片上传。 |
| **Agent** | 通用 AI 对话，支持多种 Agent 角色切换（灵犀 / CodeAgent / 创意助手 / 专家模式）。 |

每个工作模式支持多标签页并行。内置深色/浅色/灰色主题切换。

> **注意**：当前版本 AI 响应为 Mock 数据。文件系统浏览及知识库管理等功能依赖独立的 Python Flask 后端服务（见下文）。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面框架 | Electron 28 |
| UI | React 18 + Tailwind CSS 3（组件级 lazy loading） |
| 代码编辑器 | Monaco Editor |
| 终端模拟 | xterm.js |
| 图标 | Lucide React |
| 构建 | Webpack 5 + Babel 7 + html-webpack-plugin |
| 测试 | Jest + React Testing Library |
| 打包 | electron-builder (NSIS / Windows) |

## 项目结构

```
one-stop-desktop-tool/
├── main.js                    # Electron 主进程入口
├── index.html                 # HTML 模板（由 html-webpack-plugin 生成到 build/）
├── package.json               # 项目配置与依赖
├── webpack.config.js          # Webpack 打包配置
├── .babelrc                   # Babel 配置
├── postcss.config.js          # PostCSS 配置
├── tailwind.config.js         # Tailwind 主题配置
├── build/                     # Webpack 构建输出（git-ignored）
│   ├── bundle.js
│   └── index.html
├── dist/                      # electron-builder 打包产物（git-ignored）
└── src/                       # React 源码
    ├── index.jsx              # React 入口
    ├── index.css              # 全局样式 + Tailwind 指令
    ├── App.jsx                # 根组件（布局 / 路由 / 状态管理 / lazy loading）
    └── components/
        ├── Sidebar.jsx             # 侧边导航栏
        ├── DocumentDesign.jsx      # 一键设计
        ├── CodeDevelopment.jsx     # 代码开发
        ├── IssueLocation.jsx       # 问题定位
        ├── KnowledgeManagement.jsx # 知识管理
        ├── Agent.jsx               # Agent 对话
        └── Settings.jsx            # 设置面板
```

## 环境要求

- **Node.js** >= 18
- **npm** >= 9
- **Python** >= 3.10（可选，文件系统浏览及知识库管理功能需要）

## 快速开始 (Setup and Run)

### 1. 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（可选，知识管理 / 文件系统浏览等功能需要）
pip install -r requirements.txt
```

### 2. 开发模式运行

```bash
# 构建 React 代码并启动 Electron（一次性）
npm run dev
# 应用中按 Ctrl+Shift+I 打开 Chrome DevTools 调试

# 或分步运行：先启动 webpack 监听，再在另一个终端启动 Electron
npm run watch      # 终端 1：监听文件变化自动重新构建
npm start          # 终端 2：启动 Electron 应用
```

### 3. 生产构建

```bash
# 仅构建 React 代码（输出到 build/）
npm run build:react

# 完整生产构建 + 打包 Windows 安装包
npm run build
```

打包产物输出到 `dist/` 目录，生成 NSIS 安装程序（`.exe`）。

### 4. 运行测试

```bash
npm test           # 运行一次
npm run test:watch # 监听模式
```

## 后端服务（可选）

`代码开发` 和 `知识管理` 模块中的文件系统浏览及知识库功能需要独立的 Python Flask 后端。应用默认请求以下接口：

### 文件系统

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/filesystem/root` | GET | 获取系统根目录列表 |
| `/api/filesystem/list?path=...` | GET | 列出指定路径下的文件 |
| `/api/filesystem/read?path=...` | GET | 读取文件内容 |

### 知识库

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/knowledge-base/create` | POST | 创建知识库（body: `{ dir }`） |
| `/api/knowledge-base/import` | POST | 导入文件/目录（body: `{ knowledge_base_id, path }`） |
| `/api/knowledge-base/files?knowledge_base_id=...` | GET | 获取知识库文件列表 |
| `/api/knowledge-base/set-model` | POST | 设置知识库模型 |
| `/api/knowledge-base/chat` | POST | 知识库 RAG 对话 |

后端需在 `http://localhost:5000` 启动。不含此后端时，代码开发模块使用内置默认文件树，其余功能不受影响。

## 配置说明

- **主题**：通过设置面板切换 dark / light / gray 主题，自定义颜色变量定义在 `tailwind.config.js`。
- **窗口**：默认 1400×900，最小 1200×800，可在 `main.js` 中调整。
- **键盘快捷键**（代码开发模块）：
  - `Ctrl+P` / `Cmd+P` — 打开命令面板
  - `Ctrl+Shift+` ` ` / `Cmd+Shift+` ` ` — 切换终端面板

## 开发说明

- 入口文件 `src/index.jsx` → React 挂载到 `index.html` 的 `#root` 容器。
- `App.jsx` 使用 `React.lazy` + `Suspense` 对各模块组件按需加载。
- Webpack 构建输出到 `build/` 目录，通过 `html-webpack-plugin` 自动生成 `build/index.html`。
- Electron 主进程加载 `build/index.html`（而非根目录 `index.html`）。
- 生产构建 (`npm run build:react`) 使用 `--max-old-space-size=8192` 增加 Node 内存限制，避免 OOM。
- Electron 主进程配置 `nodeIntegration: true`（开发模式，生产发布前建议评估安全性）。
- 图标路径 `build/icon.ico` 用于 electron-builder 打包，需自行提供图标文件。
- 暂无 TypeScript，全部为 JSX 文件。
