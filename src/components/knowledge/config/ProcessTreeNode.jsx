import React, { useState } from 'react';

// 进程树节点递归组件
export default function ProcessTreeNode({ node, depth = 0, theme, onKill, killPid }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children && node.children.length > 0;
  const hasPorts = node.listeningPorts && node.listeningPorts.length > 0;
  const iconMap = {
    'python.exe': '🐍',
    'python': '🐍',
    'node.exe': '⬢',
    'cmd.exe': '⬛',
    'powershell.exe': '💲',
    'llm-wiki.exe': '📚',
    'HiDesk_Knowledge_API.exe': '📦',
    'chrys.exe': '🔧',
  };
  const icon = iconMap[node.name?.toLowerCase()] || (hasChildren ? '📁' : '⚙️');

  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div
        className={`flex items-center gap-1.5 py-1 px-1 rounded cursor-pointer text-xs group ${
          node.isSpawnedRoot
            ? (theme === 'dark' ? 'bg-blue-900/40' : theme === 'light' ? 'bg-blue-100' : 'bg-blue-900/30')
            : ''
        } hover:${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-100' : 'bg-gray-600'}`}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        <span className="flex-shrink-0 w-3 text-center">
          {hasChildren ? (expanded ? '▾' : '▸') : ' '}
        </span>
        <span className="flex-shrink-0">{icon}</span>
        <span className={`font-mono ${node.isSpawnedRoot ? 'text-blue-400 font-semibold' : (theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300')}`}>
          {node.name}
        </span>
        {node.isSpawnedRoot && (
          <span className="text-[10px] px-1 rounded bg-blue-500/20 text-blue-400">本工具启动</span>
        )}
        {hasPorts && (
          <span className={`text-[10px] ${theme === 'dark' ? 'text-green-400' : theme === 'light' ? 'text-green-600' : 'text-green-400'}`}>
            :{node.listeningPorts.join(', :')}
          </span>
        )}
        <span className={`font-mono ml-auto ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
          PID {node.pid}
        </span>
        {onKill && (
          <button
            onClick={(e) => { e.stopPropagation(); onKill(node.pid); }}
            title={killPid === node.pid ? '再次点击确认杀死此进程及其子进程' : '杀死此进程及其子进程'}
            className={`flex-shrink-0 w-4 h-4 rounded text-[10px] leading-none flex items-center justify-center transition-all ${
              killPid === node.pid
                ? 'bg-red-600 text-white'
                : 'opacity-0 group-hover:opacity-100 text-red-400 hover:bg-red-500/20 hover:text-red-500'
            }`}
          >
            ×
          </button>
        )}
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children.map((child, i) => (
            <ProcessTreeNode key={`${child.pid}-${i}`} node={child} depth={depth + 1} theme={theme} onKill={onKill} killPid={killPid} />
          ))}
        </div>
      )}
    </div>
  );
}
