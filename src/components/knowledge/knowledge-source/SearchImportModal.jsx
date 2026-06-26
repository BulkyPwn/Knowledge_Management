import React from 'react';
import { Search, Loader2 } from 'lucide-react';

// 搜索导入弹窗：搜索关键词，勾选结果，抓取网页内容入库
export default function SearchImportModal({
  theme,
  searchImportInputRef,
  searchImportQuery, setSearchImportQuery,
  searchImportLoading,
  searchImportResults,
  searchImportSelected,
  toggleSearchImportAll,
  toggleSearchImportItem,
  searchImportImporting,
  onSearch,
  onConfirm,
  onClose,
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]" onClick={() => { if (!searchImportImporting) onClose(); }}>
      <div
        className={`rounded-xl shadow-xl ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
        style={{ width: 'min(900px, 94vw)', height: 'min(700px, 88vh)', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>搜索导入</div>
          <div className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
            搜索关键词，勾选需要的结果，确认后抓取网页内容入库
          </div>
        </div>

        <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2">
            <input
              type="text"
              ref={searchImportInputRef}
              value={searchImportQuery}
              onChange={(e) => setSearchImportQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSearch(); }}
              placeholder="输入搜索关键词..."
              className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none ${
                theme === 'dark' ? 'bg-gray-700 text-white placeholder-gray-500 border border-gray-600 focus:border-indigo-400' :
                theme === 'light' ? 'bg-gray-50 text-gray-900 placeholder-gray-400 border border-gray-200 focus:border-indigo-500' :
                'bg-gray-600 text-white placeholder-gray-400 border border-gray-500 focus:border-indigo-400'
              }`}
              autoFocus
            />
            <button
              onClick={onSearch}
              disabled={searchImportLoading || !searchImportQuery.trim()}
              className={`px-4 py-2 rounded-lg text-sm text-white transition-all flex items-center gap-1.5 ${
                searchImportLoading || !searchImportQuery.trim()
                  ? 'bg-gray-500 cursor-not-allowed opacity-60'
                  : theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-500 hover:bg-indigo-600'
              }`}
            >
              {searchImportLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Search className="w-3.5 h-3.5" />
              )}
              搜索
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {searchImportLoading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 className={`w-8 h-8 animate-spin ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-500'}`} />
              <div className={`mt-3 text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>搜索中...</div>
            </div>
          ) : searchImportResults.length === 0 ? (
            <div className={`text-center py-16 text-sm ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
              {searchImportQuery ? '未找到相关结果' : '输入关键词开始搜索'}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-2">
                <label className={`flex items-center gap-2 text-xs cursor-pointer ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                  <input
                    type="checkbox"
                    checked={searchImportSelected.size === searchImportResults.length && searchImportResults.length > 0}
                    onChange={toggleSearchImportAll}
                    className="rounded"
                  />
                  全选（{searchImportSelected.size}/{searchImportResults.length}）
                </label>
              </div>
              {searchImportResults.map((item, idx) => (
                <div
                  key={idx}
                  onClick={() => toggleSearchImportItem(idx)}
                  className={`p-3 rounded-lg cursor-pointer transition-all border ${
                    searchImportSelected.has(idx)
                      ? theme === 'dark' ? 'bg-indigo-900/30 border-indigo-500' : 'bg-indigo-50 border-indigo-400'
                      : theme === 'dark' ? 'bg-gray-700/50 border-gray-600 hover:border-gray-500' : 'bg-gray-50 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={searchImportSelected.has(idx)}
                      onChange={() => toggleSearchImportItem(idx)}
                      className="mt-0.5 rounded"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium truncate ${theme === 'dark' ? 'text-gray-100' : 'text-gray-800'}`}>
                        {item.title || '无标题'}
                      </div>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className={`text-xs truncate mt-0.5 block hover:underline ${theme === 'dark' ? 'text-indigo-400 hover:text-indigo-300' : 'text-indigo-600 hover:text-indigo-500'}`}
                      >
                        {item.url}
                      </a>
                      {item.snippet && (
                        <div className={`text-xs mt-1 line-clamp-2 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                          {item.snippet}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`p-4 border-t flex justify-between items-center ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className={`text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
            {searchImportSelected.size > 0 ? `已选 ${searchImportSelected.size} 条` : ''}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={searchImportImporting}
              className={`px-4 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
            >
              取消
            </button>
            <button
              onClick={onConfirm}
              disabled={searchImportSelected.size === 0 || searchImportImporting}
              className={`px-4 py-2 rounded-lg text-sm text-white flex items-center gap-1.5 ${
                searchImportSelected.size === 0 || searchImportImporting
                  ? 'bg-gray-500 cursor-not-allowed opacity-60'
                  : theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-500 hover:bg-indigo-600'
              }`}
            >
              {searchImportImporting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {searchImportImporting ? '导入中...' : '确认导入'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
