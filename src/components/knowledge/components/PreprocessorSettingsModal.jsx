import React, { useState, useEffect, useRef } from 'react';
import { X, Cog, ToggleLeft, ToggleRight, Server, Clock, Wifi, WifiOff, Loader2, RefreshCw, Play, Square, Terminal } from 'lucide-react';

export const DEFAULT_PROCESSORS = {
  cloudmodeling_plantuml: {
    name: 'CloudModeling PlantUML 转换',
    description: '将 Markdown 中的 CloudModeling diagram URL 转换为 PlantUML 代码块',
    enabled: true,
  },
  cloudmodeling_svg: {
    name: 'CloudModeling SVG 导出',
    description: 'PlantUML 转换失败时，回退导出为 SVG 图片引用',
    enabled: true,
  },
  image_to_desc: {
    name: '图片结构化分析 (image_to_desc)',
    description: '用 Vision LLM 将文档中图片转为结构化图表描述（Mermaid/表格/代码）',
    enabled: false,
  },
};

export default function PreprocessorSettingsModal({
  show,
  preprocessorConfig,
  setPreprocessorConfig,
  userInfo,
  theme,
  onClose,
  onSave,
  autoManage,
  onToggleAutoManage,
  serviceStatus,
  onSetupService,
  onStopService,
}) {
  const cfg = preprocessorConfig || {};
  const processors = cfg.processors || DEFAULT_PROCESSORS;

  const inputClass = `w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all border ${
    theme === 'dark'
      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
      : theme === 'light'
        ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400'
        : 'bg-gray-600 border-gray-500 text-white placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
  }`;

  const toggleProcessor = (key) => {
    const updated = { ...cfg, processors: { ...processors, [key]: { ...processors[key], enabled: !processors[key].enabled } } };
    setPreprocessorConfig(updated);
  };

  const updateField = (field, value) => {
    setPreprocessorConfig({ ...cfg, [field]: value });
  };

  const [connStatus, setConnStatus] = useState(null); // null=idle, 'checking', 'connected', 'disconnected'

  const checkConnection = () => {
    const port = cfg.port || 5900;
    const url = `http://127.0.0.1:${port}`;
    setConnStatus('checking');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    fetch(url, { method: 'HEAD', signal: controller.signal })
      .then(() => { setConnStatus('connected'); clearTimeout(timeoutId); })
      .catch(() => { setConnStatus('disconnected'); clearTimeout(timeoutId); });
  };

  useEffect(() => {
    if (!show) return;
    checkConnection();
  }, [show, cfg.port]);

  const ss = serviceStatus || {};

  // 日志面板自动滚动
  const logEndRef = useRef(null);
  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [ss.logs]);

  const statusBadge = () => {
    if (connStatus === 'checking' || ss.status === 'starting') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-600 dark:text-yellow-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          {ss.status === 'starting' ? '启动中' : '检测中'}
        </span>
      );
    }
    if (connStatus === 'connected' || ss.status === 'running') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Wifi className="w-3 h-3" />
          已连接
        </span>
      );
    }
    if (connStatus === 'disconnected') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-600 dark:text-red-400">
          <WifiOff className="w-3 h-3" />
          未连接
        </span>
      );
    }
    return null;
  };

  const btnSmClass = `px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
    theme === 'dark' ? 'text-gray-300 hover:text-white hover:bg-gray-600' : theme === 'light' ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-200' : 'text-gray-300 hover:text-white hover:bg-gray-500'
  }`;

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className={`rounded-2xl shadow-2xl w-[520px] max-h-[85vh] overflow-hidden flex flex-col ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className={`px-6 py-4 border-b flex items-center gap-3 flex-shrink-0 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${theme === 'dark' ? 'bg-emerald-500/20 text-emerald-400' : theme === 'light' ? 'bg-emerald-100 text-emerald-600' : 'bg-emerald-500/20 text-emerald-400'}`}>
            <Cog className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
              文档预处理设置
            </h3>
            <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              导入 Markdown 文档时自动转换 CloudModeling 图表
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-all flex-shrink-0 ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 可滚动内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* 服务管理 */}
          <div>
            <h4 className={`flex items-center gap-2 text-sm font-semibold mb-3 ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
              <Server className="w-4 h-4" />
              服务管理
            </h4>
            <div className="space-y-3">
              {/* 自动管理开关 */}
              <div className={`flex items-center justify-between p-3 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-600/50'}`}>
                <div>
                  <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                    自动管理服务
                  </div>
                  <div className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                    从远端下载并启动 cloudmodeling-processor
                  </div>
                </div>
                <button onClick={onToggleAutoManage} className="flex-shrink-0 transition-colors">
                  {autoManage ? (
                    <ToggleRight className="w-7 h-7 text-emerald-500 hover:text-emerald-400" />
                  ) : (
                    <ToggleLeft className={`w-7 h-7 ${theme === 'dark' ? 'text-gray-500 hover:text-gray-400' : 'text-gray-400 hover:text-gray-500'}`} />
                  )}
                </button>
              </div>

              {/* 手动启动/停止按钮 */}
              {autoManage && (
                <div className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-600/50'}`}>
                  <div className="flex items-center gap-2">
                    <span className={theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}>
                      服务状态
                    </span>
                    {statusBadge()}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={checkConnection}
                      disabled={connStatus === 'checking'}
                      className={`p-1 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-gray-600' : theme === 'light' ? 'text-gray-400 hover:text-gray-600 hover:bg-gray-200' : 'text-gray-400 hover:text-white hover:bg-gray-500'}`}
                      title="重新检测"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${connStatus === 'checking' ? 'animate-spin' : ''}`} />
                    </button>
                    {connStatus === 'connected' ? (
                      <button
                        onClick={onStopService}
                        disabled={ss.status === 'stopping'}
                        className={`${btnSmClass} text-red-400 hover:text-red-300 hover:bg-red-500/10`}
                        title="停止服务"
                      >
                        <Square className="w-3 h-3" />
                        停止
                      </button>
                    ) : (
                      <button
                        onClick={onSetupService}
                        disabled={ss.status === 'starting'}
                        className={btnSmClass}
                        title="启动服务"
                      >
                        <Play className="w-3 h-3" />
                        启动
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* 状态信息 */}
              {ss.message && (
                <div className={`px-3 py-1.5 rounded-lg text-xs ${
                  ss.status === 'error'
                    ? (theme === 'dark' ? 'bg-red-500/10 text-red-400' : theme === 'light' ? 'bg-red-50 text-red-600' : 'bg-red-500/10 text-red-400')
                    : (theme === 'dark' ? 'bg-emerald-500/10 text-emerald-400' : theme === 'light' ? 'bg-emerald-50 text-emerald-600' : 'bg-emerald-500/10 text-emerald-400')
                }`}>
                  {ss.message}
                </div>
              )}

              {/* 日志面板 */}
              {autoManage && ss.logs && ss.logs.length > 0 && (
                <div className={`rounded-xl overflow-hidden border ${theme === 'dark' ? 'border-gray-600 bg-gray-800/80' : theme === 'light' ? 'border-gray-200 bg-gray-100' : 'border-gray-500 bg-gray-600/80'}`}>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 border-b text-xs font-medium ${theme === 'dark' ? 'border-gray-600 text-gray-400 bg-gray-700/50' : theme === 'light' ? 'border-gray-200 text-gray-500 bg-gray-100' : 'border-gray-500 text-gray-400 bg-gray-500/50'}`}>
                    <Terminal className="w-3 h-3" />
                    控制台
                    <span className={`ml-auto ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-400'}`}>{ss.logs.length} 条消息</span>
                  </div>
                  <div className="max-h-32 overflow-y-auto p-2 space-y-0.5 font-mono text-[10px] leading-relaxed">
                    {ss.logs.map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.includes('错误')
                            ? (theme === 'dark' ? 'text-red-400' : 'text-red-600')
                            : line.includes('[完成]') || line.includes('已就绪') || line.includes('成功')
                              ? (theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600')
                              : (theme === 'dark' ? 'text-gray-400' : 'text-gray-600')
                        }
                      >
                        {line}
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}

              {/* 连接配置 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={`block text-xs font-medium mb-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                    端口
                  </label>
                  <input
                    type="number"
                    value={cfg.port || 5900}
                    onChange={(e) => updateField('port', parseInt(e.target.value) || 5900)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                    超时 (秒)
                  </label>
                  <div className="relative">
                    <Clock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`} />
                    <input
                      type="number"
                      value={cfg.timeout_seconds || 300}
                      onChange={(e) => updateField('timeout_seconds', parseInt(e.target.value) || 300)}
                      className={`${inputClass} pl-10`}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 预处理项 */}
          <div className={`pt-4 border-t ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-100' : 'border-gray-600'}`}>
            <h4 className={`flex items-center gap-2 text-sm font-semibold mb-3 ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
              <Cog className="w-4 h-4" />
              预处理项
            </h4>
            <div className="space-y-2">
              {Object.entries(processors).map(([key, proc]) => (
                <div
                  key={key}
                  className={`flex items-center justify-between p-3 rounded-xl transition-all ${
                    theme === 'dark' ? 'bg-gray-700/50 hover:bg-gray-700' : theme === 'light' ? 'bg-gray-50 hover:bg-gray-100' : 'bg-gray-600/50 hover:bg-gray-600'
                  }`}
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                      {proc.name}
                    </div>
                    <div className={`text-xs mt-0.5 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                      {proc.description}
                    </div>
                  </div>
                  <button
                    onClick={() => toggleProcessor(key)}
                    className={`flex-shrink-0 transition-colors ${
                      proc.enabled
                        ? 'text-emerald-500 hover:text-emerald-400'
                        : theme === 'dark' ? 'text-gray-500 hover:text-gray-400' : 'text-gray-400 hover:text-gray-500'
                    }`}
                    title={proc.enabled ? '已开启，点击关闭' : '已关闭，点击开启'}
                  >
                    {proc.enabled ? (
                      <ToggleRight className="w-7 h-7" />
                    ) : (
                      <ToggleLeft className="w-7 h-7" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={`px-6 py-4 border-t flex justify-end gap-3 flex-shrink-0 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/30' : theme === 'light' ? 'border-gray-100 bg-gray-50/30' : 'border-gray-600 bg-gray-700/30'}`}>
          <button
            onClick={onClose}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : theme === 'light' ? 'bg-gray-100 hover:bg-gray-200 text-gray-600' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
            }`}
          >
            取消
          </button>
          <button
            onClick={onSave}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-lg shadow-indigo-500/25' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25'
            }`}
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
