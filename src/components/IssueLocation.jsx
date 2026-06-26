import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Plus, X, Upload, Play, ChevronDown, ChevronRight, FileText, Code, Wrench, ChevronLeft } from 'lucide-react';

function IssueLocation({ theme, tabs, setTabs, activeTab, setActiveTab, tabStates, setTabStates }) {
  const [splitRatio, setSplitRatio] = useState(40);
  const [isDragging, setIsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const fileInputRef = useRef(null);
  const codeInputRef = useRef(null);
  
  const messages = useMemo(() => tabStates[activeTab]?.messages || [], [tabStates, activeTab]);
  const logs = useMemo(() => tabStates[activeTab]?.logs || '', [tabStates, activeTab]);
  const code = useMemo(() => tabStates[activeTab]?.code || '', [tabStates, activeTab]);
  const selectedTools = useMemo(() => tabStates[activeTab]?.selectedTools || [], [tabStates, activeTab]);
  const analysisResults = useMemo(() => tabStates[activeTab]?.analysisResults || [], [tabStates, activeTab]);
  const selectedType = useMemo(() => tabStates[activeTab]?.selectedType || '', [tabStates, activeTab]);
  const selectedPriority = useMemo(() => tabStates[activeTab]?.selectedPriority || '', [tabStates, activeTab]);
  const description = useMemo(() => tabStates[activeTab]?.description || '', [tabStates, activeTab]);
  
  const setMessages = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], messages: value }
    }));
  };
  
  const setLogs = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], logs: value }
    }));
  };
  
  const setCode = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], code: value }
    }));
  };
  
  const setSelectedTools = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedTools: value }
    }));
  };
  
  const setAnalysisResults = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], analysisResults: value }
    }));
  };
  
  const setSelectedType = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedType: value }
    }));
  };
  
  const setSelectedPriority = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedPriority: value }
    }));
  };
  
  const setDescription = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], description: value }
    }));
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      const container = document.querySelector('.issue-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(Math.max(newRatio, 20), 80));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    const container = document.querySelector('.issue-container');
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

  const tools = [
    { id: 'log_parser', name: '日志解析器', description: '解析日志文件，提取关键信息' },
    { id: 'code_analyzer', name: '代码分析器', description: '分析代码结构和潜在问题' },
    { id: 'dependency_checker', name: '依赖检查器', description: '检查依赖版本和安全性' },
    { id: 'performance_profiler', name: '性能分析器', description: '分析性能瓶颈' },
  ];

  const addTab = () => {
    const newId = tabs.length + 1;
    setTabs([...tabs, { id: newId, name: `分析页面 ${newId}` }]);
    setActiveTab(newId);
    setTabStates(prev => ({
      ...prev,
      [newId]: {
        messages: [],
        logs: '',
        code: '',
        selectedTools: [],
        analysisResults: [],
        selectedType: '',
        selectedPriority: '',
        description: ''
      }
    }));
  };

  const closeTab = (id) => {
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTab === id) {
      setActiveTab(newTabs[0]?.id || 1);
    }
  };

  const handleLogUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setLogs(event.target.result);
      };
      reader.readAsText(file);
    }
  };

  const handleCodeUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setCode(event.target.result);
      };
      reader.readAsText(file);
    }
  };

  const toggleTool = (toolId) => {
    setSelectedTools(selectedTools.includes(toolId)
      ? selectedTools.filter(id => id !== toolId)
      : [...selectedTools, toolId]
    );
  };

  const runAnalysis = () => {
    setIsAnalyzing(true);
    setAnalysisResults([]);
    
    setTimeout(() => {
      const results = [
        { type: 'info', title: '日志分析开始', content: '正在解析上传的日志文件...' },
        { type: 'warning', title: '发现潜在问题', content: '检测到多个错误日志条目，需要进一步分析' },
        { type: 'error', title: '关键错误', content: '第156行：NullReferenceException - 对象引用未设置为对象实例' },
        { type: 'success', title: '分析完成', content: '共发现3个严重问题，5个警告，建议优先处理空引用异常' },
      ];
      setAnalysisResults(results);
      setIsAnalyzing(false);
    }, 2000);
  };

  return (
    <div className="h-full flex flex-col">
      <div className={`flex items-center gap-1 px-2 py-2 ${theme === 'dark' ? 'bg-gray-800 border-b border-gray-700' : theme === 'light' ? 'bg-white border-b border-gray-200' : 'bg-gray-600 border-b border-gray-500'}`}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`flex items-center gap-2 px-4 py-2 rounded-t-lg cursor-pointer transition-all ${
              activeTab === tab.id
                ? `${theme === 'dark' ? 'bg-gray-700 text-white' : theme === 'light' ? 'bg-gray-100 text-gray-900' : 'bg-gray-500 text-white'}`
                : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-300 hover:text-white'}`
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
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

      <div className="flex-1 flex overflow-hidden issue-container">
        {!collapsed && (
        <div style={{ width: `${splitRatio}%` }} className={`flex flex-col overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
          <div className={`flex-1 overflow-auto p-4 space-y-4 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
            <div className={`rounded-lg p-4 ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-4 h-4" />
                <span className="text-sm font-semibold">日志导入</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleLogUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg transition-all ${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : theme === 'light' ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-gray-400 hover:bg-gray-300 text-gray-800'}`}
              >
                <Upload className="w-4 h-4" />
                <span className="text-sm">上传日志文件</span>
              </button>
              {logs && (
                <div className={`mt-3 p-3 rounded-lg text-xs font-mono overflow-auto max-h-32 ${theme === 'dark' ? 'bg-gray-800 text-gray-400' : theme === 'light' ? 'bg-white text-gray-600' : 'bg-gray-600 text-gray-300'}`}>
                  {logs.substring(0, 500)}...
                </div>
              )}
            </div>

            <div className={`rounded-lg p-4 ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
              <div className="flex items-center gap-2 mb-3">
                <Code className="w-4 h-4" />
                <span className="text-sm font-semibold">代码导入</span>
              </div>
              <input
                ref={codeInputRef}
                type="file"
                onChange={handleCodeUpload}
                className="hidden"
              />
              <button
                onClick={() => codeInputRef.current?.click()}
                className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg transition-all ${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : theme === 'light' ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-gray-400 hover:bg-gray-300 text-gray-800'}`}
              >
                <Upload className="w-4 h-4" />
                <span className="text-sm">上传代码文件</span>
              </button>
              {code && (
                <div className={`mt-3 p-3 rounded-lg text-xs font-mono overflow-auto max-h-32 ${theme === 'dark' ? 'bg-gray-800 text-gray-400' : theme === 'light' ? 'bg-white text-gray-600' : 'bg-gray-600 text-gray-300'}`}>
                  {code.substring(0, 500)}...
                </div>
              )}
            </div>

            <div className={`rounded-lg p-4 ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
              <div className="flex items-center gap-2 mb-3">
                <Wrench className="w-4 h-4" />
                <span className="text-sm font-semibold">工具选择</span>
              </div>
              <div className="space-y-2">
                {tools.map(tool => (
                  <div
                    key={tool.id}
                    onClick={() => toggleTool(tool.id)}
                    className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                      selectedTools.includes(tool.id)
                        ? `${theme === 'dark' ? 'bg-indigo-600 text-white' : theme === 'light' ? 'bg-indigo-500 text-white' : 'bg-indigo-600 text-white'}`
                        : `${theme === 'dark' ? 'bg-gray-600 text-gray-300 hover:bg-gray-500' : theme === 'light' ? 'bg-white text-gray-700 hover:bg-gray-100' : 'bg-gray-400 text-gray-800 hover:bg-gray-300'}`
                    }`}
                  >
                    {selectedTools.includes(tool.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <div>
                      <div className="text-sm font-medium">{tool.name}</div>
                      <div className="text-xs opacity-70">{tool.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p-4">
            <button
              onClick={runAnalysis}
              disabled={isAnalyzing}
              className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg transition-all ${
                isAnalyzing
                  ? `${theme === 'dark' ? 'bg-gray-600 text-gray-400' : theme === 'light' ? 'bg-gray-200 text-gray-400' : 'bg-gray-500 text-gray-400'}`
                  : `${theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`
              }`}
            >
              <Play className={`w-4 h-4 ${isAnalyzing ? 'animate-spin' : ''}`} />
              <span className="text-sm">{isAnalyzing ? '分析中...' : '开始分析'}</span>
            </button>
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
          <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
            <h3 className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>分析结果</h3>
          </div>
          
          <div className={`flex-1 overflow-auto p-4 space-y-3 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
            {isAnalyzing && (
              <div className={`p-4 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white' : 'bg-gray-500'}`}>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm">正在分析，请稍候...</span>
                </div>
              </div>
            )}
            
            {analysisResults?.map((result, idx) => (
              <div
                key={idx}
                className={`p-4 rounded-lg ${
                  result.type === 'error' 
                    ? `${theme === 'dark' ? 'bg-red-900/30 border-l-4 border-red-500' : theme === 'light' ? 'bg-red-50 border-l-4 border-red-500' : 'bg-red-900/30 border-l-4 border-red-500'}`
                    : result.type === 'warning'
                      ? `${theme === 'dark' ? 'bg-yellow-900/30 border-l-4 border-yellow-500' : theme === 'light' ? 'bg-yellow-50 border-l-4 border-yellow-500' : 'bg-yellow-900/30 border-l-4 border-yellow-500'}`
                      : result.type === 'success'
                        ? `${theme === 'dark' ? 'bg-green-900/30 border-l-4 border-green-500' : theme === 'light' ? 'bg-green-50 border-l-4 border-green-500' : 'bg-green-900/30 border-l-4 border-green-500'}`
                        : `${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white' : 'bg-gray-500'}`
                }`}
              >
                <div className="font-semibold text-sm mb-1">{result.title}</div>
                <div className="text-sm opacity-80">{result.content}</div>
              </div>
            ))}
            
            {!isAnalyzing && !analysisResults?.length && (
              <div className={`p-8 rounded-lg text-center ${theme === 'dark' ? 'bg-gray-700 text-gray-400' : theme === 'light' ? 'bg-white text-gray-500' : 'bg-gray-500 text-gray-300'}`}>
                <Wrench className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">请上传日志或代码文件，并选择分析工具</p>
                <p className="text-sm mt-1">然后点击"开始分析"按钮</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default IssueLocation;