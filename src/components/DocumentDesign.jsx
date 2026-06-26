import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Plus, X, Send, ChevronDown, FolderOpen, FileText, Check, AlertCircle, History, ChevronLeft, ChevronRight } from 'lucide-react';

function DocumentDesign({ theme, tabs, setTabs, activeTab, setActiveTab, tabStates, setTabStates }) {
  const [showDocumentModal, setShowDocumentModal] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const chatEndRef = useRef(null);
  
  const selectedProject = tabStates[activeTab]?.selectedProject || '';
  const selectedModule = tabStates[activeTab]?.selectedModule || '';
  const selectedDocuments = tabStates[activeTab]?.selectedDocuments || [];
  const workPath = tabStates[activeTab]?.workPath || '';
  const requirement = tabStates[activeTab]?.requirement || '';
  const generatedHistory = tabStates[activeTab]?.generatedHistory || [];
  const messages = useMemo(() => tabStates[activeTab]?.messages || [], [tabStates, activeTab]);
  
  const setSelectedProject = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedProject: value }
    }));
  };
  
  const setSelectedModule = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedModule: value }
    }));
  };
  
  const setSelectedDocuments = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedDocuments: value }
    }));
  };
  
  const setWorkPath = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], workPath: value }
    }));
  };
  
  const setRequirement = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], requirement: value }
    }));
  };
  
  const setGeneratedHistory = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], generatedHistory: value }
    }));
  };
  
  const setMessages = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], messages: value }
    }));
  };
  
  // 分隔条状态
  const [splitRatio, setSplitRatio] = useState(55);
  const [isDragging, setIsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const [projects, setProjects] = useState([]);
  const [modules, setModules] = useState([]);
  const [availableDocuments, setAvailableDocuments] = useState([]);

  useEffect(() => {
    fetchMockData();
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      const container = document.querySelector('.document-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(Math.max(newRatio, 20), 80));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    const container = document.querySelector('.document-container');
    if (container) {
      container.addEventListener('mousemove', handleMouseMove);
      container.addEventListener('mouseup', handleMouseUp);
      container.addEventListener('mouseleave', handleMouseUp);
    }

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleMouseMove);
        container.removeEventListener('mouseup', handleMouseUp);
        container.removeEventListener('mouseleave', handleMouseUp);
      }
    };
  }, [isDragging]);

  const fetchMockData = () => {
    const mockProjects = [
      { id: 'project1', name: '智能客服系统' },
      { id: 'project2', name: '数据分析平台' },
      { id: 'project3', name: '供应链管理系统' },
    ];
    const mockModules = [
      { id: 'module1', name: '用户管理模块' },
      { id: 'module2', name: '报表统计模块' },
      { id: 'module3', name: '权限控制模块' },
    ];
    const mockDocuments = [
      { id: 'doc1', name: '需求分析文档.pdf', category: '需求文档' },
      { id: 'doc2', name: '技术方案设计.docx', category: '技术文档' },
      { id: 'doc3', name: '接口规格说明.md', category: '接口文档' },
      { id: 'doc4', name: '数据库设计图.png', category: '设计文档' },
      { id: 'doc5', name: '测试用例文档.xlsx', category: '测试文档' },
      { id: 'doc6', name: '用户手册.pdf', category: '用户文档' },
    ];
    setProjects(mockProjects);
    setModules(mockModules);
    setAvailableDocuments(mockDocuments);
  };

  const addTab = () => {
    const newId = tabs.length + 1;
    setTabs([...tabs, { id: newId, name: `一键设计 ${newId}` }]);
    setActiveTab(newId);
    setTabStates(prev => ({
      ...prev,
      [newId]: {
        selectedProject: '',
        selectedModule: '',
        selectedDocuments: [],
        workPath: '',
        requirement: '',
        generatedHistory: [],
        messages: []
      }
    }));
  };

  const closeTab = (id) => {
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTab === id) setActiveTab(newTabs[0]?.id || 1);
  };

  const handleProjectChange = (projectId) => {
    setSelectedProject(projectId);
    setSelectedModule('');
  };

  const handleModuleChange = (moduleId) => {
    setSelectedModule(moduleId);
  };

  const handleDocumentToggle = (docId) => {
    const currentDocs = selectedDocuments;
    const newDocs = currentDocs.includes(docId)
      ? currentDocs.filter(id => id !== docId)
      : [...currentDocs, docId];
    setSelectedDocuments(newDocs);
  };

  const confirmDocuments = () => {
    setShowDocumentModal(false);
  };

  const handleBrowseWorkPath = () => {
    setWorkPath('D:\\workspace\\project1');
  };

  const handleDesign = () => {
    const newEntry = {
      id: Date.now(),
      time: new Date().toLocaleString(),
      project: projects.find(p => p.id === selectedProject)?.name || selectedProject,
      module: modules.find(m => m.id === selectedModule)?.name || selectedModule,
      status: '生成中...'
    };
    setGeneratedHistory([newEntry, ...generatedHistory]);
    
    setTimeout(() => {
      setGeneratedHistory(prev => prev.map(entry => 
        entry.id === newEntry.id ? { ...entry, status: '已完成' } : entry
      ));
    }, 2000);
  };

  const sendMessage = () => {
    if (!inputValue.trim()) return;
    const newMessages = [...messages, { type: 'user', content: inputValue }];
    setMessages(newMessages);
    setInputValue('');
    setTimeout(() => {
      const updatedMessages = [...newMessages, { type: 'assistant', content: '这是一键设计助手的响应内容，基于您的输入生成设计建议...' }];
      setMessages(updatedMessages);
    }, 1000);
  };

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  return (
    <div className="h-full flex flex-col">
      <div className={`flex items-center gap-1 px-2 py-2 ${theme === 'dark' ? 'bg-gray-800 border-b border-gray-700' : theme === 'light' ? 'bg-white border-b border-gray-200' : 'bg-gray-600 border-b border-gray-500'}`}>
        {tabs.map(tab => (
          <div key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-4 py-2 rounded-t-lg cursor-pointer transition-all ${
            activeTab === tab.id
              ? `${theme === 'dark' ? 'bg-gray-700 text-white' : theme === 'light' ? 'bg-gray-100 text-gray-900' : 'bg-gray-500 text-white'}`
              : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-300 hover:text-white'}`
          }`}>
            <span className="text-sm">{tab.name}</span>
            <button onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} className="hover:text-red-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button onClick={addTab} className={`ml-auto p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-500 hover:text-white'}`}>
          <Plus className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden document-container">
        {!collapsed && (
        <div style={{ width: `${splitRatio}%` }} className={`overflow-auto ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
          <div className="p-4 space-y-4">
            <div className="space-y-2">
              <label className={`flex items-center gap-1 text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>
                工作路径
                <span className="text-red-500">*</span>
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={workPath || ''}
                  onChange={(e) => setWorkPath(e.target.value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none transition-all ${
                    theme === 'dark' 
                      ? 'bg-gray-700 text-white focus:ring-2 focus:ring-indigo-500' 
                      : theme === 'light' 
                        ? 'bg-gray-100 text-gray-900 focus:ring-2 focus:ring-indigo-500' 
                        : 'bg-gray-500 text-white focus:ring-2 focus:ring-indigo-500'
                  }`}
                  placeholder="请输入工作路径"
                />
                <button
                  onClick={handleBrowseWorkPath}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    theme === 'dark' 
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white' 
                      : theme === 'light' 
                        ? 'bg-indigo-500 hover:bg-indigo-400 text-white' 
                        : 'bg-indigo-500 hover:bg-indigo-400 text-white'
                  }`}
                >
                  选择文件夹
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className={`block text-xs font-medium mb-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>选择项目</label>
                <div className="relative">
                  <select
                    value={selectedProject || ''}
                    onChange={(e) => handleProjectChange(e.target.value)}
                    className={`w-full px-3 py-2 rounded-lg text-sm appearance-none cursor-pointer outline-none transition-all ${
                      theme === 'dark' 
                        ? 'bg-gray-700 text-white focus:ring-2 focus:ring-indigo-500' 
                        : theme === 'light' 
                          ? 'bg-gray-100 text-gray-900 focus:ring-2 focus:ring-indigo-500' 
                          : 'bg-gray-500 text-white focus:ring-2 focus:ring-indigo-500'
                    }`}
                  >
                    <option value="">请选择项目</option>
                    {projects.map(project => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                  <ChevronDown className={`absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}`} />
                </div>
              </div>

              <div>
                <label className={`block text-xs font-medium mb-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>选择模块</label>
                <div className="relative">
                  <select
                    value={selectedModule || ''}
                    onChange={(e) => handleModuleChange(e.target.value)}
                    disabled={!selectedProject}
                    className={`w-full px-3 py-2 rounded-lg text-sm appearance-none cursor-pointer outline-none transition-all ${
                      selectedProject
                        ? theme === 'dark' 
                          ? 'bg-gray-700 text-white focus:ring-2 focus:ring-indigo-500' 
                          : theme === 'light' 
                            ? 'bg-gray-100 text-gray-900 focus:ring-2 focus:ring-indigo-500' 
                            : 'bg-gray-500 text-white focus:ring-2 focus:ring-indigo-500'
                        : theme === 'dark' 
                          ? 'bg-gray-800 text-gray-600 cursor-not-allowed' 
                          : theme === 'light' 
                            ? 'bg-gray-200 text-gray-400 cursor-not-allowed' 
                            : 'bg-gray-600 text-gray-500 cursor-not-allowed'
                    }`}
                  >
                    <option value="">请选择模块</option>
                    {modules.map(module => (
                      <option key={module.id} value={module.id}>{module.name}</option>
                    ))}
                  </select>
                  <ChevronDown className={`absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${selectedProject ? (theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300') : 'text-gray-600'}`} />
                </div>
              </div>

              <div>
                <label className={`block text-xs font-medium mb-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>参考文档</label>
                <button
                  onClick={() => setShowDocumentModal(true)}
                  className={`px-3 py-2 rounded-lg text-sm transition-all flex items-center justify-center gap-1 ${
                    theme === 'dark'
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : theme === 'light'
                        ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  }`}
                >
                  <FileText className="w-4 h-4" />
                  选择文档
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <span className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>需求描述：</span>
              <textarea
                value={requirement || ''}
                onChange={(e) => setRequirement(e.target.value)}
                rows={4}
                className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-all resize-none ${
                  theme === 'dark' 
                    ? 'bg-gray-700 text-white focus:ring-2 focus:ring-indigo-500' 
                    : theme === 'light' 
                      ? 'bg-gray-100 text-gray-900 focus:ring-2 focus:ring-indigo-500' 
                      : 'bg-gray-500 text-white focus:ring-2 focus:ring-indigo-500'
                }`}
                placeholder="请输入需求描述..."
              />
            </div>

            <div className="flex justify-center">
              <button
                onClick={handleDesign}
                className={`px-8 py-3 rounded-lg text-base font-medium transition-all ${
                  theme === 'dark'
                    ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    : theme === 'light'
                      ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                      : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                }`}
              >
                一键设计
              </button>
            </div>

            <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-amber-50' : 'bg-gray-500/50'}`}>
              <div className="flex items-start gap-2">
                <AlertCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${theme === 'dark' ? 'text-amber-500' : theme === 'light' ? 'text-amber-600' : 'text-amber-400'}`} />
                <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>
                  提示：请先选择项目和模块，然后选择参考文档，设置工作路径并填写需求描述，最后点击"一键设计"按钮生成文档。生成过程可能需要几秒钟时间，请耐心等待。
                </p>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <History className={`w-4 h-4 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}`} />
                <span className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>生成历史</span>
              </div>
              <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`} style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {generatedHistory.length === 0 ? (
                  <p className={`text-xs text-center py-4 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-400'}`}>
                    暂无生成记录
                  </p>
                ) : (
                  <div className="space-y-2">
                    {generatedHistory.map(entry => (
                      <div key={entry.id} className={`p-2 rounded-lg text-xs ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
                        <div className="flex justify-between items-center mb-1">
                          <span className={theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}>{entry.time}</span>
                          <span className={`px-2 py-0.5 rounded ${
                            entry.status === '已完成'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-yellow-100 text-yellow-700'
                          }`}>{entry.status}</span>
                        </div>
                        <div className={theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}>
                          {entry.project} - {entry.module}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {/* 折叠/展开按钮 + 可拖动分隔条 */}
        <div className="relative flex flex-col items-center flex-shrink-0">
          {!collapsed ? (
            <div 
              className={`w-1 h-full cursor-col-resize flex items-center justify-center transition-colors ${
                isDragging 
                  ? `${theme === 'dark' ? 'bg-indigo-500' : theme === 'light' ? 'bg-indigo-400' : 'bg-indigo-500'}` 
                  : `${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500' : theme === 'light' ? 'bg-gray-300 hover:bg-gray-400' : 'bg-gray-400 hover:bg-gray-300'}`
              }`}
              onMouseDown={() => setIsDragging(true)}
            >
              <div className={`w-0.5 h-8 rounded-full ${theme === 'dark' ? 'bg-gray-400' : theme === 'light' ? 'bg-gray-500' : 'bg-gray-300'}`} />
            </div>
          ) : (
            <button
              onClick={() => setCollapsed(false)}
              className={`absolute left-0 top-1/2 -translate-y-1/2 w-5 h-12 flex items-center justify-center cursor-pointer rounded-r-md transition-colors z-10 ${
                theme === 'dark' ? 'bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600' : theme === 'light' ? 'bg-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-300' : 'bg-gray-500 text-gray-300 hover:text-white hover:bg-gray-400'
              }`}
              title="展开侧边栏"
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
          
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className={`absolute right-full top-1/2 -translate-y-1/2 w-5 h-12 flex items-center justify-center cursor-pointer rounded-l-md transition-colors ${
                theme === 'dark' ? 'bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600' : theme === 'light' ? 'bg-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-300' : 'bg-gray-500 text-gray-300 hover:text-white hover:bg-gray-400'
              }`}
              title="收起侧边栏"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
          )}
        </div>

        <div style={{ width: collapsed ? '100%' : `${100 - splitRatio}%` }} className={`flex flex-col overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
          <div className={`flex-1 overflow-auto p-4 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
            <div className="space-y-4">
              {messages?.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-4 py-3 ${msg.type === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
                    <p className="text-sm">{msg.content}</p>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>
          <div className={`p-4 border-t ${theme === 'dark' ? 'border-gray-700 bg-gray-800' : theme === 'light' ? 'border-gray-200 bg-white' : 'border-gray-500 bg-gray-600'}`}>
            <div className="flex gap-2">
              <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="输入您的问题..." className={`flex-1 px-4 py-2 rounded-lg outline-none transition-all ${
                theme === 'dark' ? 'bg-gray-700 text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500' : theme === 'light' ? 'bg-gray-100 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-indigo-500' : 'bg-gray-500 text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500'
              }`} />
              <button onClick={sendMessage} className={`px-4 py-2 rounded-lg transition-all ${theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {showDocumentModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className={`rounded-xl ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`} style={{ width: '500px', maxHeight: '400px', display: 'flex', flexDirection: 'column' }}>
            <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
              <div className={`text-lg font-medium ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                选择参考文档
              </div>
              <div className={`text-sm mt-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                以下是从链接下载并分解后的可选文档（可多选）
              </div>
            </div>
            
            <div className="flex-1 overflow-auto p-3">
              <div className="space-y-2">
                {availableDocuments.map(doc => (
                  <div
                    key={doc.id}
                    onClick={() => handleDocumentToggle(doc.id)}
                    className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                      selectedDocuments.includes(doc.id)
                        ? `${theme === 'dark' ? 'bg-indigo-600/30 border border-indigo-500' : theme === 'light' ? 'bg-indigo-50 border border-indigo-300' : 'bg-indigo-600/30 border border-indigo-500'}`
                        : `${theme === 'dark' ? 'hover:bg-gray-600' : theme === 'light' ? 'hover:bg-gray-100' : 'hover:bg-gray-500'}`
                    }`}
                  >
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                      selectedDocuments.includes(doc.id)
                        ? `${theme === 'dark' ? 'bg-indigo-600 border-indigo-500' : theme === 'light' ? 'bg-indigo-500 border-indigo-500' : 'bg-indigo-600 border-indigo-500'}`
                        : `${theme === 'dark' ? 'border-gray-500' : theme === 'light' ? 'border-gray-300' : 'border-gray-400'}`
                    }`}>
                      {selectedDocuments.includes(doc.id) && (
                        <Check className="w-3 h-3 text-white" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                        {doc.name}
                      </div>
                      <div className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                        {doc.category}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className={`flex justify-end gap-3 p-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
              <button
                onClick={() => setShowDocumentModal(false)}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  theme === 'dark'
                    ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                    : theme === 'light'
                      ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      : 'bg-gray-400 hover:bg-gray-300 text-gray-300'
                }`}
              >
                取消
              </button>
              <button
                onClick={confirmDocuments}
                disabled={selectedDocuments.length === 0}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  selectedDocuments.length === 0
                    ? 'opacity-50 cursor-not-allowed'
                    : `${theme === 'dark'
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : theme === 'light'
                        ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`
                }`}
              >
                确认选择 ({selectedDocuments.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DocumentDesign;
