import React from 'react';
import { Folder, X } from 'lucide-react';

// 文件/目录浏览弹窗
export default function BrowseModal({
  theme,
  browseMode,
  currentPath,
  parentPath,
  fileSystemItems,
  onNavigateUp,
  onNavigateTo,
  onConfirmSelection,
  onClose,
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`rounded-2xl shadow-2xl overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`} style={{ width: '600px', height: '450px', display: 'flex', flexDirection: 'column' }}>
        {/* 弹窗头部 */}
        <div className={`px-5 py-3.5 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <Folder className="w-5 h-5" />
          </div>
          <h3 className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
            {browseMode === 'file' ? '选择文件' : '选择目录'}
          </h3>
          <button onClick={onClose} className={`ml-auto p-1 rounded-lg transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 导航栏 */}
        <div className={`px-4 py-2 border-b flex items-center gap-2 ${theme === 'dark' ? 'border-gray-600 bg-gray-800' : theme === 'light' ? 'border-gray-200 bg-gray-50' : 'border-gray-500 bg-gray-600'}`}>
          <button
            onClick={onNavigateUp}
            disabled={!parentPath && currentPath === ''}
            className={`p-1.5 rounded transition-all ${
              (!parentPath && currentPath === '')
                ? 'opacity-30 cursor-not-allowed'
                : `${theme === 'dark' ? 'hover:bg-gray-700' : theme === 'light' ? 'hover:bg-gray-200' : 'hover:bg-gray-500'}`
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className={`flex-1 text-sm truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`}>
            {currentPath || '根目录'}
          </div>
        </div>

        {/* 文件列表 */}
        <div className="flex-1 overflow-auto p-2">
          {fileSystemItems.length === 0 ? (
            <div className={`text-center py-8 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              加载中...
            </div>
          ) : (
            <div className="space-y-1">
              {fileSystemItems.map((item, index) => (
                <div
                  key={index}
                  onClick={() => onNavigateTo(item)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all ${
                    theme === 'dark'
                      ? 'hover:bg-gray-600'
                      : theme === 'light'
                        ? 'hover:bg-gray-100'
                        : 'hover:bg-gray-500'
                  }`}
                >
                  {item.type === 'directory' || item.type === 'drive' ? (
                    <svg className={`w-5 h-5 flex-shrink-0 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-500' : 'text-indigo-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                    </svg>
                  ) : (
                    <svg className={`w-5 h-5 flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                  )}
                  <span className={`flex-1 text-sm truncate ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                    {item.name}
                  </span>
                  {item.type === 'file' && (
                    <span className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {item.size ? (item.size / 1024).toFixed(1) + ' KB' : ''}
                    </span>
                  )}
                  {(item.type === 'directory' || item.type === 'drive') && (
                    <svg className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className={`flex justify-end gap-3 p-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
          <button
            onClick={onClose}
            className={`px-4 py-2 rounded-lg text-sm transition-all ${
              theme === 'dark'
                ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                : theme === 'light'
                  ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  : 'bg-gray-400 hover:bg-gray-300 text-gray-300'
            }`}
          >
            取消
          </button>
          {browseMode === 'directory' && currentPath && (
            <button
              onClick={onConfirmSelection}
              className={`px-4 py-2 rounded-lg text-sm transition-all ${
                theme === 'dark'
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : theme === 'light'
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              选择此目录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
