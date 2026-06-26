import React from 'react';
import { Settings, X, FolderOpen } from 'lucide-react';
import { DEFAULT_CODE_PROMPT, DEFAULT_CODE_AGENT } from '../shared/constants';

// 代码生成设置弹窗
export default function CodeSettingsModal({
  theme,
  codeOutputDir, setCodeOutputDir,
  codePromptTemplate, setCodePromptTemplate,
  codeAgent, setCodeAgent, codeAgentList,
  refocusInput,
  writeMemoryFile,
  onClose,
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className={`rounded-2xl shadow-2xl w-[520px] overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className={`px-5 py-3.5 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <Settings className="w-5 h-5" />
          </div>
          <h3 className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
            代码生成设置
          </h3>
          <button onClick={onClose} className={`ml-auto p-1 rounded-lg transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 设置内容 */}
        <div className="p-5 space-y-5">
          {/* 输出目录 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              代码保存目录
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={codeOutputDir}
                onChange={(e) => setCodeOutputDir(e.target.value)}
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
                  if (result) setCodeOutputDir(Array.isArray(result) ? result[0] : result);
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
            {codeOutputDir && (
              <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                代码将保存至: {codeOutputDir}/code 文件夹
              </p>
            )}
          </div>

          {/* 提示词模板 */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              生成提示词模板
            </label>
            <textarea
              value={codePromptTemplate}
              onChange={(e) => setCodePromptTemplate(e.target.value)}
              rows={4}
              placeholder={DEFAULT_CODE_PROMPT}
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
              value={codeAgent}
              onChange={(e) => setCodeAgent(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                theme === 'dark'
                  ? 'bg-gray-700 border-gray-600 text-gray-200 focus:border-indigo-500'
                  : theme === 'light'
                    ? 'bg-white border-gray-200 text-gray-800 focus:border-indigo-400'
                    : 'bg-gray-600 border-gray-500 text-gray-200 focus:border-indigo-500'
              }`}
            >
              {codeAgentList.length > 0 ? codeAgentList.map(name => (
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
              选择用于生成代码的 Chrys Agent
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={`px-5 py-3.5 border-t flex justify-between gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/30' : theme === 'light' ? 'border-gray-100 bg-gray-50/30' : 'border-gray-600 bg-gray-700/30'}`}>
          <button
            onClick={() => {
              setCodeOutputDir('');
              setCodePromptTemplate(DEFAULT_CODE_PROMPT);
              setCodeAgent(DEFAULT_CODE_AGENT);
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
                  codeSettings: {
                    outputDir: codeOutputDir,
                    promptTemplate: codePromptTemplate,
                    agent: codeAgent,
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
