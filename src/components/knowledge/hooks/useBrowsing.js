/**
 * 文件浏览操作 —— 选择文件/目录、导航、确认
 */
export default function useBrowsing({
  showPathTypeModal, setShowPathTypeModal,
  browseTarget, browseMode,
  setFileSystemItems, currentPath, setCurrentPath,
  parentPath, setParentPath,
  showBrowseModal, setShowBrowseModal,
  setImportPath, setNewKBPath, setKnowledgePath,
}) {
  const handleSelectFile = async () => {
    setShowPathTypeModal(false);
    const { ipcRenderer } = window.require('electron');
    const selectedPath = await ipcRenderer.invoke('open-file-dialog', { properties: ['openFile'] });
    if (selectedPath) {
      if (browseTarget === 'importPath') {
        setImportPath(selectedPath);
      } else {
        setKnowledgePath(selectedPath);
      }
    }
  };

  const handleSelectDirectory = async () => {
    setShowPathTypeModal(false);
    const { ipcRenderer } = window.require('electron');
    const selectedPath = await ipcRenderer.invoke('open-file-dialog', { properties: ['openDirectory'] });
    if (selectedPath) {
      if (browseTarget === 'importPath') {
        setImportPath(selectedPath);
      } else {
        setKnowledgePath(selectedPath);
      }
    }
  };

  const handleBrowseClick = () => {
    setShowPathTypeModal(true);
  };

  const handleNavigateTo = async (item) => {
    if (item.type === 'directory' || item.type === 'drive') {
      try {
        const response = await fetch(`http://127.0.0.1:5000/api/filesystem/list?path=${encodeURIComponent(item.path)}`);
        const data = await response.json();
        if (data.success) {
          setFileSystemItems(data.data.items);
          setCurrentPath(data.data.current_path);
          setParentPath(data.data.parent_path);
        }
      } catch (error) {
        console.error('Failed to list directory:', error);
      }
    } else if (item.type === 'file' && browseMode === 'file') {
      if (browseTarget === 'importPath') {
        setImportPath(String(item.path || ''));
      } else if (browseTarget === 'newKBPath') {
        setNewKBPath(String(item.path || ''));
      } else {
        setKnowledgePath(item.path);
      }
      setShowBrowseModal(false);
    }
  };

  const handleNavigateUp = async () => {
    if (parentPath) {
      try {
        const response = await fetch(`http://127.0.0.1:5000/api/filesystem/list?path=${encodeURIComponent(parentPath)}`);
        const data = await response.json();
        if (data.success) {
          setFileSystemItems(data.data.items);
          setCurrentPath(data.data.current_path);
          setParentPath(data.data.parent_path);
        }
      } catch (error) {
        console.error('Failed to navigate up:', error);
      }
    } else {
      try {
        const response = await fetch('http://127.0.0.1:5000/api/filesystem/root');
        const data = await response.json();
        if (data.success) {
          setFileSystemItems(data.data);
          setCurrentPath('');
          setParentPath(null);
        }
      } catch (error) {
        console.error('Failed to fetch root path:', error);
      }
    }
  };

  const handleConfirmSelection = () => {
    if (browseMode === 'directory' && currentPath) {
      if (browseTarget === 'importPath') {
        setImportPath(String(currentPath || ''));
      } else if (browseTarget === 'newKBPath') {
        setNewKBPath(String(currentPath || ''));
      } else {
        setKnowledgePath(currentPath);
      }
      setShowBrowseModal(false);
    }
  };

  return { handleSelectFile, handleSelectDirectory, handleBrowseClick, handleNavigateTo, handleNavigateUp, handleConfirmSelection };
}
