import React, { useState, useMemo, useCallback, useRef } from 'react';
import { Database, ChevronRight, ChevronDown, Folder, Users, Loader2, RefreshCw, CheckCircle, GripVertical } from 'lucide-react';

/**
 * 知识库树状目录面板（支持多层级、拖拽排序、自动勾选子知识库）
 * 
 * kbHierarchy 格式: { parentKbKey: [childKbKey1, childKbKey2, ...] }
 * 拖拽仅维护层级映射，不改变文件系统路径
 */
export default function KnowledgeBaseTreePanel({
  theme = 'dark',
  publicKbList = [],
  personalKbList = [],
  kbMetadata = {},
  kbStats = {},
  kbListLoading = false,
  selectedKBIds = [],
  activeKBKey = '',
  kbHierarchy = {},
  onUpdateHierarchy,
  getKbKey,
  getKBStatus,
  onSelectKB,
  onSelectKBGroup,
  onOpenSettings,
  onRescanKB,
}) {
  const [publicExpanded, setPublicExpanded] = useState(true);
  const [personalExpanded, setPersonalExpanded] = useState(true);
  const [collapsedNodes, setCollapsedNodes] = useState(new Set());

  // 拖拽状态
  const dragRef = useRef(null); // { kbKey, isCommonKb }
  const dropTargetRef = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [dropPosition, setDropPosition] = useState(null); // 'inside' | 'after'

  // 收集所有作为子节点的 kbKey（递归收集所有层级的子节点）
  const allChildKeys = useMemo(() => {
    const result = new Set();
    const collect = (keys) => {
      for (const k of keys) {
        result.add(k);
        const subKeys = kbHierarchy[k] || [];
        if (subKeys.length > 0) collect(subKeys);
      }
    };
    for (const childList of Object.values(kbHierarchy)) {
      collect(childList);
    }
    return result;
  }, [kbHierarchy]);

  // 根据层级映射构建树结构（仅返回根节点列表）
  const buildTree = useCallback((kbList, isCommonKb) => {
    return kbList
      .map(kb => ({
        kb,
        kbKey: getKbKey ? getKbKey(kb) : (kb.id || kb.knowledge_base_id),
        isCommonKb,
      }))
      .filter(item => !allChildKeys.has(item.kbKey));
  }, [getKbKey, allChildKeys]);

  // 获取某节点的子节点列表（已排序）
  const getChildren = useCallback((kbKey) => {
    const childKeys = kbHierarchy[kbKey] || [];
    return childKeys.map(ck => {
      // 在 publicKbList 和 personalKbList 中查找
      const found = publicKbList.find(k => (getKbKey ? getKbKey(k) : (k.id || k.knowledge_base_id)) === ck)
                 || personalKbList.find(k => (getKbKey ? getKbKey(k) : (k.id || k.knowledge_base_id)) === ck);
      return found ? {
        kb: found,
        kbKey: ck,
        isCommonKb: publicKbList.some(k => (getKbKey ? getKbKey(k) : (k.id || k.knowledge_base_id)) === ck),
      } : null;
    }).filter(Boolean);
  }, [kbHierarchy, publicKbList, personalKbList, getKbKey]);

  const toggleCollapse = (kbKey) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(kbKey)) next.delete(kbKey);
      else next.add(kbKey);
      return next;
    });
  };

  // ===== 拖拽逻辑 =====
  const handleDragStart = (e, kbKey, isCommonKb) => {
    dragRef.current = { kbKey, isCommonKb };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', kbKey);
    // 设置拖拽预览的透明度
    if (e.currentTarget) {
      setTimeout(() => { e.currentTarget.style.opacity = '0.4'; }, 0);
    }
  };

  const handleDragEnd = (e) => {
    if (e.currentTarget) e.currentTarget.style.opacity = '';
    dragRef.current = null;
    setDragOverKey(null);
    setDropPosition(null);
    dropTargetRef.current = null;
  };

  const handleDragOver = (e, kbKey) => {
    e.preventDefault();
    if (!dragRef.current || dragRef.current.kbKey === kbKey) return;
    // 防止将节点拖到自己的后代中（循环引用）
    if (isDescendant(kbKey, dragRef.current.kbKey)) return;

    setDragOverKey(kbKey);

    // 根据鼠标位置判断是放入内部还是后面
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;
    setDropPosition(y < height * 0.3 ? 'before' : y > height * 0.7 ? 'before' : 'inside');
  };

  const handleDragOverRoot = (e) => {
    e.preventDefault();
    if (!dragRef.current) return;
    setDragOverKey('__root__');
    setDropPosition('inside');
  };

  const handleDragLeave = (e) => {
    // 仅当真正离开目标时清除
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOverKey(null);
    setDropPosition(null);
  };

  const handleDragLeaveRoot = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOverKey(null);
    setDropPosition(null);
  };

  const isDescendant = (parentKey, childKey) => {
    const children = kbHierarchy[parentKey] || [];
    if (children.includes(childKey)) return true;
    for (const c of children) {
      if (isDescendant(c, childKey)) return true;
    }
    return false;
  };

  const handleDrop = (e, targetKey) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragRef.current) return;
    const { kbKey: sourceKey } = dragRef.current;
    if (sourceKey === targetKey) return;

    // 深拷贝层级映射，避免修改原始引用
    const newHierarchy = {};
    for (const [key, arr] of Object.entries(kbHierarchy)) {
      newHierarchy[key] = [...arr];
    }

    // 从旧父节点移除 sourceKey
    for (const [parent, children] of Object.entries(newHierarchy)) {
      const idx = children.indexOf(sourceKey);
      if (idx >= 0) {
        children.splice(idx, 1);
        if (children.length === 0) delete newHierarchy[parent];
        break;
      }
    }

    // 添加到新父节点（__root__ 表示拖到根级，无需添加父节点）
    if (targetKey !== '__root__') {
      const targetChildren = newHierarchy[targetKey] || [];
      if (!targetChildren.includes(sourceKey)) {
        newHierarchy[targetKey] = [...targetChildren, sourceKey];
      }
    }

    onUpdateHierarchy && onUpdateHierarchy(newHierarchy);
    dragRef.current = null;
    setDragOverKey(null);
    setDropPosition(null);
  };

  const handleDropRoot = (e) => {
    handleDrop(e, '__root__');
  };

  // ===== 节点渲染 =====
  const renderKBNode = (kb, isCommonKb, depth = 0) => {
    const kbId = kb.id || kb.knowledge_base_id;
    const kbKey = getKbKey ? getKbKey(kb) : kbId;
    const meta = kbMetadata[kbId] || {};
    const kbName = meta.name || kb.name || kbId;
    const isSelected = selectedKBIds.includes(kbKey);
    const isActive = activeKBKey && kbKey === activeKBKey;
    const kbStatus = getKBStatus ? getKBStatus(kbId) : null;
    const stats = kbStats[kbId] || { documents: 0, web: 0 };
    const children = getChildren(kbKey);
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedNodes.has(kbKey);
    const isDragOver = dragOverKey === kbKey;
    const isDropInside = isDragOver && dropPosition === 'inside';

    const handleClick = (e) => {
      e.stopPropagation();
      // 有子节点时，批量选择/取消父节点及其所有后代
      if (hasChildren && onSelectKBGroup) {
        onSelectKBGroup(kb, isSelected);
      } else if (onSelectKB) {
        onSelectKB(kb);
      }
    };

    return (
      <div key={kbKey}>
        {/* 当前节点 */}
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, kbKey, isCommonKb)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, kbKey)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, kbKey)}
          onClick={handleClick}
          className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer text-sm transition-all ${
            isDropInside
              ? (theme === 'dark' ? 'ring-2 ring-indigo-400 bg-indigo-500/10' : theme === 'light' ? 'ring-2 ring-indigo-400 bg-indigo-50' : 'ring-2 ring-indigo-400 bg-indigo-500/10')
              : isDragOver
                ? (theme === 'dark' ? 'ring-1 ring-gray-400' : theme === 'light' ? 'ring-1 ring-gray-400' : 'ring-1 ring-gray-400')
                : isSelected
                  ? (theme === 'dark' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : theme === 'light' ? 'bg-indigo-50 text-indigo-700 border border-indigo-300' : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30')
                  : (theme === 'dark' ? 'text-gray-300 hover:bg-gray-600/40 hover:text-white border border-transparent' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 border border-transparent' : 'text-gray-300 hover:bg-gray-600/40 hover:text-white border border-transparent')
          }`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {/* 展开/折叠按钮（仅对有子节点的显示） */}
          {hasChildren ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggleCollapse(kbKey); }}
              className="p-0 flex-shrink-0 text-gray-400 hover:text-gray-200"
            >
              {isCollapsed ? (
                <ChevronRight className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          ) : (
            <span className="w-3 flex-shrink-0" />
          )}

          {/* 拖拽手柄 */}
          <GripVertical className="w-3 h-3 flex-shrink-0 text-gray-500 opacity-0 group-hover:opacity-100 cursor-grab" />

          {/* 状态圆点 */}
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
            kbStatus?.color === 'gray' ? 'bg-gray-400' :
            kbStatus?.color === 'yellow' ? 'bg-yellow-400 animate-pulse' :
            kbStatus?.color === 'blue' ? 'bg-blue-400 animate-pulse' :
            kbStatus?.color === 'orange' ? 'bg-orange-400 animate-pulse' :
            kbStatus?.color === 'red' ? 'bg-red-500' :
            'bg-green-500'
          }`} title={kbStatus?.label || ''} />

          {/* 图标 */}
          <Database className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />

          {/* 名称 */}
          <span className="truncate flex-1">{kbName}</span>

          {/* 子节点数量（有子节点时显示） */}
          {hasChildren && (
            <span className={`text-[10px] flex-shrink-0 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              ({children.length})
            </span>
          )}

          {/* 活跃标识 */}
          {isActive && (
            <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 text-green-400" title="当前活跃知识库" />
          )}

          {/* 文件统计 */}
          <span className={`text-xs flex-shrink-0 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
            {stats.documents || 0}
          </span>

          {/* 设置按钮 */}
          {onOpenSettings && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenSettings(kb); }}
              className={`p-0.5 rounded opacity-0 group-hover:opacity-100 transition-all flex-shrink-0 ${
                theme === 'dark' ? 'hover:bg-gray-600 text-gray-500 hover:text-gray-200' :
                theme === 'light' ? 'hover:bg-gray-200 text-gray-400 hover:text-gray-600' :
                'hover:bg-gray-600 text-gray-500 hover:text-gray-200'
              }`}
              title="设置"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          )}
          {/* 重新扫描按钮 */}
          {onRescanKB && (
            <button
              onClick={(e) => { e.stopPropagation(); onRescanKB(kb); }}
              className={`p-0.5 rounded opacity-0 group-hover:opacity-100 transition-all flex-shrink-0 ${
                theme === 'dark' ? 'hover:bg-blue-600 text-gray-500 hover:text-white' :
                theme === 'light' ? 'hover:bg-blue-100 text-gray-400 hover:text-blue-600' :
                'hover:bg-blue-500 text-gray-500 hover:text-white'
              }`}
              title="重新扫描"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 子节点（递归渲染） */}
        {hasChildren && !isCollapsed && (
          <div>
            {children.map(child => renderKBNode(child.kb, child.isCommonKb, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderSection = (title, icon, iconColor, kbList, isCommonKb, expanded, setExpanded) => {
    const tree = buildTree(kbList, isCommonKb);

    return (
      <div>
        <div
          onClick={() => setExpanded(!expanded)}
          className={sectionHeaderClass}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
          )}
          {React.cloneElement(icon, { className: `w-3.5 h-3.5 flex-shrink-0 ${iconColor}` })}
          <span>{title}</span>
          <span className={`flex-shrink-0 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
            ({kbList.length})
          </span>
        </div>
        {expanded && (
          <div
            className="ml-2 mt-0.5 space-y-0.5"
            onDragOver={handleDragOverRoot}
            onDragLeave={handleDragLeaveRoot}
            onDrop={handleDropRoot}
          >
            {tree.length === 0 ? (
              <div className={`text-xs px-2 py-2 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                暂无{title}知识库
              </div>
            ) : (
              tree.map(item => renderKBNode(item.kb, item.isCommonKb))
            )}
            {/* 根级拖放区域：拖到此处即移回根级 */}
            <div
              className={`text-[10px] px-2 py-1 rounded border border-dashed transition-all ${
                dragOverKey === '__root__'
                  ? (theme === 'dark' ? 'border-indigo-400 bg-indigo-500/10 text-indigo-300' : theme === 'light' ? 'border-indigo-400 bg-indigo-50 text-indigo-600' : 'border-indigo-400 bg-indigo-500/10 text-indigo-300')
                  : (theme === 'dark' ? 'border-gray-600 text-gray-500' : theme === 'light' ? 'border-gray-300 text-gray-400' : 'border-gray-500 text-gray-500')
              }`}
              onDragOver={handleDragOverRoot}
              onDrop={handleDropRoot}
            >
              拖到此处移回根级
            </div>
          </div>
        )}
      </div>
    );
  };

  const sectionHeaderClass = `flex items-center gap-1.5 px-2 py-1.5 cursor-pointer rounded-md transition-colors text-xs font-medium ${
    theme === 'dark' ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-600/30' :
    theme === 'light' ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100' :
    'text-gray-400 hover:text-gray-200 hover:bg-gray-600/30'
  }`;

  if (kbListLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <Loader2 className={`w-5 h-5 animate-spin ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-500' : 'text-indigo-400'}`} />
        <span className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
          正在连接知识库服务...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* 公共知识库 */}
      {renderSection(
        '公共',
        <Users />,
        'text-cyan-400',
        publicKbList,
        true,
        publicExpanded,
        setPublicExpanded
      )}

      {/* 个人知识库 */}
      {renderSection(
        '个人',
        <Folder />,
        'text-yellow-400',
        personalKbList,
        false,
        personalExpanded,
        setPersonalExpanded
      )}
    </div>
  );
}
