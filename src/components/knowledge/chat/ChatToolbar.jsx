import React from 'react';
import { Image, Loader2, RefreshCw, Trash2, Save } from 'lucide-react';

export default function ChatToolbar({
  theme,
  setShowImageModal,
  targetFileType,
  fetchPptTasks, pptTasksLoading, isTyping, isChrysBusy,
  handleClearHistory, handleSaveHistory,
  savedModels, selectedModelConfigId, selectModelConfig,
}) {
  return (
    <div className="flex items-center justify-between mt-3">
      <div className="flex gap-2 flex-shrink-0">
        <button
          onClick={() => setShowImageModal(true)}
          className={`flex items-center justify-center whitespace-nowrap px-3 py-2 rounded-lg transition-all text-sm ${
            theme === 'dark'
              ? 'bg-indigo-600 hover:bg-indigo-700 text-white active:bg-indigo-800'
              : theme === 'light'
                ? 'bg-indigo-500 hover:bg-indigo-600 text-white active:bg-indigo-700'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white active:bg-indigo-800'
          }`}
          title="添加图片"
        >
          <Image className="w-4 h-4" />
        </button>
        {targetFileType === 'slides' && (
          <button
            onClick={fetchPptTasks}
            disabled={pptTasksLoading || isTyping || isChrysBusy}
            className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-lg transition-all text-sm ${
              theme === 'dark'
                ? 'bg-gray-600 hover:bg-gray-500 text-gray-200 disabled:bg-gray-700 disabled:text-gray-500'
                : theme === 'light'
                  ? 'bg-gray-200 hover:bg-gray-300 text-gray-700 disabled:bg-gray-100 disabled:text-gray-400'
                  : 'bg-gray-500 hover:bg-gray-400 text-white disabled:text-gray-400'
            }`}
            title="从已保存的 PPT 任务继续渲染"
          >
            {pptTasksLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            继续上次任务
          </button>
        )}
        {targetFileType !== 'slides' && (
          <>
            <button
              onClick={handleClearHistory}
              className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-lg transition-all text-sm ${
                theme === 'dark'
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white active:bg-indigo-800'
                  : theme === 'light'
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white active:bg-indigo-700'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white active:bg-indigo-800'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              清除历史
            </button>
            <button
              onClick={handleSaveHistory}
              className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-lg transition-all text-sm ${
                theme === 'dark'
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white active:bg-indigo-800'
                  : theme === 'light'
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white active:bg-indigo-700'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white active:bg-indigo-800'
              }`}
            >
              <Save className="w-3.5 h-3.5" />
              保存对话
            </button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
          已选模型：
        </span>
        <select
          value={selectedModelConfigId}
          onChange={(e) => selectModelConfig(e.target.value)}
          className={`text-xs px-2 py-1 rounded outline-none transition-all ${
            theme === 'dark'
              ? 'bg-gray-700 text-gray-300'
              : theme === 'light'
                ? 'bg-gray-100 text-gray-600 border border-gray-200'
                : 'bg-gray-500 text-gray-300'
          }`}
        >
          {savedModels.filter(m => m.type === 'chat').map(model => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
