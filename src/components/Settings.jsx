import React, { useState, useEffect } from 'react';
import { X, Moon, Sun, Cloud, Palette, Shield, HelpCircle, Globe } from 'lucide-react';

function Settings({ theme, onClose, onThemeChange }) {
  const themes = [
    { id: 'dark', name: '深色模式', icon: Moon },
    { id: 'light', name: '浅色模式', icon: Sun },
    { id: 'gray', name: '灰色模式', icon: Cloud },
  ];

  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { ipcRenderer } = window.require('electron');
        const config = await ipcRenderer.invoke('get-proxy-config');
        if (config) {
          setProxyEnabled(!!config.proxyEnabled);
          setProxyUrl(config.proxyUrl || '');
        }
        const versionInfo = await ipcRenderer.invoke('get-app-version');
        if (versionInfo && versionInfo.version) {
          setAppVersion(versionInfo.version);
        }
      } catch (_) {}
    })();
  }, []);

  const saveProxyConfig = async (enabled, url) => {
    setProxyEnabled(enabled);
    setProxyUrl(url);
    try {
      const { ipcRenderer } = window.require('electron');
      await ipcRenderer.invoke('set-proxy-config', { proxyEnabled: enabled, proxyUrl: url });
    } catch (_) {}
  };

  return (
    <div className={`fixed inset-0 bg-black/50 flex items-center justify-center z-50`}>
      <div className={`w-[500px] rounded-xl overflow-hidden shadow-2xl ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
          <h2 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>设置</h2>
          <button 
            onClick={onClose}
            className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700' : theme === 'light' ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Palette className={`w-5 h-5 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-300'}`} />
              <h3 className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>主题颜色</h3>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {themes.map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => onThemeChange(t.id)}
                    className={`flex flex-col items-center gap-2 p-4 rounded-lg transition-all ${
                      theme === t.id
                        ? `${theme === 'dark' ? 'bg-indigo-600 text-white' : theme === 'light' ? 'bg-indigo-500 text-white' : 'bg-indigo-600 text-white'}`
                        : `${theme === 'dark' ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : theme === 'light' ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-gray-500 text-gray-300 hover:bg-gray-400'}`
                    }`}
                  >
                    <Icon className="w-6 h-6" />
                    <span className="text-sm">{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <Globe className={`w-5 h-5 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-300'}`} />
              <h3 className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>网络代理</h3>
            </div>
            <div className={`p-4 rounded-lg space-y-3 ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>启用 HTTP 代理</span>
                <button
                  onClick={() => {
                    const next = !proxyEnabled;
                    saveProxyConfig(next, proxyUrl);
                  }}
                  className={`w-12 h-6 rounded-full relative transition-colors ${proxyEnabled ? (theme === 'dark' ? 'bg-green-600' : theme === 'light' ? 'bg-green-500' : 'bg-green-600') : (theme === 'dark' ? 'bg-gray-600' : theme === 'light' ? 'bg-gray-300' : 'bg-gray-400')}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${proxyEnabled ? 'left-7' : 'left-1'}`} />
                </button>
              </div>
              {proxyEnabled && (
                <div>
                  <input
                    type="text"
                    value={proxyUrl}
                    onChange={(e) => {
                      saveProxyConfig(proxyEnabled, e.target.value);
                    }}
                    placeholder="http://127.0.0.1:7890"
                    className={`w-full px-3 py-2 rounded-lg text-sm border outline-none transition-all ${
                      theme === 'dark'
                        ? 'bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500'
                        : theme === 'light'
                        ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-indigo-500'
                        : 'bg-gray-500 border-gray-400 text-white placeholder-gray-400 focus:border-indigo-400'
                    }`}
                  />
                  <p className={`text-xs mt-1 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-400'}`}>
                    支持 HTTP/HTTPS 代理，用于下载时加速网络访问
                  </p>
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <Shield className={`w-5 h-5 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-300'}`} />
              <h3 className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>隐私设置</h3>
            </div>
            <div className={`p-4 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
              <div className="flex items-center justify-between mb-3">
                <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>数据收集</span>
                <div className={`w-12 h-6 rounded-full relative cursor-pointer ${theme === 'dark' ? 'bg-gray-600' : theme === 'light' ? 'bg-gray-300' : 'bg-gray-400'}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${theme === 'dark' ? 'bg-gray-400 left-1' : theme === 'light' ? 'bg-gray-400 left-1' : 'bg-gray-400 left-1'}`} />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>安全模式</span>
                <div className={`w-12 h-6 rounded-full relative cursor-pointer ${theme === 'dark' ? 'bg-green-600' : theme === 'light' ? 'bg-green-500' : 'bg-green-600'}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white left-7`} />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 py-3">
            <HelpCircle className={`w-4 h-4 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`} />
            <span className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>AI一站式桌面 v{appVersion || '1.0.0'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
