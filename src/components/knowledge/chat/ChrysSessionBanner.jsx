import React from 'react';

export default function ChrysSessionBanner({
  theme,
  chrysSessionId, setChrysSessionId,
  chrysCodeSessionId, setChrysCodeSessionId,
}) {
  return (
    <>
      {chrysSessionId && (
        <div className={`px-4 py-1.5 text-center text-[11px] ${theme === 'dark' ? 'bg-blue-900/30 text-blue-300 border-t border-blue-800/50' : 'bg-blue-50 text-blue-600 border-t border-blue-200'}`}>
          PPT 会话进行中 ({chrysSessionId.slice(0, 8)}...) — 继续输入以调整 PPT
          <button
            onClick={() => { setChrysSessionId(null); }}
            className="ml-2 underline hover:opacity-80"
          >
            开始新会话
          </button>
        </div>
      )}
      {chrysCodeSessionId && (
        <div className={`px-4 py-1.5 text-center text-[11px] ${theme === 'dark' ? 'bg-green-900/30 text-green-300 border-t border-green-800/50' : 'bg-green-50 text-green-600 border-t border-green-200'}`}>
          代码会话进行中 ({chrysCodeSessionId.slice(0, 8)}...) — 继续输入以调整代码
          <button
            onClick={() => { setChrysCodeSessionId(null); }}
            className="ml-2 underline hover:opacity-80"
          >
            开始新会话
          </button>
        </div>
      )}
    </>
  );
}
