import React from 'react';
import { Settings, X, FolderOpen } from 'lucide-react';
import { DEFAULT_PPT_PROMPT, DEFAULT_PPT_AGENT } from '../shared/constants';

// PPT 生成设置弹窗
export default function PptSettingsModal({
  theme,
  outputDir, setOutputDir,
  pptTemplate, setPptTemplate,
  referencePptx, setReferencePptx,
  pptPromptTemplate, setPptPromptTemplate,
  pptAgent, setPptAgent, pptAgentList,
  pptSvgMaxWorkers, setPptSvgMaxWorkers,
  refocusInput,
  writeMemoryFile,
  onClose,
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className={`rounded-2xl shadow-2xl w-[520px] max-h-[90vh] overflow-hidden flex flex-col ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className={`px-5 py-3.5 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <Settings className="w-5 h-5" />
          </div>
          <h3 className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
            PPT 生成设置
          </h3>
          <button onClick={onClose} className={`ml-auto p-1 rounded-lg transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 设置内容 */}
        <div className="p-5 space-y-5 overflow-y-auto">
          {/* 输出目录 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              PPT 保存目录
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="留空则保存在当前目录"
                className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                  theme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-gray-200 placeholder-gray-500 focus:border-indigo-500'
                    : theme === 'light'
                      ? 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-indigo-400'
                      : 'bg-gray-600 border-gray-500 text-gray-200 placeholder-gray-500 focus:border-indigo-500'
                }`}
              />
              <button
                onClick={async () => {
                  const { ipcRenderer } = window.require('electron');
                  const result = await ipcRenderer.invoke('open-file-dialog', { properties: ['openDirectory'] });
                  if (result) setOutputDir(Array.isArray(result) ? result[0] : result);
                  refocusInput();
                }}
                className={`px-3 py-2 rounded-lg text-sm transition-all flex items-center gap-1.5 ${
                  theme === 'dark'
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600'
                    : theme === 'light'
                      ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-200'
                      : 'bg-gray-600 hover:bg-gray-500 text-gray-300 border border-gray-500'
                }`}
              >
                <FolderOpen className="w-4 h-4" />
                浏览
              </button>
            </div>
            {outputDir && (
              <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                PPT 将保存至: {outputDir}/ppt 文件夹
              </p>
            )}
          </div>

          {/* 内置模板 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              PPT 模板
            </label>
            <select
              value={pptTemplate}
              onChange={(e) => setPptTemplate(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                theme === 'dark'
                  ? 'bg-gray-700 border-gray-600 text-gray-200 focus:border-indigo-500'
                  : theme === 'light'
                    ? 'bg-white border-gray-200 text-gray-800 focus:border-indigo-400'
                    : 'bg-gray-600 border-gray-500 text-gray-200 focus:border-indigo-500'
              }`}
            >
              <option value="default">自动匹配</option>
              <option value="huawei_standard">Huawei 标准企业模板</option>
            </select>
            <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              Huawei 模板将锁定浅色企业配色、页面骨架和品牌背景资源。
            </p>
          </div>

          {/* 参考 PPTX 文件 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              参考 PPTX 文件（自动提取配色/字体）
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={referencePptx}
                onChange={(e) => setReferencePptx(e.target.value)}
                placeholder="留空则不使用参考样式，如 E:/template.pptx"
                className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                  theme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-gray-200 placeholder-gray-500 focus:border-indigo-500'
                    : theme === 'light'
                      ? 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-indigo-400'
                      : 'bg-gray-600 border-gray-500 text-gray-200 placeholder-gray-500 focus:border-indigo-500'
                }`}
              />
              <button
                onClick={async () => {
                  const { ipcRenderer } = window.require('electron');
                  const result = await ipcRenderer.invoke('open-file-dialog', {
                    properties: ['openFile'],
                    filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
                  });
                  if (result) setReferencePptx(Array.isArray(result) ? result[0] : result);
                }}
                className={`px-3 py-2 rounded-lg text-sm transition-all flex items-center gap-1.5 ${
                  theme === 'dark'
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600'
                    : theme === 'light'
                      ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-200'
                      : 'bg-gray-600 hover:bg-gray-500 text-gray-300 border border-gray-500'
                }`}
              >
                <FolderOpen className="w-4 h-4" />
                浏览
              </button>
            </div>
            {referencePptx && (
              <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                将自动提取配色方案、字体家族，沿用参考 PPT 的视觉风格
              </p>
            )}
          </div>

          {/* 提示词模板 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              生成提示词模板
            </label>
            <textarea
              value={pptPromptTemplate}
              onChange={(e) => setPptPromptTemplate(e.target.value)}
              rows={4}
              placeholder={DEFAULT_PPT_PROMPT}
              className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all resize-none ${
                theme === 'dark'
                  ? 'bg-gray-700 border-gray-600 text-gray-200 placeholder-gray-500 focus:border-indigo-500'
                  : theme === 'light'
                    ? 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-indigo-400'
                    : 'bg-gray-600 border-gray-500 text-gray-200 placeholder-gray-500 focus:border-indigo-500'
              }`}
            />
            <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              用户的输入将追加在此模板之后
            </p>
          </div>

          {/* Agent 选择 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              生成 Agent
            </label>
            <select
              value={pptAgent}
              onChange={(e) => setPptAgent(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                theme === 'dark'
                  ? 'bg-gray-700 border-gray-600 text-gray-200 focus:border-indigo-500'
                  : theme === 'light'
                    ? 'bg-white border-gray-200 text-gray-800 focus:border-indigo-400'
                    : 'bg-gray-600 border-gray-500 text-gray-200 focus:border-indigo-500'
              }`}
            >
              {pptAgentList.length > 0 ? pptAgentList.map(name => (
                <option key={name} value={name}>{name}</option>
              )) : (
                <>
                  <option value="Code">Code</option>
                  <option value="QA">QA</option>
                  <option value="Code-with-LLM-wiki">Code-with-LLM-wiki</option>
                </>
              )}
            </select>
            <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              选择用于生成 PPT 的 Chrys Agent
            </p>
          </div>

          {/* SVG 并发数 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              SVG 生成并发数
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="8"
                value={pptSvgMaxWorkers}
                onChange={(e) => setPptSvgMaxWorkers(Number(e.target.value))}
                className="flex-1 accent-indigo-500"
              />
              <span className={`text-sm font-mono w-6 text-right ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                {pptSvgMaxWorkers}
              </span>
            </div>
            <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              同时生成页面的线程数，越大越快但受 API 限频影响（1-8，推荐 4）
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={`px-5 py-3.5 border-t flex justify-between gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/30' : theme === 'light' ? 'border-gray-100 bg-gray-50/30' : 'border-gray-600 bg-gray-700/30'}`}>
          <button
            onClick={() => {
              setOutputDir('');
              setPptTemplate('default');
              setPptPromptTemplate(DEFAULT_PPT_PROMPT);
              setPptAgent(DEFAULT_PPT_AGENT);
            }}
            className={`px-4 py-2 rounded-xl text-sm transition-all ${
              theme === 'dark' ? 'text-gray-500 hover:text-gray-300' : theme === 'light' ? 'text-gray-400 hover:text-gray-600' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            恢复默认
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${
                theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : theme === 'light' ? 'bg-gray-100 hover:bg-gray-200 text-gray-600' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
              }`}
            >
              取消
            </button>
            <button
              onClick={() => {
                writeMemoryFile({
                  pptSettings: {
                    outputDir: outputDir,
                    template: pptTemplate,
                    referencePptx: referencePptx,
                    promptTemplate: pptPromptTemplate,
                    agent: pptAgent,
                    svgMaxWorkers: pptSvgMaxWorkers,
                  },
                });
                onClose();
              }}
              className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${
                theme === 'dark'
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : theme === 'light'
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
