import React from 'react';

// 图片选择弹窗：本地 PNG 或 URL
export default function ImagePickerModal({
  theme,
  imageUrl, setImageUrl,
  fileInputRef,
  onFileClick,
  onUrlAdd,
  onClose,
}) {
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${theme === 'dark' ? 'bg-black/50' : theme === 'light' ? 'bg-black/30' : 'bg-black/50'}`} onClick={onClose}>
      <div className={`relative p-6 rounded-xl max-w-md w-full mx-4 ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white shadow-xl' : 'bg-gray-600'}`} onClick={e => e.stopPropagation()}>
        <h3 className={`text-lg font-semibold mb-4 ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>请选择图片来源：</h3>

        <div className="space-y-3">
          <button
            onClick={() => {
              onFileClick();
            }}
            className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg transition-all ${
              theme === 'dark'
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                : theme === 'light'
                  ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            选择本地PNG图片
          </button>

          <div className="flex gap-2">
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="输入图片URL..."
              className={`flex-1 px-4 py-3 rounded-lg outline-none transition-all ${
                theme === 'dark'
                  ? 'bg-gray-600 text-white placeholder-gray-400'
                  : theme === 'light'
                    ? 'bg-gray-100 text-gray-900 placeholder-gray-400 border border-gray-200'
                    : 'bg-gray-500 text-white placeholder-gray-400'
              }`}
            />
            <button
              onClick={onUrlAdd}
              className={`px-4 py-3 rounded-lg transition-all ${
                theme === 'dark'
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : theme === 'light'
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              添加
            </button>
          </div>

          <button
            onClick={onClose}
            className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg transition-all ${
              theme === 'dark'
                ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                : theme === 'light'
                  ? 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                  : 'bg-gray-500 hover:bg-gray-400 text-gray-300'
            }`}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
