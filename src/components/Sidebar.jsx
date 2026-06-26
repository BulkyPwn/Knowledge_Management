import React, { useState, useEffect } from 'react';
import { FileText, Code, Bug, BookOpen, Bot, Settings, User, Moon, Sun, Cloud, RefreshCw, CheckCircle2, AlertCircle, HelpCircle } from 'lucide-react';

function Sidebar({ activeTab, setActiveTab, theme, onSettingsClick, onUserInfoClick, onThemeChange, updateStatus, onNewUpdateFound }) {
  const menuItems = [
    { id: 'knowledge', icon: BookOpen, label: '知识管理' },
    { id: 'document', icon: FileText, label: '辅助设计' },
    { id: 'code', icon: Code, label: '代码分析' },
    { id: 'issue', icon: Bug, label: '问题定位' },
    { id: 'agent', icon: Bot, label: 'Agent' },
  ];

  const [appVersion, setAppVersion] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { ipcRenderer } = window.require('electron');
        const info = await ipcRenderer.invoke('get-app-version');
        if (info && info.version) {
          setAppVersion(info.version);
        }
      } catch {}
    })();
  }, []);

  const handleThemeToggle = () => {
    const themes = ['dark', 'light', 'gray'];
    const currentIndex = themes.indexOf(theme);
    const nextIndex = (currentIndex + 1) % themes.length;
    onThemeChange(themes[nextIndex]);
  };

  const handleVersionClick = async () => {
    if (updateStatus === 'has-update' && onNewUpdateFound) {
      onNewUpdateFound();
      return;
    }

    setChecking(true);
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('check-for-update');
      if (onNewUpdateFound) {
        onNewUpdateFound(result);
      }
    } catch {
      if (onNewUpdateFound) {
        onNewUpdateFound({ hasUpdate: false, currentVersion: appVersion || '1.0.0' });
      }
    }
    setChecking(false);
  };

  const renderVersionIcon = () => {
    if (checking) {
      return <RefreshCw className="w-5 h-5 animate-spin" />;
    }
    if (updateStatus === 'has-update') {
      return <AlertCircle className="w-5 h-5" />;
    }
    return <CheckCircle2 className="w-5 h-5" />;
  };

  const versionTitle = updateStatus === 'has-update'
    ? '有新版本可用，点击更新'
    : appVersion
      ? `当前版本 v${appVersion}，点击检查更新`
      : '点击检查更新';

  const versionColor = updateStatus === 'has-update'
    ? (theme === 'dark' ? 'text-amber-400 hover:bg-amber-900/30' : 'text-amber-600 hover:bg-amber-50')
    : (theme === 'dark' ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-600 hover:text-white');

  const renderThemeIcon = () => {
    switch (theme) {
      case 'dark':
        return <Moon className="w-4 h-4" />;
      case 'light':
        return <Sun className="w-4 h-4" />;
      case 'gray':
        return <Cloud className="w-4 h-4" />;
      default:
        return <Moon className="w-4 h-4" />;
    }
  };

  return (
    <aside className={`w-20 flex flex-col items-center py-4 relative ${theme === 'dark' ? 'bg-gray-900 border-r border-gray-700' : theme === 'light' ? 'bg-white border-r border-gray-200' : 'bg-gray-700 border-r border-gray-600'}`}>
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-8 ${theme === 'dark' ? 'bg-indigo-600' : 'bg-indigo-500'}`}>
        <Bot className="w-7 h-7 text-white" />
      </div>
      
      <nav className="flex-1 flex flex-col gap-2">
        {menuItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center gap-1 transition-all ${
                activeTab === item.id
                  ? `${theme === 'dark' ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white'}`
                  : `${theme === 'dark' ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-600 hover:text-white'}`
              }`}
              title={item.label}
            >
              <Icon className="w-5 h-5" />
              <span className="text-xs">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2 mt-auto">
        <button
          onClick={handleVersionClick}
          className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center gap-1 transition-all ${versionColor}`}
          title={versionTitle}
        >
          {renderVersionIcon()}
          <span className="text-[10px]">{appVersion ? `v${appVersion}` : '版本'}</span>
        </button>

        <button
          onClick={() => {
            try {
              const { ipcRenderer } = window.require('electron');
              ipcRenderer.invoke('open-user-guide');
            } catch {}
          }}
          className={`w-14 h-14 rounded-xl flex items-center justify-center transition-all ${
            theme === 'dark' ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-600 hover:text-white'
          }`}
          title="用户指南"
        >
          <HelpCircle className="w-5 h-5" />
        </button>

        <button
          onClick={handleThemeToggle}
          className={`w-14 h-14 rounded-xl flex items-center justify-center transition-all ${
            theme === 'dark' ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-600 hover:text-white'
          }`}
          title={theme === 'dark' ? '深色模式' : theme === 'light' ? '浅色模式' : '灰色模式'}
        >
          {renderThemeIcon()}
        </button>
        
        <button
          onClick={onSettingsClick}
          className={`w-14 h-14 rounded-xl flex items-center justify-center transition-all ${
            theme === 'dark' ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-600 hover:text-white'
          }`}
          title="设置"
        >
          <Settings className="w-5 h-5" />
        </button>
        
        <button
          onClick={onUserInfoClick}
          className={`w-14 h-14 rounded-xl flex items-center justify-center transition-all ${
            theme === 'dark' ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-600 hover:text-white'
          }`}
          title="用户信息"
        >
          <User className="w-5 h-5" />
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
