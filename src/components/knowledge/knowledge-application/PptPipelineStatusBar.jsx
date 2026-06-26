import React from 'react';

// PPT 六步流水线状态面板（顶部横条）
export default function PptPipelineStatusBar({
  pipelineState,
  theme,
  pipelineDetailsOpen, setPipelineDetailsOpen,
  pipelineAbortRef,
  setPipelineState,
  openPptPreviewModal,
  svgToPreviewSrc,
}) {
  if (!pipelineState) return null;

  const steps = pipelineState.steps || [];
  const doneCount = steps.filter(s => s.status === 'done').length;
  const runningStep = steps.find(s => s.status === 'running')
    || steps.find(s => s.status === 'error')
    || steps.find(s => s.status !== 'done')
    || steps[steps.length - 1];
  const progressPct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;
  const latestLog = [...(pipelineState.logs || [])].reverse().find(l => l.message) || {};
  const slidePreviews = pipelineState.stepDetails?.[5]?.slide_previews || [];
  const barTheme = theme === 'dark'
    ? 'bg-gray-900/95 border-gray-700 text-gray-200'
    : theme === 'light'
      ? 'bg-white/95 border-gray-200 text-gray-800'
      : 'bg-gray-700/95 border-gray-500 text-gray-100';

  return (
    <div className={`shrink-0 border-b ${barTheme}`}>
      <div className="px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold ${pipelineState.error ? 'text-red-400' : pipelineState.running ? 'text-indigo-400' : 'text-green-500'}`}>
                PPT 六步流水线
              </span>
              <span className={`text-xs truncate ${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
                {pipelineState.error
                  ? `失败：${pipelineState.error}`
                  : pipelineState.running
                    ? `Step ${runningStep?.id || '-'} / ${steps.length || 6} · ${runningStep?.name || '处理中'}`
                    : `已完成 · ${doneCount}/${steps.length || 6}`}
              </span>
              {latestLog.message && (
                <span className={`hidden xl:inline text-xs truncate ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                  {latestLog.message}
                </span>
              )}
            </div>
            <div className={`mt-1 h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-200'}`}>
              <div
                className={`${pipelineState.error ? 'bg-red-500' : pipelineState.running ? 'bg-indigo-500' : 'bg-green-500'} h-full transition-all`}
                style={{ width: `${Math.max(progressPct, pipelineState.running ? 8 : 0)}%` }}
              />
            </div>
          </div>
          <button
            onClick={() => setPipelineDetailsOpen(v => !v)}
            className={`px-2 py-1 rounded text-xs ${theme === 'dark' ? 'bg-gray-800 hover:bg-gray-700 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
          >
            {pipelineDetailsOpen ? '收起' : '详情'}
          </button>
          {pipelineState.running && (
            <button
              onClick={() => { pipelineAbortRef.current?.abort(); setPipelineState(p => p ? { ...p, running: false } : p); }}
              className="px-2 py-1 rounded text-xs bg-red-500/85 text-white hover:bg-red-600"
            >
              取消
            </button>
          )}
        </div>

        {slidePreviews.length > 0 && (
          <div className="mt-2">
            <div className={`mb-1 text-[11px] ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
              实时预览：已完成 {slidePreviews.length}/{pipelineState.stepDetails?.[5]?.total_pages || slidePreviews.length} 页
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {slidePreviews.map((preview, index) => (
                <button
                  type="button"
                  key={preview.page_num || preview.filename}
                  onClick={() => openPptPreviewModal(slidePreviews, index)}
                  className={`w-32 shrink-0 rounded-md border overflow-hidden text-left transition-all hover:scale-[1.02] focus:outline-none focus:ring-2 ${theme === 'dark' ? 'border-gray-700 bg-gray-950 focus:ring-indigo-500' : 'border-gray-200 bg-white focus:ring-indigo-400'}`}
                  title={preview.filepath || preview.title || ''}
                >
                  <div className="aspect-video flex items-center justify-center overflow-hidden">
                    <img
                      src={svgToPreviewSrc(preview.svg)}
                      alt={`Slide ${preview.page_num || ''}`}
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className={`px-1.5 py-1 text-[10px] truncate ${theme === 'dark' ? 'text-gray-400 bg-gray-900' : 'text-gray-500 bg-gray-50'}`}>
                    {preview.page_num}. {preview.title || preview.filename}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {pipelineDetailsOpen && (
          <div className={`mt-2 rounded-lg border p-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-950/70' : 'border-gray-200 bg-gray-50'}`}>
            <div className="grid grid-cols-6 gap-2">
              {steps.map(s => (
                <div key={s.id} className={`rounded-md px-2 py-2 text-center ${s.status === 'done'
                  ? theme === 'dark' ? 'bg-green-900/25 text-green-300' : 'bg-green-50 text-green-700'
                  : s.status === 'running'
                    ? theme === 'dark' ? 'bg-indigo-900/30 text-indigo-300' : 'bg-indigo-50 text-indigo-700'
                    : s.status === 'error'
                      ? 'bg-red-500/15 text-red-400'
                      : theme === 'dark' ? 'bg-gray-800 text-gray-500' : 'bg-white text-gray-500'
                }`}>
                  <div className="text-xs font-semibold">Step {s.id}</div>
                  <div className="mt-0.5 text-[10px] truncate">{s.name}</div>
                </div>
              ))}
            </div>
            <div className={`mt-3 max-h-44 overflow-auto rounded-md p-2 text-xs space-y-1 ${theme === 'dark' ? 'bg-gray-900 text-gray-300' : 'bg-white text-gray-600'}`}>
              {(pipelineState.logs || []).slice(-500).map((log, idx) => (
                <div key={idx} className="truncate">
                  <span className={theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}>
                    {typeof log.step === 'number' ? `Step ${log.step}` : log.step || '-'} · {log.status || '-'}
                  </span>
                  {log.message ? `：${log.message}` : ''}
                </div>
              ))}
              {!(pipelineState.logs || []).length && <div>暂无详细日志</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
