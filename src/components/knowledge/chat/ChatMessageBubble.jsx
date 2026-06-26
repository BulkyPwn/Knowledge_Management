import React from 'react';
import { Bot } from 'lucide-react';
import { renderMarkdown } from '../shared/renderMarkdown';

export default function ChatMessageBubble({ msg, idx, theme, renderMode, projectPath }) {
  return (
    <div key={idx} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex items-start gap-3 ${msg.type === 'user' ? 'max-w-[60%]' : 'max-w-[70%]'}`}>
        {msg.type === 'assistant' && (
          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${theme === 'dark' ? 'bg-indigo-600' : theme === 'light' ? 'bg-indigo-500' : 'bg-indigo-600'}`}>
            <Bot className="w-4 h-4 text-white" />
          </div>
        )}
        <div className={`min-w-0 px-4 py-3 break-words ${msg.type === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
          {msg.type === 'assistant' && renderMode === 'markdown' ? (
            <div
              className={`markdown-body text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
            />
          ) : (
            <p className={`text-sm ${msg.type === 'user' ? 'text-white' : theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
              {msg.content}
            </p>
          )}
          {msg.type === 'assistant' && (
            <>
              {msg.platformsUsed && msg.platformsUsed.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {msg.platformsUsed.map((p, i) => (
                    <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${
                      p === 'local' ? (theme === 'dark' ? 'bg-indigo-900/50 text-indigo-300' : 'bg-indigo-100 text-indigo-700') :
                      p === 'web' ? (theme === 'dark' ? 'bg-green-900/50 text-green-300' : 'bg-green-100 text-green-700') :
                      p === 'hiDesk' ? (theme === 'dark' ? 'bg-orange-900/50 text-orange-300' : 'bg-orange-100 text-orange-700') :
                      (theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600')
                    }`}>
                      {p === 'local' ? '本地知识库' : p === 'web' ? '联网搜索' : p === 'hiDesk' ? 'HiDesk' : p === 'haiwen' ? '海问思答' : p}
                    </span>
                  ))}
                </div>
              )}
              {msg.sources && msg.sources.length > 0 && (
                <details className="mt-2">
                  <summary className={`text-xs cursor-pointer font-medium ${theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : theme === 'light' ? 'text-gray-500 hover:text-gray-700' : 'text-gray-400 hover:text-gray-300'}`}>
                    参考来源 ({msg.sources.length})
                  </summary>
                  <ul className="mt-1 ml-2 text-xs space-y-1 list-none">
                    {msg.sources.slice(0, 20).map((src, i) => {
                      const isString = typeof src === 'string';
                      const sourceObj = isString
                        ? { index: i + 1, platform: 'local', title: src, url: '' }
                        : src;
                      const isHttp = sourceObj.url && sourceObj.url.startsWith('http');
                      const displayTitle = sourceObj.title || sourceObj.url || '(无标题)';
                      return (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className={`flex-shrink-0 w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold ${
                          sourceObj.platform === 'local' ? 'bg-indigo-500/20 text-indigo-400' :
                          sourceObj.platform === 'web' ? 'bg-green-500/20 text-green-400' :
                          'bg-gray-500/20 text-gray-400'
                        }`}>
                          {sourceObj.index}
                        </span>
                        {isHttp ? (
                          <a
                            href={sourceObj.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`truncate hover:underline ${theme === 'dark' ? 'text-green-400' : 'text-green-600'}`}
                            title={sourceObj.url}
                          >
                            {displayTitle}
                          </a>
                        ) : (
                          <button
                            className={`truncate text-left hover:underline cursor-pointer bg-transparent border-none p-0 ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`}
                            title={displayTitle}
                            onClick={async () => {
                              if (!sourceObj._fullPath) return;
                              const { ipcRenderer } = window.require('electron');
                              await ipcRenderer.invoke('open-file-path', sourceObj._fullPath);
                            }}
                          >
                            {displayTitle}
                          </button>
                        )}
                      </li>
                      );
                    })}
                    {msg.sources.length > 20 && (
                      <li className={`text-[11px] ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                        ... 还有 {msg.sources.length - 20} 条来源
                      </li>
                    )}
                  </ul>
                </details>
              )}
              {msg.citedPages && msg.citedPages.length > 0 && !msg.sources && (
                <div className="mt-3 pt-3 border-t border-gray-300 dark:border-gray-600">
                  <span className={`text-xs font-semibold ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                    参考文献:
                  </span>
                  <ul className="mt-1 ml-4 text-xs space-y-0.5 list-none">
                    {msg.citedPages.map((cp) => (
                      <li key={cp.index}>
                        <button
                          className={`hover:underline text-left ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`}
                          onClick={async () => {
                            if (!cp._fullPath) return;
                            const { ipcRenderer } = window.require('electron');
                            await ipcRenderer.invoke('open-file-path', cp._fullPath);
                          }}
                          title={cp.title || cp.path}
                        >
                          [{cp.index}] {cp.title || cp.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
