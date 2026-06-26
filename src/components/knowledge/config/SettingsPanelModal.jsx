import React from 'react';
import { X, RefreshCw, Package, Download, Check, AlertTriangle, ArrowUpCircle } from 'lucide-react';
import ProcessTreeNode from './ProcessTreeNode';

// 设置面板弹窗：检索/渲染模式、KMA、KMA Server/MCP 控制、在线搜索、进程树、依赖版本检查
export default function SettingsPanelModal({
  theme,
  onClose,
  // 检索/渲染模式
  searchMode, setSearchMode,
  renderMode, setRenderMode,
  // KMA Server
  wikiRunning, onStartWiki, onStopWiki,
  // KMA MCP
  mcpRunning, mcpMode, onStartMcp, onStopMcp,
  // KMA
  kmaRunning, onStartKma, onStopKma,
  // 在线搜索
  searchEngine, setSearchEngine,
  searxngUrl, setSearxngUrl,
  proxyUrl, setProxyUrl,
  // 进程树
  processTree, processTreeLoading, processTreeError,
  onRefreshProcessTree, onKillProcess, killPid,
  // 依赖工具版本检查
  toolCheckLoading, toolCheckResult, toolCheckError,
  onCheckToolVersions,
  updatingTools, onUpdateTool,
}) {
  // 状态标签样式和文本
  const getStatusConfig = (status) => {
    switch (status) {
      case 'up_to_date':
        return { label: '已是最新', color: 'text-green-400', bg: 'bg-green-500/10', icon: Check };
      case 'update_available':
        return { label: '有更新', color: 'text-yellow-400', bg: 'bg-yellow-500/10', icon: ArrowUpCircle };
      case 'not_installed':
        return { label: '未安装', color: 'text-gray-400', bg: 'bg-gray-500/10', icon: Package };
      case 'installed_no_record':
        return { label: '已安装（无记录）', color: 'text-blue-400', bg: 'bg-blue-500/10', icon: Check };
      case 'server_no_info':
        return { label: '服务器无信息', color: 'text-orange-400', bg: 'bg-orange-500/10', icon: AlertTriangle };
      default:
        return { label: '未知', color: 'text-gray-400', bg: 'bg-gray-500/10', icon: Package };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={`relative w-full max-w-2xl max-h-[85vh] overflow-auto rounded-xl ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`} style={{ margin: '20px' }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-gray-700" style={{ backgroundColor: theme === 'dark' ? '#1f2937' : theme === 'light' ? '#ffffff' : '#374151' }}>
          <h3 className="text-lg font-semibold">设置</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-6">
          {/* 检索模式 */}
          <div>
            <h4 className={`text-sm font-medium mb-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>检索模式</h4>
            <select
              value={searchMode}
              onChange={(e) => setSearchMode(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-all ${
                theme === 'dark'
                  ? 'bg-gray-700 text-white'
                  : theme === 'light'
                    ? 'bg-gray-50 text-gray-900 border border-gray-200'
                    : 'bg-gray-500 text-white'
              }`}
            >
              <option value="normal">Normal</option>
              <option value="graph">Graph</option>
              <option value="hybrid">Hybrid</option>
              <option value="deep">Deep</option>
            </select>
          </div>

          {/* 渲染模式 */}
          <div>
            <h4 className={`text-sm font-medium mb-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>渲染模式</h4>
            <select
              value={renderMode}
              onChange={(e) => setRenderMode(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-all ${
                theme === 'dark'
                  ? 'bg-gray-700 text-white'
                  : theme === 'light'
                    ? 'bg-gray-50 text-gray-900 border border-gray-200'
                    : 'bg-gray-500 text-white'
              }`}
            >
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
              <option value="none">无</option>
            </select>
          </div>

          {/* 依赖工具版本检查 */}
          <div className={`pt-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
            <div className="flex items-center justify-between mb-3">
              <h4 className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>依赖工具版本</h4>
              <button
                onClick={onCheckToolVersions}
                disabled={toolCheckLoading}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs transition-all ${
                  toolCheckLoading
                    ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                    : (theme === 'dark'
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : theme === 'light'
                        ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white')
                }`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${toolCheckLoading ? 'animate-spin' : ''}`} />
                {toolCheckLoading ? '检查中...' : '检查依赖版本更新'}
              </button>
            </div>

            {toolCheckError && (
              <div className={`text-xs mb-2 px-3 py-2 rounded-lg ${
                theme === 'dark' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-500 border border-red-200'
              }`}>
                {toolCheckError}
              </div>
            )}

            {toolCheckResult && toolCheckResult.tools && (
              <div className="space-y-2">
                {toolCheckResult.tools.map((t) => {
                  const statusConfig = getStatusConfig(t.status);
                  const StatusIcon = statusConfig.icon;
                  const isUpdating = updatingTools[t.toolId];

                  return (
                    <div
                      key={t.toolId}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-xs ${
                        theme === 'dark' ? 'bg-gray-900/50' : theme === 'light' ? 'bg-gray-50 border border-gray-100' : 'bg-gray-700/50'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusIcon className={`w-4 h-4 flex-shrink-0 ${statusConfig.color}`} />
                        <div className="min-w-0">
                          <div className={`font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                            {t.name}
                          </div>
                          <div className={`mt-0.5 truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${statusConfig.bg} ${statusConfig.color}`}>
                              {statusConfig.label}
                            </span>
                            {t.remoteVersion !== 'unknown' && (
                              <span className="ml-1.5">服务器: {t.remoteVersion}</span>
                            )}
                            {(t.detail && t.status !== 'up_to_date') && (
                              <span className="ml-1.5 opacity-70">{t.detail}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      {onUpdateTool && (
                        <button
                          onClick={() => onUpdateTool(t)}
                          disabled={isUpdating}
                          className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                            isUpdating
                              ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                              : (theme === 'dark' ? 'bg-green-600 hover:bg-green-500 text-white' : theme === 'light' ? 'bg-green-500 hover:bg-green-600 text-white' : 'bg-green-600 hover:bg-green-500 text-white')
                          }`}
                        >
                          <Download className="w-3 h-3" />
                          {isUpdating ? '更新中...' : '更新'}
                        </button>
                      )}
                    </div>
                  );
                })}
                {toolCheckResult.updateTime && (
                  <p className={`text-[10px] text-right ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                    服务器版本更新时间: {toolCheckResult.updateTime}
                  </p>
                )}
                {toolCheckResult.checkedAt && (
                  <p className={`text-[10px] text-right ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                    检查时间: {new Date(toolCheckResult.checkedAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}
            {toolCheckResult && (!toolCheckResult.tools || toolCheckResult.tools.length === 0) && (
              <div className={`text-xs text-center py-2 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                暂无依赖工具版本信息
              </div>
            )}
          </div>

          {/* KMA */}
          <div className={`pt-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
            <h4 className={`text-sm font-medium mb-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>KMA</h4>
            <div className="flex items-center justify-between">
              <span className={`text-sm flex items-center gap-2 ${kmaRunning ? 'text-green-400' : (theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400')}`}>
                <span className={`inline-block w-2 h-2 rounded-full ${kmaRunning ? 'bg-green-400' : 'bg-gray-500'}`} />
                {kmaRunning ? '运行中 (端口 19828)' : '未启动'}
              </span>
              <button
                onClick={kmaRunning ? onStopKma : onStartKma}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  kmaRunning
                    ? (theme === 'dark'
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : theme === 'light'
                        ? 'bg-red-500 hover:bg-red-600 text-white'
                        : 'bg-red-600 hover:bg-red-700 text-white')
                    : (theme === 'dark'
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : theme === 'light'
                        ? 'bg-green-500 hover:bg-green-600 text-white'
                        : 'bg-green-600 hover:bg-green-700 text-white')
                }`}
              >
                {kmaRunning ? '停止' : '启动'}
              </button>
            </div>
          </div>

          {/* KMA Server */}
          <div className={`pt-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
            <h4 className={`text-sm font-medium mb-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>KMA Server</h4>
            <div className="flex items-center justify-between">
              <span className={`text-sm flex items-center gap-2 ${wikiRunning ? 'text-green-400' : (theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400')}`}>
                <span className={`inline-block w-2 h-2 rounded-full ${wikiRunning ? 'bg-green-400' : 'bg-gray-500'}`} />
                {wikiRunning ? '运行中' : '未启动'}
              </span>
              <button
                onClick={wikiRunning ? onStopWiki : onStartWiki}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  wikiRunning
                    ? (theme === 'dark'
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : theme === 'light'
                        ? 'bg-red-500 hover:bg-red-600 text-white'
                        : 'bg-red-600 hover:bg-red-700 text-white')
                    : (theme === 'dark'
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : theme === 'light'
                        ? 'bg-green-500 hover:bg-green-600 text-white'
                        : 'bg-green-600 hover:bg-green-700 text-white')
                }`}
              >
                {wikiRunning ? '停止' : '启动'}
              </button>
            </div>
          </div>

          {/* KMA MCP */}
          <div>
            <h4 className={`text-sm font-medium mb-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>KMA MCP</h4>
            <div className="flex items-center justify-between">
              <span className={`text-sm flex items-center gap-2 ${mcpRunning ? (mcpMode === 'local' ? 'text-green-400' : 'text-blue-400') : (theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400')}`}>
                <span className={`inline-block w-2 h-2 rounded-full ${mcpRunning ? (mcpMode === 'local' ? 'bg-green-400' : 'bg-blue-400') : 'bg-gray-500'}`} />
                {mcpRunning ? (mcpMode === 'local' ? '本地模式' : '运行中（HTTP）') : (wikiRunning ? '未启动' : '未启动（依赖KMA Server）')}
              </span>
              <button
                disabled={!mcpRunning && !wikiRunning}
                onClick={mcpRunning ? onStopMcp : onStartMcp}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  !mcpRunning && !wikiRunning
                    ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                    : mcpRunning
                      ? (theme === 'dark'
                        ? 'bg-red-600 hover:bg-red-700 text-white'
                        : theme === 'light'
                          ? 'bg-red-500 hover:bg-red-600 text-white'
                          : 'bg-red-600 hover:bg-red-700 text-white')
                      : (theme === 'dark'
                        ? 'bg-green-600 hover:bg-green-700 text-white'
                        : theme === 'light'
                          ? 'bg-green-500 hover:bg-green-600 text-white'
                          : 'bg-green-600 hover:bg-green-700 text-white')
                }`}
              >
                {mcpRunning ? '停止' : '启动'}
              </button>
            </div>
          </div>

          {/* 在线搜索配置 */}
          <div className={`pt-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
            <h4 className={`text-sm font-medium mb-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>在线搜索配置</h4>
            <div className="space-y-3">
              <div>
                <label className={`text-xs mb-1 block ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>默认搜索引擎</label>
                <select
                  value={searchEngine}
                  onChange={(e) => setSearchEngine(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-all ${
                    theme === 'dark'
                      ? 'bg-gray-700 text-white'
                      : theme === 'light'
                        ? 'bg-gray-50 text-gray-900 border border-gray-200'
                        : 'bg-gray-500 text-white'
                  }`}
                >
                  <option value="bing">Bing</option>
                  <option value="duckduckgo">DuckDuckGo</option>
                  <option value="searxng">SearXNG</option>
                </select>
              </div>
              {searchEngine === 'searxng' && (
                <div>
                  <label className={`text-xs mb-1 block ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>SearXNG 服务地址</label>
                  <input
                    type="text"
                    value={searxngUrl}
                    onChange={(e) => setSearxngUrl(e.target.value)}
                    placeholder="如 http://localhost:8080"
                    className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-all ${
                      theme === 'dark'
                        ? 'bg-gray-700 text-white placeholder-gray-500'
                        : theme === 'light'
                          ? 'bg-gray-50 text-gray-900 border border-gray-200 placeholder-gray-400'
                          : 'bg-gray-500 text-white placeholder-gray-400'
                    }`}
                  />
                </div>
              )}
              <div>
                <label className={`text-xs mb-1 block ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>网络代理</label>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                  className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-all ${
                    theme === 'dark'
                      ? 'bg-gray-700 text-white placeholder-gray-500'
                      : theme === 'light'
                        ? 'bg-gray-50 text-gray-900 border border-gray-200 placeholder-gray-400'
                        : 'bg-gray-500 text-white placeholder-gray-400'
                  }`}
                />
                <p className={`mt-1 text-[10px] ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                  支持 HTTP/HTTPS/SOCKS5 代理，留空则使用系统环境变量
                </p>
              </div>
            </div>
          </div>

          {/* 进程树 */}
          <div className={`pt-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
            <div className="flex items-center justify-between mb-3">
              <h4 className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>进程树</h4>
              <button
                onClick={onRefreshProcessTree}
                disabled={processTreeLoading}
                className={`px-3 py-1 rounded text-xs transition-all ${
                  theme === 'dark'
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : theme === 'light'
                      ? 'bg-blue-500 hover:bg-blue-600 text-white'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                } disabled:opacity-50`}
              >
                {processTreeLoading ? '查询中...' : '刷新'}
              </button>
            </div>
            {processTreeError && (
              <div className={`text-xs mb-2 ${theme === 'dark' ? 'text-red-400' : 'text-red-500'}`}>
                查询失败: {processTreeError}
              </div>
            )}
            {processTree.length === 0 && !processTreeLoading && !processTreeError && (
              <div className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                点击"刷新"查看当前工具管理的进程树
              </div>
            )}
            <div className={`max-h-80 overflow-auto rounded-lg p-2 ${
              theme === 'dark' ? 'bg-gray-900/50' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-700/50'
            }`}>
              {processTree.map((node, i) => (
                <ProcessTreeNode key={`${node.pid}-${i}`} node={node} depth={0} theme={theme} onKill={onKillProcess} killPid={killPid} />
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
