import React, { useState } from 'react';
import { Folder, Loader2, FolderOpen, FileText } from 'lucide-react';
import KnowledgeFileTreeNode from './KnowledgeFileTreeNode';
import { buildFileTree } from './fileTree';

/**
 * 知识库树状目录面板组件
 * 在左侧显示树状目录结构，点击节点时触发 onSelectNode 回调
 */
export default function KnowledgeTreePanel({
  theme = 'dark',
  kbKnowledgeList = [],
  kbKnowledgeLoading = false,
  selectedKbName = '',
  onSelectNode,
  onDeleteKnowledge,
  selectedPath,
}) {
  const kbKnowledgeTree = React.useMemo(
    () => buildFileTree(kbKnowledgeList),
    [kbKnowledgeList]
  );

  if (kbKnowledgeLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className={`w-5 h-5 animate-spin ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-500' : 'text-indigo-400'}`} />
        <span className={`ml-2 text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
          加载中...
        </span>
      </div>
    );
  }

  if (kbKnowledgeTree.length === 0) {
    return (
      <div className={`text-center py-6 text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
        <Folder className="w-6 h-6 mx-auto mb-2 opacity-40" />
        {selectedKbName ? (
          <span>"{selectedKbName}" 暂无知识文件</span>
        ) : (
          <span>请选择知识库</span>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-lg overflow-hidden ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-gray-100 border border-gray-200' : 'bg-gray-600/50'}`}>
      {/* 头部 */}
      {selectedKbName && (
        <div className={`px-3 py-2 flex items-center gap-2 border-b ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
          <FolderOpen className={`w-3.5 h-3.5 flex-shrink-0 ${theme === 'dark' ? 'text-yellow-400' : theme === 'light' ? 'text-yellow-500' : 'text-yellow-400'}`} />
          <span className={`text-xs font-medium truncate ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>
            {selectedKbName}
          </span>
          <span className={`text-xs flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
            ({kbKnowledgeList.length})
          </span>
        </div>
      )}
      <div className="max-h-[400px] overflow-y-auto">
        {kbKnowledgeTree.map((node, i) => (
          <KnowledgeFileTreeNode
            key={`${node.name}-${i}`}
            node={node}
            depth={0}
            theme={theme}
            onDelete={onDeleteKnowledge}
            onClick={onSelectNode}
            selectedPath={selectedPath}
            showDelete={false}
          />
        ))}
      </div>
    </div>
  );
}
