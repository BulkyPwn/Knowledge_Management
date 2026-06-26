import React from 'react';
import { Check, RefreshCw } from 'lucide-react';

export default function HiDeskPanel({
  theme,
  refreshHiDeskConnection, hiDeskRefreshing, hiDeskTestResult,
  hiDeskConfigured,
  hiDeskDomains, hiDeskSelectedDomain, handleHiDeskDomainChange,
  hiDeskDatasets, hiDeskSelectedDataset, setHiDeskSelectedDataset,
  hiDeskViews, hiDeskSelectedView, handleHiDeskViewChange,
}) {
  return (
    <>
      <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
        <div className="flex items-center justify-between mb-1">
          <label className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>HiDesk 服务器</label>
          <div className="flex items-center gap-2">
            <button
              onClick={refreshHiDeskConnection}
              disabled={hiDeskRefreshing}
              className={`flex items-center gap-1 px-3 py-1 text-xs rounded-lg transition-all ${
                hiDeskRefreshing
                  ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                  : theme === 'dark'
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : theme === 'light'
                      ? 'bg-green-500 hover:bg-green-600 text-white'
                      : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
            >
              {hiDeskRefreshing ? (
                <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              刷新连接
            </button>
          </div>
        </div>
        {hiDeskTestResult && (
          <div className={`text-xs px-2 py-1 rounded mt-2 ${
            hiDeskTestResult.success
              ? (theme === 'dark' ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700')
              : (theme === 'dark' ? 'bg-red-900/30 text-red-400' : 'bg-red-100 text-red-700')
          }`}>
            {hiDeskTestResult.success ? (
              <span className="flex items-center gap-1"><Check className="w-3 h-3" />{hiDeskTestResult.message}</span>
            ) : (
              <span>{hiDeskTestResult.message}</span>
            )}
          </div>
        )}
      </div>

      <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
        <label className={`block text-sm mb-2 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>领域：</label>
        {Array.isArray(hiDeskDomains) && hiDeskDomains.length > 0 ? (
          <select
            value={hiDeskSelectedDomain}
            onChange={(e) => handleHiDeskDomainChange(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg outline-none text-sm transition-all ${
              theme === 'dark'
                ? 'bg-gray-600 text-white hover:bg-gray-500'
                : theme === 'light'
                  ? 'bg-gray-50 text-gray-900 border border-gray-200 hover:bg-gray-100'
                  : 'bg-gray-400 text-white hover:bg-gray-300'
            }`}
          >
            <option value="">请选择领域</option>
            {hiDeskDomains.map(d => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        ) : (
          <p className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
            {hiDeskConfigured ? '未拉取到领域信息' : '请先点击"刷新连接"'}
          </p>
        )}
      </div>

      <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
        <label className={`block text-sm mb-2 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>数据集：</label>
        {Array.isArray(hiDeskDatasets) && hiDeskDatasets.length > 0 ? (
          <select
            value={hiDeskSelectedDataset}
            onChange={(e) => setHiDeskSelectedDataset(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg outline-none text-sm transition-all ${
              theme === 'dark'
                ? 'bg-gray-600 text-white hover:bg-gray-500'
                : theme === 'light'
                  ? 'bg-gray-50 text-gray-900 border border-gray-200 hover:bg-gray-100'
                  : 'bg-gray-400 text-white hover:bg-gray-300'
            }`}
          >
            <option value="">全部数据集</option>
            {hiDeskDatasets.map((ds, idx) => (
              <option key={ds.key || idx} value={ds.key || ds.name || ds.id}>
                {typeof ds === 'string' ? ds : (ds.text || ds.name || ds.label || ds.key || ds.id)}
              </option>
            ))}
          </select>
        ) : (
          <p className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
            {hiDeskConfigured ? '未拉取到数据集信息' : '请先点击"刷新连接"'}
          </p>
        )}
      </div>

      <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
        <label className={`block text-sm mb-2 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>知识库：</label>
        {Array.isArray(hiDeskViews) && hiDeskViews.length > 0 ? (
          <select
            value={hiDeskSelectedView}
            onChange={(e) => handleHiDeskViewChange(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg outline-none text-sm transition-all ${
              theme === 'dark'
                ? 'bg-gray-600 text-white hover:bg-gray-500'
                : theme === 'light'
                  ? 'bg-gray-50 text-gray-900 border border-gray-200 hover:bg-gray-100'
                  : 'bg-gray-400 text-white hover:bg-gray-300'
            }`}
          >
            <option value="">请选择知识库</option>
            {hiDeskViews.map((v, idx) => (
              <option key={v.key || idx} value={v.key || v.name || v.id}>
                {v.text || v.name || v.label || v.key || v.id}{v.kb_sn ? ` (${v.kb_sn})` : ''}
              </option>
            ))}
          </select>
        ) : (
          <p className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
            {hiDeskConfigured && hiDeskSelectedDomain ? '该领域下未拉取到视图信息' : hiDeskConfigured ? '请先选择领域' : '请先点击"刷新连接"'}
          </p>
        )}
      </div>
    </>
  );
}
