import React, { useState, useCallback } from 'react';
import { X, Upload, Link, ExternalLink, BarChart3, Folder, FileText, Trash2, Database, AlertTriangle, Search } from 'lucide-react';
import KnowledgeFileTreeNode from '../shared/KnowledgeFileTreeNode';

// 定义在模块顶层，避免在 KBSettingsModal 内部重新创建导致 React 卸载/重新挂载子树
function KbFileTreeNode({ node, depth, theme, onDeleteKnowledge }) {
  return (
    <KnowledgeFileTreeNode
      node={node}
      depth={depth}
      theme={theme}
      onDelete={onDeleteKnowledge}
      showDelete={true}
    />
  );
}

export default function KBSettingsModal({
  show,
  editingKB,
  editingKBName, setEditingKBName,
  editingKBDesc, setEditingKBDesc,
  showUrlInput, setShowUrlInput,
  urlInputValue, setUrlInputValue,
  kbKnowledgeList,
  kbKnowledgeTree,
  kbKnowledgeLoading,
  theme,
  kbStatus,
  onClose,
  onSave,
  onDelete,
  onDeleteKnowledge,
  onImportFiles,
  onImportFolders,
  onImportUrl,
  onConfirmImportUrl,
  onOpenWikiWindow,
  onOpenVector,
  onOpenSearchImport,
}) {
  if (!show || !editingKB) return null;

  const [showConfirmClose, setShowConfirmClose] = useState(false);

  // 检测是否有未保存的修改
  const hasUnsavedChanges = useCallback(() => {
    const originalName = editingKB.name || '';
    const originalDesc = editingKB.description || '';
    return (editingKBName || '').trim() !== originalName.trim() ||
           (editingKBDesc || '').trim() !== originalDesc.trim();
  }, [editingKB, editingKBName, editingKBDesc]);

  const handleClose = () => {
    if (hasUnsavedChanges()) {
      setShowConfirmClose(true);
    } else {
      onClose();
    }
  };

  const handleDiscardAndClose = () => {
    setShowConfirmClose(false);
    setEditingKBName(editingKB.name || '');
    setEditingKBDesc(editingKB.description || '');
    onClose();
  };

  const inputClass = `w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all border ${
    theme === 'dark'
      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
      : theme === 'light'
        ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400'
        : 'bg-gray-600 border-gray-500 text-white placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
  }`;

  const btnPrimary = `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
    theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
  }`;

  const btnOutline = `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
    theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600' : theme === 'light' ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-200' : 'bg-gray-600 hover:bg-gray-500 text-gray-300 border border-gray-500'
  }`;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={handleClose}>
      <div
        className={`rounded-2xl shadow-2xl w-[640px] max-h-[90vh] overflow-hidden flex flex-col ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className={`px-6 py-4 border-b flex items-center gap-3 flex-shrink-0 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
            <Database className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className={`text-lg font-semibold truncate ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                {editingKBName || '知识库设置'}
              </h3>
              {kbStatus && (
                <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                  kbStatus.color === 'blue' ? 'bg-blue-500/20 text-blue-400' :
                  kbStatus.color === 'yellow' ? 'bg-yellow-500/20 text-yellow-400' :
                  kbStatus.color === 'orange' ? 'bg-orange-500/20 text-orange-400' :
                  kbStatus.color === 'red' ? 'bg-red-500/20 text-red-400' :
                  kbStatus.color === 'green' ? 'bg-green-500/20 text-green-400' :
                  'bg-gray-500/20 text-gray-400'
                }`}>
                  {kbStatus.label}
                </span>
              )}
            </div>
            <p className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              {editingKB?.path || ''}
            </p>
          </div>
          <button
            onClick={handleClose}
            className={`p-1.5 rounded-lg transition-all flex-shrink-0 ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 可滚动内容 */}
        <div className="flex-1 overflow-y-auto">
          {/* 基本信息 */}
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                知识库名称
              </label>
              <input
                type="text"
                value={editingKBName}
                onChange={(e) => setEditingKBName(e.target.value)}
                placeholder="请输入知识库名称"
                className={inputClass}
              />
            </div>

            <div>
              <label className={`block text-sm font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                描述
              </label>
              <textarea
                value={editingKBDesc}
                onChange={(e) => setEditingKBDesc(e.target.value)}
                placeholder="请输入知识库描述（可选）"
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </div>
          </div>

          {/* 知识管理 */}
          <div className={`mx-6 py-4 border-t ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-100' : 'border-gray-600'}`}>
            <div className="flex items-center justify-between mb-3">
              <h4 className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                知识管理
              </h4>
              <div className="flex items-center gap-2">
                <button onClick={onOpenWikiWindow} className={`${btnPrimary} !bg-purple-600 hover:!bg-purple-500`}>
                  <ExternalLink className="w-3.5 h-3.5" />
                  管理界面
                </button>
                <button onClick={onOpenVector} className={`${btnPrimary} !bg-teal-600 hover:!bg-teal-500`}>
                  <BarChart3 className="w-3.5 h-3.5" />
                  可视化
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <button onClick={onImportFiles} className={btnPrimary}>
                <Upload className="w-3.5 h-3.5" />
                导入文件
              </button>
              <button onClick={onImportFolders} className={btnPrimary}>
                <Folder className="w-3.5 h-3.5" />
                导入文件夹
              </button>
              <button onClick={onImportUrl} className={btnPrimary}>
                <Link className="w-3.5 h-3.5" />
                导入网址
              </button>
              <button onClick={onOpenSearchImport} className={btnPrimary}>
                <Search className="w-3.5 h-3.5" />
                搜索导入
              </button>
            </div>

            {showUrlInput && (
              <div className={`mb-3 p-3 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50 border border-gray-600' : theme === 'light' ? 'bg-gray-50 border border-gray-200' : 'bg-gray-600/50 border border-gray-500'}`}>
                <label className={`block text-xs font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                  请输入网址（多个网址用换行分隔）
                </label>
                <textarea
                  value={urlInputValue}
                  onChange={(e) => setUrlInputValue(e.target.value)}
                  placeholder="https://example.com/article1&#10;https://example.com/article2"
                  rows={3}
                  className={`w-full px-3 py-2 rounded-lg text-sm resize-none outline-none transition-all border ${
                    theme === 'dark' ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500' :
                    theme === 'light' ? 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400' :
                    'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500'
                  }`}
                  autoFocus
                />
                <div className="flex items-center gap-2 mt-2">
                  <button onClick={onConfirmImportUrl} className={btnPrimary}>确认导入</button>
                  <button onClick={() => { setShowUrlInput(false); setUrlInputValue(''); }} className={btnOutline}>取消</button>
                </div>
              </div>
            )}

            <div className={`rounded-xl overflow-hidden ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-600/50'}`}>
              {kbKnowledgeLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : kbKnowledgeTree.length === 0 ? (
                <div className={`text-center py-10 text-sm ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                  <Folder className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  暂无知识，请导入文件或文件夹
                </div>
              ) : (
                <div>
                  {kbKnowledgeTree.map((node, i) => (
                    <KbFileTreeNode key={`${node.name}-${i}`} node={node} depth={0} theme={theme} onDeleteKnowledge={onDeleteKnowledge} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 危险区域 */}
          <div className={`mx-6 mb-5 p-4 rounded-xl border ${theme === 'dark' ? 'border-red-500/20 bg-red-500/5' : theme === 'light' ? 'border-red-200 bg-red-50' : 'border-red-500/20 bg-red-500/5'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className={`w-4 h-4 ${theme === 'dark' ? 'text-red-400' : theme === 'light' ? 'text-red-500' : 'text-red-400'}`} />
                <div>
                  <p className={`text-sm font-medium ${theme === 'dark' ? 'text-red-300' : theme === 'light' ? 'text-red-600' : 'text-red-300'}`}>危险操作</p>
                  <p className={`text-xs ${theme === 'dark' ? 'text-red-400/70' : theme === 'light' ? 'text-red-400' : 'text-red-400/70'}`}>删除后将不可恢复</p>
                </div>
              </div>
              <button
                onClick={onDelete}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  theme === 'dark' ? 'bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30' : theme === 'light' ? 'bg-red-50 hover:bg-red-100 text-red-600 border border-red-200' : 'bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30'
                }`}
              >
                <Trash2 className="w-4 h-4" />
                删除知识库
              </button>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={`px-6 py-4 border-t flex justify-end gap-3 flex-shrink-0 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/30' : theme === 'light' ? 'border-gray-100 bg-gray-50/30' : 'border-gray-600 bg-gray-700/30'}`}>
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

      {/* 未保存修改确认弹窗 */}
      {showConfirmClose && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]" onClick={() => setShowConfirmClose(false)}>
          <div
            className={`rounded-xl shadow-2xl w-[360px] p-5 ${theme === 'dark' ? 'bg-gray-800 border border-gray-600' : theme === 'light' ? 'bg-white border border-gray-200' : 'bg-gray-700 border border-gray-500'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${theme === 'dark' ? 'text-yellow-400' : 'text-yellow-500'}`} />
              <div>
                <p className={`text-sm font-medium ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                  放弃未保存的修改？
                </p>
                <p className={`text-xs mt-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                  名称或描述已修改，关闭将丢失这些更改。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmClose(false)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : theme === 'light' ? 'bg-gray-100 hover:bg-gray-200 text-gray-600' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                }`}
              >
                继续编辑
              </button>
              <button
                onClick={handleDiscardAndClose}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  theme === 'dark' ? 'bg-red-600 hover:bg-red-500 text-white' : theme === 'light' ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-red-600 hover:bg-red-500 text-white'
                }`}
              >
                放弃修改
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
