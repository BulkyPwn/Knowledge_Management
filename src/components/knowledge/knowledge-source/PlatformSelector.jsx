import React from 'react';
import { Globe } from 'lucide-react';

export default function PlatformSelector({
  theme,
  platforms, handlePlatformChange,
  webSearchChecking, webSearchAvailable, searchEngine,
}) {
  return (
    <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
      <div className="flex flex-wrap gap-2">
        <label className={`flex-shrink-0 text-sm ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>知识源：</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={platforms.local}
              onChange={() => handlePlatformChange('local')}
              className="w-4 h-4 rounded accent-indigo-500"
            />
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>本地知识</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={platforms.hiDesk}
              onChange={() => handlePlatformChange('hiDesk')}
              className="w-4 h-4 rounded accent-indigo-500"
            />
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>HiDesk</span>
          </label>
          <label className="flex items-center gap-2" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            <input type="checkbox" checked={false} disabled={true} className="w-4 h-4 rounded" />
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>海问思答</span>
          </label>
          <label className={`flex items-center gap-2 ${webSearchChecking ? 'cursor-wait opacity-70' : webSearchAvailable === false ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={platforms.webSearch}
              onChange={() => handlePlatformChange('webSearch')}
              disabled={webSearchAvailable === false || webSearchChecking}
              className="w-4 h-4 rounded accent-green-500"
            />
            <Globe className={`w-4 h-4 ${platforms.webSearch ? (theme === 'dark' ? 'text-green-400' : 'text-green-500') : (theme === 'dark' ? 'text-gray-400' : 'text-gray-500')}`} />
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>联网搜索</span>
            {webSearchChecking && <span className={`text-xs ${theme === 'dark' ? 'text-yellow-400' : 'text-yellow-600'}`}>检测中...</span>}
            {platforms.webSearch && !webSearchChecking && (
              <span className={`text-xs ${theme === 'dark' ? 'text-green-400' : 'text-green-500'}`}>
                {searchEngine === 'bing' ? 'Bing' : searchEngine === 'searxng' ? 'SearXNG' : 'DuckDuckGo'}
              </span>
            )}
            {webSearchAvailable === false && !webSearchChecking && <span className={`text-xs ${theme === 'dark' ? 'text-red-400' : 'text-red-500'}`}>不可用</span>}
          </label>
        </div>
      </div>
    </div>
  );
}
