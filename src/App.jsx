import React, { useState, useEffect, lazy, Suspense } from 'react';
import Sidebar from './components/Sidebar';
import ErrorBoundary from './components/ErrorBoundary';
const DocumentDesign = lazy(() => import('./components/DocumentDesign'));
const CodeDevelopment = lazy(() => import('./components/CodeDevelopment'));
const IssueLocation = lazy(() => import('./components/IssueLocation'));
const KnowledgeManagement = lazy(() => import('./components/KnowledgeManagement'));
const Agent = lazy(() => import('./components/Agent'));
const Settings = lazy(() => import('./components/Settings'));
const LoginScreen = lazy(() => import('./components/LoginScreen'));
const UserInfoPanel = lazy(() => import('./components/UserInfoPanel'));
const UpdateDialog = lazy(() => import('./components/UpdateDialog'));

function App() {
  const [activeTab, setActiveTab] = useState('knowledge');
  const [theme, setTheme] = useState('dark');
  const [showSettings, setShowSettings] = useState(false);
  const [showUserInfo, setShowUserInfo] = useState(false);
  const [userInfo, setUserInfo] = useState(null);
  const [loginConfig, setLoginConfig] = useState({});
  
  const [documentTabs, setDocumentTabs] = useState([{ id: 1, name: '一键设计 1' }]);
  const [documentActiveTab, setDocumentActiveTab] = useState(1);
  const [documentTabStates, setDocumentTabStates] = useState({
    1: {
      selectedProject: '',
      selectedModule: '',
      selectedDocuments: [],
      workPath: '',
      requirement: '',
      generatedHistory: [],
      messages: []
    }
  });
  
  const [codeTabs, setCodeTabs] = useState([{ id: 1, name: 'Code Page 1' }]);
  const [codeActiveTab, setCodeActiveTab] = useState(1);
  const [codeTabStates, setCodeTabStates] = useState({
    1: {
      messages: [],
      fileContent: '',
      currentPath: '',
      fileTree: []
    }
  });
  
  const [issueTabs, setIssueTabs] = useState([{ id: 1, name: '问题定位 1' }]);
  const [issueActiveTab, setIssueActiveTab] = useState(1);
  const [issueTabStates, setIssueTabStates] = useState({
    1: {
      messages: [],
      selectedType: '',
      selectedPriority: '',
      description: ''
    }
  });
  
  const [knowledgeTabs, setKnowledgeTabs] = useState([{ id: 1, name: '知识管理 1' }]);
  const [knowledgeActiveTab, setKnowledgeActiveTab] = useState(1);
  const [knowledgeTabStates, setKnowledgeTabStates] = useState({
    1: {
      messages: [],
      selectedDomain: [],
      selectedPlatform: [],
      databasePath: '',
      knowledgePath: ''
    }
  });
  
  const [agentMessages, setAgentMessages] = useState([]);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [toolUpdates, setToolUpdates] = useState(null); // { updates: [...], checkedAt }

  const getMemoryFile = () => {
    try {
      const path = window.require('path');
      const os = window.require('os');
      return path.join(os.homedir(), '.SSSC_AI', 'app_state.json');
    } catch {
      return null;
    }
  };

  const readMemoryFile = () => {
    try {
      const fs = window.require('fs');
      const f = getMemoryFile();
      if (f && fs.existsSync(f)) {
        return JSON.parse(fs.readFileSync(f, 'utf-8'));
      }
    } catch {}
    return {};
  };

  const writeMemoryFile = (updates) => {
    try {
      const fs = window.require('fs');
      const path = window.require('path');
      const f = getMemoryFile();
      if (!f) return;
      const dir = path.dirname(f);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let data = {};
      if (fs.existsSync(f)) {
        try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
      }
      Object.assign(data, updates);
      fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8');
    } catch {}
  };

  useEffect(() => {
    const data = readMemoryFile();
    // 每次启动默认进入知识管理页面，避免上次 agent 页面导致黑屏
    // if (data.activeTab) { setActiveTab(data.activeTab); }
    if (data.memoryLoginConfig) {
      setLoginConfig(data.memoryLoginConfig);
    }
    // 自动登录：勾选了自动登录且有用户名则直接尝试登录
    const cfg = data.memoryLoginConfig;
    if (cfg && cfg.autoLogin && cfg.username) {
      if (data.memoryUserInfo) {
        setUserInfo(data.memoryUserInfo);
      } else {
        const info = { name: cfg.username, avatar: null, password: cfg.password || '' };
        setUserInfo(info);
        writeMemoryFile({ memoryUserInfo: info });
      }
    }
  }, []);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { ipcRenderer } = window.require('electron');
        const result = await ipcRenderer.invoke('check-for-update');
        if (result.hasUpdate) {
          setUpdateInfo(result);
          setShowUpdateDialog(true);
        }
      } catch {}
    };
    const timer = setTimeout(checkUpdate, 5000);
    return () => clearTimeout(timer);
  }, []);

  // 监听依赖工具更新事件（来自主进程后台检测或用户点击通知）
  useEffect(() => {
    const { ipcRenderer } = window.require('electron');

    const handleToolUpdateStatus = (event, data) => {
      console.log('[tool-update] Received status:', data);
      // 更新全局状态（Sidebar 等组件可使用）
      if (data.updates && data.updates.length > 0) {
        setToolUpdates(data);
      }
    };

    const handleToolUpdateShowDialog = (event, data) => {
      console.log('[tool-update] Show dialog:', data);
      setToolUpdates(data);
    };

    ipcRenderer.on('dependency-tool-update-status', handleToolUpdateStatus);
    ipcRenderer.on('dependency-tool-update-show-dialog', handleToolUpdateShowDialog);

    return () => {
      ipcRenderer.removeListener('dependency-tool-update-status', handleToolUpdateStatus);
      ipcRenderer.removeListener('dependency-tool-update-show-dialog', handleToolUpdateShowDialog);
    };
  }, []);

  const handleSetActiveTab = (tab) => {
    setActiveTab(tab);
    writeMemoryFile({ activeTab: tab });
  };

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('theme-changed', newTheme);
    } catch {}
  };

  const handleLogin = (info) => {
    setUserInfo(info);
    setShowUserInfo(false);
    // 始终写入当前会话的用户信息（含密码），供预处理等后端服务使用
    writeMemoryFile({ memoryUserInfo: info });
  };

  const handleLogout = () => {
    setUserInfo(null);
    setShowUserInfo(false);
    writeMemoryFile({ memoryUserInfo: null });
  };

  const handlePersistLoginConfig = (cfg) => {
    setLoginConfig(cfg);
    // memoryLoginConfig 仅管理备忘配置（记住密码/自动登录等），不干扰 memoryUserInfo
    writeMemoryFile({ memoryLoginConfig: cfg });
  };

  const dismissToolUpdates = () => {
    setToolUpdates(null);
  };

  const handleToolUpdateClick = async (tool) => {
    console.log('[tool-update] User clicked update for:', tool.name);
    // 切换到知识管理页面，用户可以从那里重新下载安装工具
    setActiveTab('knowledge');
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'document':
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <DocumentDesign 
              theme={theme} 
              tabs={documentTabs}
              setTabs={setDocumentTabs}
              activeTab={documentActiveTab}
              setActiveTab={setDocumentActiveTab}
              tabStates={documentTabStates}
              setTabStates={setDocumentTabStates}
            />
          </Suspense>
        );
      case 'code':
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <CodeDevelopment 
              theme={theme}
              tabs={codeTabs}
              setTabs={setCodeTabs}
              activeTab={codeActiveTab}
              setActiveTab={setCodeActiveTab}
              tabStates={codeTabStates}
              setTabStates={setCodeTabStates}
            />
          </Suspense>
        );
      case 'issue':
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <IssueLocation 
              theme={theme}
              tabs={issueTabs}
              setTabs={setIssueTabs}
              activeTab={issueActiveTab}
              setActiveTab={setIssueActiveTab}
              tabStates={issueTabStates}
              setTabStates={setIssueTabStates}
            />
          </Suspense>
        );
      case 'knowledge':
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <KnowledgeManagement 
              theme={theme}
              tabs={knowledgeTabs}
              setTabs={setKnowledgeTabs}
              activeTab={knowledgeActiveTab}
              setActiveTab={setKnowledgeActiveTab}
              tabStates={knowledgeTabStates}
              setTabStates={setKnowledgeTabStates}
              userInfo={userInfo}
            />
          </Suspense>
        );
      case 'agent':
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <Agent theme={theme} messages={agentMessages} setMessages={setAgentMessages} />
          </Suspense>
        );
      default:
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <DocumentDesign 
              theme={theme} 
              tabs={documentTabs}
              setTabs={setDocumentTabs}
              activeTab={documentActiveTab}
              setActiveTab={setDocumentActiveTab}
              tabStates={documentTabStates}
              setTabStates={setDocumentTabStates}
            />
          </Suspense>
        );
    }
  };

  return (
    <div className={`h-screen w-screen flex flex-col overflow-hidden ${theme === 'dark' ? 'bg-gray-900' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}>
      <div
        className={`flex items-center h-8 px-3 flex-shrink-0 select-none ${theme === 'dark' ? 'bg-gray-900 text-gray-300' : theme === 'light' ? 'bg-white text-gray-600' : 'bg-gray-700 text-gray-300'}`}
        style={{ WebkitAppRegion: 'drag' } }
      >
        <span className="text-xs font-medium">AI一站式桌面</span>
        <div className="ml-auto flex items-center" style={{ WebkitAppRegion: 'no-drag' }}>
          <button
            onClick={() => { try { const { ipcRenderer } = window.require('electron'); ipcRenderer.invoke('window-minimize'); } catch {} }}
            className={`w-11 h-8 flex items-center justify-center transition-colors ${
              theme === 'dark' ? 'text-white/70 hover:text-white hover:bg-white/10' : theme === 'light' ? 'text-gray-500 hover:text-gray-800 hover:bg-gray-200' : 'text-gray-300 hover:text-white hover:bg-white/10'
            }`}
          >
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button
            onClick={() => { try { const { ipcRenderer } = window.require('electron'); ipcRenderer.invoke('window-maximize'); } catch {} }}
            className={`w-11 h-8 flex items-center justify-center transition-colors ${
              theme === 'dark' ? 'text-white/70 hover:text-white hover:bg-white/10' : theme === 'light' ? 'text-gray-500 hover:text-gray-800 hover:bg-gray-200' : 'text-gray-300 hover:text-white hover:bg-white/10'
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9"/></svg>
          </button>
          <button
            onClick={() => { try { const { ipcRenderer } = window.require('electron'); ipcRenderer.invoke('window-close'); } catch {} }}
            className={`w-11 h-8 flex items-center justify-center transition-colors ${
              theme === 'dark' ? 'text-white/70 hover:text-white hover:bg-red-600' : theme === 'light' ? 'text-gray-500 hover:text-white hover:bg-red-500' : 'text-gray-300 hover:text-white hover:bg-red-600'
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
          </button>
        </div>
      </div>
      <div className={`flex flex-1 overflow-hidden`}>
      {/* 依赖工具更新提示横幅 */}
      {toolUpdates && toolUpdates.updates && toolUpdates.updates.length > 0 && (
        <div className="fixed top-0 left-0 right-0 z-50 flex justify-center" style={{ pointerEvents: 'none' }}>
          <div
            className={`mt-2 px-6 py-3 rounded-lg shadow-lg flex items-center gap-4 ${theme === 'dark' ? 'bg-amber-900/90 text-amber-100' : 'bg-amber-50 text-amber-800 border border-amber-300'}`}
            style={{ pointerEvents: 'auto' }}
          >
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div>
                <p className="text-sm font-medium">
                  {toolUpdates.updates.length === 1
                    ? `${toolUpdates.updates[0].name} 有新版本可用`
                    : `${toolUpdates.updates.map(u => u.name).join('、')} 有新版本可用`}
                </p>
                <p className="text-xs opacity-80 mt-0.5">
                  {toolUpdates.updates.map(u => `${u.name}: ${u.reason}`).join('；')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {toolUpdates.updates.map(update => (
                <button
                  key={update.toolId}
                  onClick={() => handleToolUpdateClick(update)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                    theme === 'dark'
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-amber-500 hover:bg-amber-600 text-white'
                  }`}
                >
                  前往更新
                </button>
              ))}
              <button
                onClick={dismissToolUpdates}
                className={`p-1 rounded transition-colors ${
                  theme === 'dark' ? 'hover:bg-amber-800/50' : 'hover:bg-amber-200'
                }`}
                title="关闭"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={handleSetActiveTab} 
        theme={theme}
        onSettingsClick={() => setShowSettings(true)}
        onUserInfoClick={() => setShowUserInfo(true)}
        onThemeChange={handleThemeChange}
        updateStatus={updateInfo && updateInfo.hasUpdate ? 'has-update' : 'up-to-date'}
        onNewUpdateFound={(info) => { if (info) setUpdateInfo(info); setShowUpdateDialog(true); }}
      />
      <main className={`flex-1 overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-100'}`}>
        <ErrorBoundary>
          {renderContent()}
        </ErrorBoundary>
      </main>
      </div>
      {showSettings && (
        <Suspense fallback={null}>
          <Settings 
            theme={theme}
            onClose={() => setShowSettings(false)}
            onThemeChange={handleThemeChange}
          />
        </Suspense>
      )}
      {!userInfo && (
        <Suspense fallback={null}>
          <LoginScreen 
            theme={theme}
            onLogin={handleLogin}
            loginConfig={loginConfig}
            onPersistConfig={handlePersistLoginConfig}
          />
        </Suspense>
      )}
      {showUserInfo && (
        <Suspense fallback={null}>
          <UserInfoPanel 
            theme={theme}
            onClose={() => setShowUserInfo(false)}
            userInfo={userInfo}
            onLogin={handleLogin}
            onLogout={handleLogout}
            loginConfig={loginConfig}
            onPersistConfig={handlePersistLoginConfig}
          />
        </Suspense>
      )}
      {showUpdateDialog && updateInfo && (
        <Suspense fallback={null}>
          <UpdateDialog
            theme={theme}
            onClose={() => { setShowUpdateDialog(false); setUpdateInfo(null); }}
            updateInfo={updateInfo}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
