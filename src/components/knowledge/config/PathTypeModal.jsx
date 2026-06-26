import React from 'react';
import { Folder, FileText, X } from 'lucide-react';

// 路径类型选择弹窗：选择文件 / 选择目录
export default function PathTypeModal({ theme, onSelectFile, onSelectDirectory, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`rounded-2xl shadow-2xl w-[360px] overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}>
        <div className={`px-5 py-4 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <Folder className="w-5 h-5" />
          </div>
          <h3 className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>选择路径类型</h3>
          <button onClick={onClose} className={`ml-auto p-1 rounded-lg transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-2.5">
          <button
            onClick={onSelectFile}
            className={`w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            <FileText className="w-5 h-5" />
            选择文件
          </button>
          <button
            onClick={onSelectDirectory}
            className={`w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            <Folder className="w-5 h-5" />
            选择目录
          </button>
          <button
            onClick={onClose}
            className={`w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600' : theme === 'light' ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-200' : 'bg-gray-600 hover:bg-gray-500 text-gray-300 border border-gray-500'
            }`}
          >
            <X className="w-5 h-5" />
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
