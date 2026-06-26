import React, { useState } from 'react';
import { FileText, Folder, FolderOpen, ChevronRight, ChevronDown, Trash2 } from 'lucide-react';

/**
 * 知识库文件树节点组件 - 可复用
 * @param {Object} node - 树节点数据
 * @param {number} depth - 当前深度
 * @param {string} theme - 主题
 * @param {Function} onDelete - 删除回调 (relativePath, isDir) => void
 * @param {Function} onClick - 点击节点回调 (node) => void
 * @param {string} selectedPath - 当前选中的路径（用于高亮）
 * @param {boolean} showDelete - 是否显示删除按钮
 */
export default function KnowledgeFileTreeNode({
  node,
  depth = 0,
  theme = 'dark',
  onDelete,
  onClick,
  selectedPath,
  showDelete = true,
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const paddingLeft = 12 + depth * 20;
  const relPath = node.relative_path || node._item?.relative_path || node.name;
  const isSelected = selectedPath === relPath;

  if (node.is_dir) {
    return (
      <div>
        <div className={`flex items-center justify-between transition-colors ${
          theme === 'dark'
            ? `hover:bg-gray-600/30 ${isSelected ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-300'}`
            : theme === 'light'
              ? `hover:bg-gray-100 ${isSelected ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600'}`
              : `hover:bg-gray-600/30 ${isSelected ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-300'}`
        }`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
              if (onClick) onClick(node);
            }}
            className="flex flex-1 items-center gap-2 py-1.5 text-xs min-w-0"
            style={{ paddingLeft }}
          >
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
            }
            {expanded ? (
              <FolderOpen className={`w-3.5 h-3.5 flex-shrink-0 ${theme === 'dark' ? 'text-yellow-400' : theme === 'light' ? 'text-yellow-500' : 'text-yellow-400'}`} />
            ) : (
              <Folder className={`w-3.5 h-3.5 flex-shrink-0 ${theme === 'dark' ? 'text-yellow-400' : theme === 'light' ? 'text-yellow-500' : 'text-yellow-400'}`} />
            )}
            <span className="truncate font-medium">{node.name}</span>
            {node.children && (
              <span className={`text-[10px] opacity-50 flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                ({node.children.length})
              </span>
            )}
          </button>
          {showDelete && onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(relPath, true);
              }}
              className={`p-1 rounded transition-all flex-shrink-0 mr-1 ${theme === 'dark' ? 'hover:bg-red-500/20 text-gray-500 hover:text-red-400' : theme === 'light' ? 'hover:bg-red-50 text-gray-400 hover:text-red-500' : 'hover:bg-red-500/20 text-gray-500 hover:text-red-400'}`}
              title="删除此目录及其所有子文件"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        {expanded && node.children && (
          <div>
            {node.children.map((child, i) => (
              <KnowledgeFileTreeNode
                key={`${child.name}-${i}`}
                node={child}
                depth={depth + 1}
                theme={theme}
                onDelete={onDelete}
                onClick={onClick}
                selectedPath={selectedPath}
                showDelete={showDelete}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // 文件节点
  return (
    <div
      className={`flex items-center justify-between py-1.5 text-xs cursor-pointer transition-colors ${
        theme === 'dark'
          ? `hover:bg-gray-700/30 ${isSelected ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-400'}`
          : theme === 'light'
            ? `hover:bg-gray-50 ${isSelected ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500'}`
            : `hover:bg-gray-600/30 ${isSelected ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-400'}`
      }`}
      style={{ paddingLeft: paddingLeft + 20 }}
      onClick={() => { if (onClick) onClick(node); }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <FileText className={`w-3.5 h-3.5 flex-shrink-0 ${theme === 'dark' ? 'text-blue-400' : theme === 'light' ? 'text-blue-500' : 'text-blue-400'}`} />
        <span className="truncate">{node.name}</span>
      </div>
      {showDelete && onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(relPath, false);
          }}
          className={`p-1 rounded transition-all flex-shrink-0 ml-2 ${theme === 'dark' ? 'hover:bg-red-500/20 text-gray-500 hover:text-red-400' : theme === 'light' ? 'hover:bg-red-50 text-gray-400 hover:text-red-500' : 'hover:bg-red-500/20 text-gray-500 hover:text-red-400'}`}
          title="删除此知识"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
