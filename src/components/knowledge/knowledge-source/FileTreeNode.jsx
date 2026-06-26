import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Folder, FileText } from 'lucide-react';

// 递归树节点组件
export default function FileTreeNode({ node, depth, theme, defaultExpanded }) {
  const [expanded, setExpanded] = useState(depth < (defaultExpanded ?? 1));

  const paddingLeft = 12 + depth * 20;

  if (node.is_dir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className={`flex w-full items-center gap-2 py-1.5 text-sm transition-colors ${
            theme === 'dark'
              ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
              : theme === 'light'
              ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              : 'text-gray-300 hover:bg-gray-600 hover:text-white'
          }`}
          style={{ paddingLeft }}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-yellow-400' : theme === 'light' ? 'text-yellow-500' : 'text-yellow-400'}`} />
          ) : (
            <Folder className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-yellow-400' : theme === 'light' ? 'text-yellow-500' : 'text-yellow-400'}`} />
          )}
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map((child, i) => (
              <FileTreeNode key={`${child.name}-${i}`} node={child} depth={depth + 1} theme={theme} defaultExpanded={defaultExpanded} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 py-1.5 text-sm ${
        theme === 'dark'
          ? 'text-gray-400 hover:bg-gray-700/50'
          : theme === 'light'
          ? 'text-gray-500 hover:bg-gray-50'
          : 'text-gray-400 hover:bg-gray-600/50'
      }`}
      style={{ paddingLeft: paddingLeft + 20 }}
    >
      <FileText className="w-4 h-4 flex-shrink-0 text-blue-400" />
      <span className="truncate">{node.name}</span>
    </div>
  );
}
