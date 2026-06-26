import React, { useState, useEffect } from 'react';
import { User, Key, Bot, X } from 'lucide-react';

function LoginScreen({ theme, onLogin, loginConfig, onPersistConfig }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // 初始化时从持久化配置加载
  useEffect(() => {
    if (loginConfig) {
      if (loginConfig.username) setUsername(loginConfig.username);
      if (loginConfig.password !== undefined && loginConfig.password !== null) setPassword(loginConfig.password);
      if (loginConfig.rememberPassword !== undefined) setRememberPassword(loginConfig.rememberPassword);
      if (loginConfig.autoLogin !== undefined) setAutoLogin(loginConfig.autoLogin);
    }
  }, [loginConfig]);

  const handleLogin = async () => {
    if (!username.trim()) return;
    try {
      setLoading(true);
      setError(null);

      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('verify-w3-credentials', {
        uid: username.trim(),
        password: password,
      });

      if (!result.success) {
        setError(result.error || '登录失败，请重试');
        return;
      }

      // 本次会话始终记录密码（不受"记住密码"影响）
      const info = { name: username.trim(), avatar: null, password: password };
      const cfg = {
        username: username.trim(),
        password: rememberPassword ? password : '',
        rememberPassword,
        autoLogin,
      };
      if (onPersistConfig) onPersistConfig(cfg);
      onLogin(info);
    } catch (err) {
      setError(err.message || '登录过程出现异常');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) handleLogin();
  };

  // 根据主题选择背景渐变
  const bgGradient = 
    theme === 'dark'
      ? 'bg-gradient-to-br from-gray-900 via-gray-800 to-indigo-950'
      : theme === 'light'
      ? 'bg-gradient-to-br from-white via-gray-50 to-indigo-50'
      : 'bg-gradient-to-br from-gray-700 via-gray-600 to-gray-500';

  const cardBg = theme === 'dark' ? 'bg-gray-800/80' : theme === 'light' ? 'bg-white' : 'bg-gray-600/80';
  const borderColor = theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-500';
  const textPrimary = theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white';
  const textSecondary = theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300';

  const inputClass = `w-full px-3 py-2.5 rounded-lg text-sm border outline-none transition-all ${
    theme === 'dark'
      ? 'bg-gray-900/60 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500'
      : theme === 'light'
      ? 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:border-indigo-500'
      : 'bg-gray-700 border-gray-400 text-white placeholder-gray-400 focus:border-indigo-400'
  }`;

  const renderCheckbox = (checked, onChange, label) => (
    <label
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 cursor-pointer ${textSecondary} hover:opacity-80`}
    >
      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
        checked
          ? 'bg-indigo-600 border-indigo-600'
          : theme === 'dark'
            ? 'border-gray-500'
            : theme === 'light'
            ? 'border-gray-300'
            : 'border-gray-400'
      }`}>
        {checked && (
          <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
      <span className="text-xs">{label}</span>
    </label>
  );

  return (
    <div className={`fixed inset-0 z-[9999] flex items-center justify-center ${bgGradient}`}>
      {/* 关闭按钮 */}
      <button
        onClick={() => {
          try {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.invoke('window-close');
          } catch {}
        }}
        className={`absolute top-4 right-4 p-2 rounded-lg transition-all z-10 ${
          theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-white/10' : theme === 'light' ? 'text-gray-500 hover:text-gray-800 hover:bg-gray-200' : 'text-gray-300 hover:text-white hover:bg-white/10'
        }`}
        title="关闭"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="flex flex-col items-center gap-8">
        {/* Logo 区 */}
        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${
            theme === 'dark' ? 'bg-indigo-600' : 'bg-indigo-500'
          }`}>
            <Bot className="w-9 h-9 text-white" />
          </div>
          <h1 className={`text-2xl font-bold ${textPrimary}`}>AI 一站式桌面工具</h1>
        </div>

        {/* 登录卡片 */}
        <div className={`w-[380px] rounded-2xl p-6 space-y-5 shadow-2xl backdrop-blur-sm ${cardBg} border ${borderColor}`}>
          <div className="text-center mb-1">
            <h2 className={`text-lg font-semibold ${textPrimary}`}>用户登录</h2>
          </div>

          <div>
            <label className={`text-sm font-medium mb-1.5 block ${textSecondary}`}>
              <User className="w-3.5 h-3.5 inline mr-1.5" />
              用户名
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入用户名"
              className={inputClass}
              autoFocus
            />
          </div>

          <div>
            <label className={`text-sm font-medium mb-1.5 block ${textSecondary}`}>
              <Key className="w-3.5 h-3.5 inline mr-1.5" />
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入密码"
              className={inputClass}
            />
          </div>

          <div className="flex items-center justify-between">
            {renderCheckbox(rememberPassword, setRememberPassword, '记住密码')}
            {renderCheckbox(autoLogin, setAutoLogin, '自动登录')}
          </div>

          <button
            onClick={handleLogin}
            disabled={!username.trim() || loading}
            className={`w-full py-2.5 rounded-lg text-sm transition-all font-medium ${
              !username.trim() || loading
                ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            {loading ? '登录中...' : '登录'}
          </button>

          {error && (
            <div className="text-red-400 text-xs text-center break-words">{error}</div>
          )}

          <div className="flex items-center gap-2">
            <div className={`flex-1 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-300' : 'border-gray-400'}`} />
            <span className={`text-xs ${textSecondary}`}>或</span>
            <div className={`flex-1 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-300' : 'border-gray-400'}`} />
          </div>

          <button
            onClick={() => onLogin({ name: '游客', avatar: null, isGuest: true })}
            className={`w-full py-2.5 rounded-lg text-sm transition-all font-medium border ${
              theme === 'dark'
                ? 'border-gray-600 text-gray-300 hover:bg-gray-700'
                : theme === 'light'
                ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                : 'border-gray-400 text-gray-200 hover:bg-gray-500'
            }`}
          >
            游客模式
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoginScreen;
