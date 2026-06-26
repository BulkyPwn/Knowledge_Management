import React from 'react';
import { FileText, Folder, X } from 'lucide-react';
import FileTreeNode from './FileTreeNode';

// 知识库文件列表弹窗
export default function KbFileListModal({ theme, fileTree, selectedKbNames, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`rounded-2xl shadow-2xl overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`} style={{ width: '600px', maxHeight: '500px', display: 'flex', flexDirection: 'column' }}>
        {/* 弹窗头部 */}
        <div className={`px-5 py-3.5 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
              知识库文件列表
            </h3>
            <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              {selectedKbNames || '未选择'}
            </p>
          </div>
          <button onClick={onClose} className={`ml-auto p-1 rounded-lg transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 文件列表 */}
        <div className="flex-1 overflow-auto p-4">
          {fileTree.length === 0 ? (
            <div className={`text-center py-12 text-sm ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              <Folder className="w-8 h-8 mx-auto mb-2 opacity-40" />
              暂无文件
            </div>
          ) : (
            <div>
              {fileTree.map((node, i) => (
                <FileTreeNode key={`${node.name}-${i}`} node={node} depth={0} theme={theme} defaultExpanded={1} />
              ))}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className={`px-5 py-3.5 border-t flex justify-end gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/30' : theme === 'light' ? 'border-gray-100 bg-gray-50/30' : 'border-gray-600 bg-gray-700/30'}`}>
          <button
            onClick={onClose}
            className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : theme === 'light' ? 'bg-gray-100 hover:bg-gray-200 text-gray-600' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
            }`}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
