/**
 * 远程目录树操作 —— 全选/反选/展开折叠/勾选状态
 * 纯函数，仅 toggleTreeNode 依赖 setRemoteTreeChecked
 */
export default function useRemoteTree({
  remoteTreeChecked, setRemoteTreeChecked,
}) {
  const collectAllPaths = (node) => {
    const paths = [node.path];
    if (node.children) {
      for (const child of node.children) {
        paths.push(...collectAllPaths(child));
      }
    }
    return paths;
  };

  const collectChildPaths = (node) => {
    const paths = [];
    if (node.children) {
      for (const child of node.children) {
        paths.push(child.path);
        if (child.is_dir) {
          paths.push(...collectChildPaths(child));
        }
      }
    }
    return paths;
  };

  const toggleTreeNode = (node) => {
    setRemoteTreeChecked(prev => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        next.delete(node.path);
        const childPaths = collectChildPaths(node);
        childPaths.forEach(p => next.delete(p));
      } else {
        next.add(node.path);
        const childPaths = collectChildPaths(node);
        childPaths.forEach(p => next.add(p));
      }
      return next;
    });
  };

  const getNodeCheckState = (node) => {
    if (!node.is_dir) return null;
    const childPaths = collectChildPaths(node);
    if (childPaths.length === 0) {
      return remoteTreeChecked.has(node.path) ? 'checked' : 'unchecked';
    }
    const checkedCount = childPaths.filter(p => remoteTreeChecked.has(p)).length;
    if (checkedCount === childPaths.length) return 'checked';
    if (checkedCount > 0) return 'indeterminate';
    return 'unchecked';
  };

  return { collectAllPaths, collectChildPaths, toggleTreeNode, getNodeCheckState };
}
