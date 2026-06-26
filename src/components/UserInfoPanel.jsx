import React, { useState, useEffect } from 'react';
import { X, User, Key, Eye, EyeOff, Edit3, Check, LogOut } from 'lucide-react';

function UserInfoPanel({ theme, onClose, userInfo, onLogin, onLogout, loginConfig, onPersistConfig }) {
  const [showPassword, setShowPassword] = useState(false);
  const [editField, setEditField] = useState(null);
  const [editUsername, setEditUsername] = useState(userInfo?.name || '');
  const [editPassword, setEditPassword] = useState(userInfo?.password || '');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);

  useEffect(() => {
    if (loginConfig) {
      if (loginConfig.rememberPassword !== undefined) setRememberPassword(loginConfig.rememberPassword);
      if (loginConfig.autoLogin !== undefined) setAutoLogin(loginConfig.autoLogin);
    }
  }, [loginConfig]);

  const persistConfig = (cfg) => {
    if (onPersistConfig) onPersistConfig(cfg);
  };

  const handleSaveEdit = () => {
    const name = editUsername.trim() || userInfo?.name || '';
    const pwd = editPassword;
    const info = { name, avatar: null, password: pwd };
    persistConfig({
      username: name,
      password: rememberPassword ? pwd : '',
      rememberPassword,
      autoLogin,
    });
    onLogin(info);
    setEditField(null);
  };

  const handleCancelEdit = () => {
    setEditUsername(userInfo?.name || '');
    setEditPassword(userInfo?.password || '');
    setEditField(null);
  };

  const handleLogout = () => {
    persistConfig({
      username: userInfo?.name || '',
      password: rememberPassword ? (userInfo?.password || '') : '',
      rememberPassword,
      autoLogin,
    });
    setShowPassword(false);
    setEditField(null);
    onLogout();
  };

  const inputClass = `w-full px-3 py-2 rounded-lg text-sm border outline-none transition-all ${
    theme === 'dark'
      ? 'bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500'
      : theme === 'light'
      ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-indigo-500'
      : 'bg-gray-500 border-gray-400 text-white placeholder-gray-400 focus:border-indigo-400'
  }`;

  const labelClass = `text-sm font-medium mb-1.5 block ${
    theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'
  }`;

  return (
    <div className={`fixed inset-0 bg-black/50 flex items-center justify-center z-50`}>
      <div className={`w-[420px] rounded-xl overflow-hidden shadow-2xl ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
        {/* 标题栏 */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
          <h2 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>用户信息</h2>
          <button 
            onClick={onClose}
            className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700' : theme === 'light' ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          <div className={`p-4 rounded-lg space-y-4 ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
            {/* 头像 + 状态 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-600' : 'bg-indigo-500'}`}>
                  <User className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className={`text-sm font-medium ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>{userInfo?.name}</p>
                  <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>已登录</p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className={`p-2 rounded-lg text-sm transition-all flex items-center gap-1.5 ${
                  theme === 'dark' ? 'text-red-400 hover:bg-red-900/30' : theme === 'light' ? 'text-red-500 hover:bg-red-50' : 'text-red-300 hover:bg-red-900/30'
                }`}
              >
                <LogOut className="w-4 h-4" />
                <span className="text-xs">退出</span>
              </button>
            </div>

            {/* 分隔线 */}
            <div className={`border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-400'}`} />

            {/* 用户名行 */}
            <div>
              <label className={labelClass}>
                <User className="w-3.5 h-3.5 inline mr-1.5" />
                用户名
              </label>
              <div className="flex items-center gap-2">
                {editField === 'username' ? (
                  <>
                    <input
                      type="text"
                      value={editUsername}
                      onChange={(e) => setEditUsername(e.target.value)}
                      className={inputClass}
                      autoFocus
                    />
                    <button onClick={handleSaveEdit} className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-green-400 hover:bg-gray-800' : theme === 'light' ? 'text-green-600 hover:bg-gray-100' : 'text-green-400 hover:bg-gray-500'}`} title="保存">
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={handleCancelEdit} className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-800' : theme === 'light' ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-500'}`} title="取消">
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className={`flex-1 px-3 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-800 text-gray-200' : theme === 'light' ? 'bg-white text-gray-700' : 'bg-gray-500 text-gray-200'}`}>
                      {userInfo?.name}
                    </div>
                    <button
                      onClick={() => { setEditUsername(userInfo?.name || ''); setEditField('username'); }}
                      className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-gray-800' : theme === 'light' ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:text-white hover:bg-gray-500'}`}
                      title="修改用户名"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 密码行 */}
            <div>
              <label className={labelClass}>
                <Key className="w-3.5 h-3.5 inline mr-1.5" />
                密码
              </label>
              <div className="flex items-center gap-2">
                {editField === 'password' ? (
                  <>
                    <input
                      type="text"
                      value={editPassword}
                      onChange={(e) => setEditPassword(e.target.value)}
                      className={inputClass}
                      autoFocus
                    />
                    <button onClick={handleSaveEdit} className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-green-400 hover:bg-gray-800' : theme === 'light' ? 'text-green-600 hover:bg-gray-100' : 'text-green-400 hover:bg-gray-500'}`} title="保存">
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={handleCancelEdit} className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-800' : theme === 'light' ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-500'}`} title="取消">
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className={`flex-1 px-3 py-2 rounded-lg text-sm font-mono tracking-widest ${theme === 'dark' ? 'bg-gray-800 text-gray-200' : theme === 'light' ? 'bg-white text-gray-700' : 'bg-gray-500 text-gray-200'}`}>
                      {userInfo?.password
                        ? (showPassword ? userInfo.password : '\u2022'.repeat(Math.min(userInfo.password.length, 16)))
                        : (showPassword ? '' : <span className="tracking-normal text-xs opacity-50">未保存</span>)
                      }
                    </div>
                    <button
                      onClick={() => setShowPassword(!showPassword)}
                      className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-gray-800' : theme === 'light' ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:text-white hover:bg-gray-500'}`}
                      title={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => { setEditPassword(userInfo?.password || ''); setEditField('password'); }}
                      className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-gray-800' : theme === 'light' ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:text-white hover:bg-gray-500'}`}
                      title="修改密码"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 配置选项（可交互） */}
            <div className={`border-t pt-3 ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-400'}`}>
              <div className="flex items-center gap-4">
                <label
                  onClick={() => {
                    const next = !rememberPassword;
                    setRememberPassword(next);
                    persistConfig({
                      username: userInfo?.name || '',
                      password: next ? (userInfo?.password || '') : '',
                      rememberPassword: next,
                      autoLogin,
                    });
                  }}
                  className={`flex items-center gap-2 cursor-pointer ${
                    theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : theme === 'light' ? 'text-gray-500 hover:text-gray-700' : 'text-gray-300 hover:text-gray-200'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                    rememberPassword
                      ? theme === 'dark'
                        ? 'bg-indigo-600 border-indigo-600'
                        : theme === 'light'
                        ? 'bg-indigo-500 border-indigo-500'
                        : 'bg-indigo-500 border-indigo-500'
                      : theme === 'dark'
                        ? 'border-gray-500'
                        : theme === 'light'
                        ? 'border-gray-300'
                        : 'border-gray-400'
                  }`}>
                    {rememberPassword && (
                      <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <span className="text-xs">记住密码</span>
                </label>
                <label
                  onClick={() => {
                    const next = !autoLogin;
                    setAutoLogin(next);
                    persistConfig({
                      username: userInfo?.name || '',
                      password: rememberPassword ? (userInfo?.password || '') : '',
                      rememberPassword,
                      autoLogin: next,
                    });
                  }}
                  className={`flex items-center gap-2 cursor-pointer ${
                    theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : theme === 'light' ? 'text-gray-500 hover:text-gray-700' : 'text-gray-300 hover:text-gray-200'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                    autoLogin
                      ? theme === 'dark'
                        ? 'bg-indigo-600 border-indigo-600'
                        : theme === 'light'
                        ? 'bg-indigo-500 border-indigo-500'
                        : 'bg-indigo-500 border-indigo-500'
                      : theme === 'dark'
                        ? 'border-gray-500'
                        : theme === 'light'
                        ? 'border-gray-300'
                        : 'border-gray-400'
                  }`}>
                    {autoLogin && (
                      <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <span className="text-xs">自动登录</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default UserInfoPanel;
