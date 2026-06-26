import React from 'react';
import { Database, X, Folder, Plus } from 'lucide-react';

// 创建知识库弹窗
const CreateKbModal = React.memo(function CreateKbModal({
  theme,
  newKBName, setNewKBName,
  newKBPath, setNewKBPath,
  newKBNameInputRef, newKBPathInputRef,
  lastKbDir, saveMemory,
  onCreate,
  onClose,
}) {
  const handleClose = () => {
    setNewKBName('');
    setNewKBPath('');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={handleClose}>
      <div
        className={`rounded-2xl shadow-2xl w-[480px] overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className={`px-6 py-4 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <Database className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
              创建知识库
            </h3>
            <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              知识库将以项目文件夹形式存放在指定位置
            </p>
          </div>
          <button
            onClick={handleClose}
            className={`ml-auto p-1.5 rounded-lg transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-6 py-5 space-y-4">
          {/* 知识库名称 */}
          <div>
            <label className={`block text-sm font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              知识库名称 <span className="text-red-400">*</span>
            </label>
            <input
              ref={newKBNameInputRef}
              type="text"
              value={newKBName}
              onChange={(e) => setNewKBName(e.target.value)}
              placeholder="例: 我的研究项目"
              className={`w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all border ${
                theme === 'dark'
                  ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                  : theme === 'light'
                    ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400'
                    : 'bg-gray-600 border-gray-500 text-white placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
              }`}
            />
          </div>

          {/* 知识库存放路径 */}
          <div>
            <label className={`block text-sm font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
              存放路径 <span className="text-red-400">*</span>
            </label>
            <div className="flex gap-2">
              <input
                ref={newKBPathInputRef}
                type="text"
                value={newKBPath}
                onChange={(e) => setNewKBPath(e.target.value)}
                placeholder="例: D:\Knowledge_Management"
                className={`flex-1 px-4 py-2.5 rounded-xl text-sm outline-none transition-all border ${
                  theme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                    : theme === 'light'
                      ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400'
                      : 'bg-gray-600 border-gray-500 text-white placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                }`}
              />
              <button
                onClick={async () => {
                  try {
                    const { ipcRenderer } = window.require('electron');
                    const fs = window.require('fs');
                    let dp = lastKbDir || undefined;
                    if (dp && !fs.existsSync(dp)) dp = undefined;
                    const selectedPath = await ipcRenderer.invoke('open-file-dialog', {
                      properties: ['openDirectory'],
                      ...(dp ? { defaultPath: dp } : {}),
                    });
                    if (selectedPath) {
                      const dir = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
                      setNewKBPath(dir);
                      saveMemory(dir);
                    }
                  } catch (err) {
                    console.error('Browse dialog failed:', err);
                  }
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5 ${
                  theme === 'dark'
                    ? 'bg-gray-600 hover:bg-gray-500 text-gray-200 border border-gray-500'
                    : theme === 'light'
                      ? 'bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200'
                      : 'bg-gray-500 hover:bg-gray-400 text-gray-200 border border-gray-400'
                }`}
              >
                <Folder className="w-4 h-4" />
                浏览
              </button>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={`px-6 py-4 border-t flex justify-end gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/30' : theme === 'light' ? 'border-gray-100 bg-gray-50/30' : 'border-gray-600 bg-gray-700/30'}`}>
          <button
            onClick={handleClose}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark'
                ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                : theme === 'light'
                  ? 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                  : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
            }`}
          >
            取消
          </button>
          <button
            onClick={onCreate}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
              theme === 'dark'
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25'
                : theme === 'light'
                  ? 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-lg shadow-indigo-500/25'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25'
            }`}
          >
            <Plus className="w-4 h-4" />
            创建
          </button>
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // 仅比较关键 props，忽略回调函数引用变化（避免父组件因无关状态重渲染时连带刷新弹窗）
  return prevProps.newKBName === nextProps.newKBName &&
    prevProps.newKBPath === nextProps.newKBPath &&
    prevProps.theme === nextProps.theme &&
    prevProps.lastKbDir === nextProps.lastKbDir;
});

export default CreateKbModal;
