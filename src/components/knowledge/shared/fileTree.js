// 将扁平的 KMA 文件列表构建为树结构
// KMA API 可能返回两种格式：
//   1. 扁平数组，每个文件有 relative_path 字段
//   2. 已经包含 children 的树结构
export function buildFileTree(flatList) {
  if (!Array.isArray(flatList) || flatList.length === 0) return [];

  // 如果第一个元素有 children 属性，说明已经是树结构，直接返回
  if (flatList[0] && 'children' in flatList[0]) return flatList;

  const root = new Map();

  for (const item of flatList) {
    // 解析路径
    let relPath = '';
    if (typeof item === 'string') {
      relPath = item.replace(/\\/g, '/');
    } else if (item.relative_path) {
      relPath = item.relative_path.replace(/\\/g, '/');
    } else if (item.path) {
      relPath = item.path.replace(/\\/g, '/');
    } else if (item.name) {
      relPath = item.name.replace(/\\/g, '/');
    } else {
      continue;
    }

    const parts = relPath.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let currentMap = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!currentMap.has(part)) {
        currentMap.set(part, {
          name: part,
          is_dir: !isLast,
          children: !isLast ? new Map() : null,
          _item: isLast ? item : null,
        });
      }

      const node = currentMap.get(part);

      if (isLast) {
        // 如果是文件，更新为确切的 is_dir 状态
        if (item.is_dir !== undefined) {
          node.is_dir = item.is_dir;
        }
        node._item = item;
      } else {
        // 确保中间节点是目录
        node.is_dir = true;
        if (!node.children) {
          node.children = new Map();
        }
        currentMap = node.children;
      }
    }
  }

  // 将 Map 递归转为数组，同时计算每个节点的相对路径
  function mapToArray(map, parentPath = '') {
    const result = [];
    for (const [, node] of map) {
      const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;
      const obj = {
        name: node.name,
        relative_path: nodePath,
        is_dir: node.is_dir,
        _item: node._item,
      };
      if (node.children && node.children.size > 0) {
        obj.children = mapToArray(node.children, nodePath);
      }
      result.push(obj);
    }
    // 目录在前，文件在后
    result.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  }

  return mapToArray(root);
}
