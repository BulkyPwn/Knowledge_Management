import React from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

// PPT 幻灯片预览弹窗
export default function PptPreviewModal({ theme, pptPreviewModal, setPptPreviewModal, movePptPreviewModal, svgToPreviewSrc }) {
  const preview = pptPreviewModal.previews[pptPreviewModal.index] || {};
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4"
      onClick={() => setPptPreviewModal(null)}
    >
      <div
        className={`relative w-[min(1200px,96vw)] max-h-[92vh] rounded-lg border shadow-2xl overflow-hidden ${theme === 'dark' ? 'bg-gray-950 border-gray-700' : 'bg-white border-gray-200'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${theme === 'dark' ? 'border-gray-800 text-gray-100' : 'border-gray-200 text-gray-900'}`}>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">
              第 {preview.page_num || pptPreviewModal.index + 1} 页 · {preview.title || preview.filename || '预览'}
            </div>
            <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-500' : 'text-gray-500'}`}>
              {pptPreviewModal.index + 1} / {pptPreviewModal.previews.length}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPptPreviewModal(null)}
            className={`p-2 rounded-md ${theme === 'dark' ? 'hover:bg-gray-800 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className={`relative p-4 ${theme === 'dark' ? 'bg-gray-950' : 'bg-gray-50'}`}>
          <div className="mx-auto aspect-video max-h-[76vh] w-full flex items-center justify-center overflow-hidden rounded-md">
            <img
              src={svgToPreviewSrc(preview.svg)}
              alt={`Slide ${preview.page_num || ''}`}
              className="h-full w-full object-contain"
            />
          </div>
          {pptPreviewModal.previews.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => movePptPreviewModal(-1)}
                className="absolute left-5 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
                title="上一页"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => movePptPreviewModal(1)}
                className="absolute right-5 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
                title="下一页"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
