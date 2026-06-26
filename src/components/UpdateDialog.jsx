import React, { useState } from 'react';
import { X, Download, AlertCircle, CheckCircle, CheckCircle2, Loader, HardDrive } from 'lucide-react';

function UpdateDialog({ theme, onClose, updateInfo }) {
  const [state, setState] = useState(updateInfo && updateInfo.hasUpdate ? 'confirm' : 'up-to-date');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const handleConfirm = async () => {
    setState('downloading');
    setProgress(10);

    try {
      const { ipcRenderer } = window.require('electron');
      const downloadUrl = updateInfo.downloadUrl;

      if (!downloadUrl) {
        setState('error');
        setErrorMsg('未获取到下载地址');
        return;
      }

      setProgress(30);

      const result = await ipcRenderer.invoke('download-update', downloadUrl, updateInfo.sha256 || '');

      if (!result.success) {
        setState('error');
        setErrorMsg(result.message || '下载失败');
        return;
      }

      setProgress(95);
      const installResult = await ipcRenderer.invoke('install-update', result.path);

      if (!installResult.success) {
        setState('error');
        setErrorMsg(installResult.message || '启动安装失败');
        return;
      }

      if (installResult.installing) {
        setState('installing');
      } else {
        setProgress(100);
        setState('success');
      }
    } catch (err) {
      setState('error');
      setErrorMsg(err.message || '更新过程中发生错误');
    }
  };

  const renderContent = () => {
    switch (state) {
      case 'up-to-date':
        return (
          <div className="text-center py-4">
            <CheckCircle2 className={`w-12 h-12 mx-auto mb-4 ${theme === 'dark' ? 'text-green-400' : 'text-green-600'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              已是最新版本
            </h3>
            {updateInfo && updateInfo.currentVersion && (
              <p className={`text-sm mb-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                当前版本 v{updateInfo.currentVersion}
              </p>
            )}
            {updateInfo && updateInfo.latestVersion && (
              <p className={`text-sm mb-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                最新版本 v{updateInfo.latestVersion}
              </p>
            )}
            {updateInfo && updateInfo.updateTime && (
              <p className={`text-xs mb-4 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                发布时间：{updateInfo.updateTime}
              </p>
            )}
            {updateInfo && updateInfo.releaseNotes && (
              <div className={`mb-4 p-3 rounded-lg text-sm max-h-32 overflow-y-auto text-left ${theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-50 text-gray-600'}`}>
                <p className="font-medium mb-1">更新内容：</p>
                <p className="whitespace-pre-wrap">{updateInfo.releaseNotes}</p>
              </div>
            )}
            <button
              onClick={onClose}
              className={`px-4 py-2 rounded-lg text-sm transition-all ${theme === 'dark' ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
            >
              关闭
            </button>
          </div>
        );

      case 'confirm':
        return (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-900/50' : 'bg-indigo-100'}`}>
                <AlertCircle className={`w-6 h-6 ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`} />
              </div>
              <div>
                <h3 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                  发现新版本
                </h3>
                <p className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                  v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
                </p>
              </div>
            </div>

            {updateInfo.releaseNotes && (
              <div className={`mb-4 p-3 rounded-lg text-sm max-h-40 overflow-y-auto ${theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-50 text-gray-600'}`}>
                <p className="font-medium mb-1">更新内容：</p>
                <p className="whitespace-pre-wrap">{updateInfo.releaseNotes}</p>
              </div>
            )}

            {updateInfo.updateTime && (
              <p className={`text-xs mb-4 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                更新时间：{updateInfo.updateTime}
              </p>
            )}

            <p className={`text-sm mb-6 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              是否立即下载并安装更新？安装完成后将自动重启应用。
            </p>

            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${theme === 'dark' ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
              >
                稍后再说
              </button>
              <button
                onClick={handleConfirm}
                className={`px-4 py-2 rounded-lg text-sm transition-all flex items-center gap-2 ${theme === 'dark' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-indigo-500 text-white hover:bg-indigo-600'}`}
              >
                <Download className="w-4 h-4" />
                立即更新
              </button>
            </div>
          </>
        );

      case 'downloading':
        return (
          <div className="text-center py-4">
            <Loader className={`w-12 h-12 mx-auto mb-4 animate-spin ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              正在下载更新...
            </h3>
            <p className={`text-sm mb-4 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              v{updateInfo.latestVersion}
            </p>
            <div className={`w-full h-2 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-200'}`}>
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className={`text-xs mt-2 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
              {progress < 80 ? '正在下载安装包...' : '正在校验文件完整性...'}
            </p>
          </div>
        );

      case 'installing':
        return (
          <div className="text-center py-4">
            <HardDrive className={`w-12 h-12 mx-auto mb-4 animate-pulse ${theme === 'dark' ? 'text-amber-400' : 'text-amber-600'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              正在安装更新
            </h3>
            <p className={`text-sm mb-2 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              v{updateInfo.latestVersion}
            </p>
            <p className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              请在安装向导中完成安装，安装完成后将自动重启应用。
            </p>
          </div>
        );

      case 'success':
        return (
          <div className="text-center py-4">
            <CheckCircle className={`w-12 h-12 mx-auto mb-4 ${theme === 'dark' ? 'text-green-400' : 'text-green-600'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              安装完成
            </h3>
            <p className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              新版本即将启动，当前应用将自动关闭。
            </p>
          </div>
        );

      case 'error':
        return (
          <div className="text-center py-4">
            <AlertCircle className={`w-12 h-12 mx-auto mb-4 ${theme === 'dark' ? 'text-red-400' : 'text-red-600'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              更新失败
            </h3>
            <p className={`text-sm mb-4 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              {errorMsg}
            </p>
            <button
              onClick={onClose}
              className={`px-4 py-2 rounded-lg text-sm transition-all ${theme === 'dark' ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
            >
              关闭
            </button>
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className={`w-[440px] rounded-xl overflow-hidden shadow-2xl ${theme === 'dark' ? 'bg-gray-800' : 'bg-white'}`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <h2 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>应用更新</h2>
          {state === 'confirm' && (
            <button
              onClick={onClose}
              className={`p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="px-6 py-4">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

export default UpdateDialog;
