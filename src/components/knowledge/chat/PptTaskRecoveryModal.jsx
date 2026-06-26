import React from 'react';
import { X, Loader2 } from 'lucide-react';

// PPT 任务恢复弹窗
export default function PptTaskRecoveryModal({
  theme,
  pptTasks, pptTasksLoading,
  pipelineRunning,
  onResume,
  onClose,
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className={`w-[720px] max-w-[94vw] max-h-[82vh] rounded-xl shadow-2xl overflow-hidden flex flex-col ${theme === 'dark' ? 'bg-gray-800 text-gray-100' : theme === 'light' ? 'bg-white text-gray-900' : 'bg-gray-700 text-gray-100'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`px-5 py-4 border-b flex items-center justify-between ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <div>
            <h3 className="text-base font-semibold">继续上次 PPT 任务</h3>
            <p className={`text-xs mt-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>仅支持已生成结构大纲的任务从渲染阶段继续。</p>
          </div>
          <button onClick={onClose} className={`p-2 rounded-lg ${theme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 overflow-auto space-y-3">
          {pptTasksLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              正在加载任务...
            </div>
          ) : pptTasks.length === 0 ? (
            <div className={`py-8 text-center text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>没有找到历史 PPT 任务。</div>
          ) : (
            pptTasks.map((task, idx) => (
              <div key={`${task.task_dir}-${idx}`} className={`rounded-lg border p-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-900/60' : 'border-gray-200 bg-gray-50'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        task.resumable
                          ? task.status === 'completed'
                            ? theme === 'dark' ? 'bg-blue-900/50 text-blue-300' : 'bg-blue-100 text-blue-700'
                            : theme === 'dark' ? 'bg-green-900/50 text-green-300' : 'bg-green-100 text-green-700'
                          : theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'
                      }`}>
                        {task.resumable ? (task.status === 'completed' ? '已完成 · 可重新生成' : `可继续 · ${task.resume_from || 'outline'}`) : '不可继续'}
                      </span>
                      <span className={`text-xs ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>{task.updated_at ? task.updated_at.replace('T', ' ').slice(0, 19) : ''}</span>
                    </div>
                    <div className="mt-2 text-sm font-medium truncate">{task.query || task.name || task.pipeline_id || '未命名任务'}</div>
                    <div className={`mt-1 text-xs truncate ${theme === 'dark' ? 'text-gray-500' : 'text-gray-500'}`} title={task.task_dir}>{task.task_dir}</div>
                  </div>
                  <button
                    disabled={!task.resumable || pipelineRunning}
                    onClick={() => onResume(task)}
                    className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${
                      task.resumable && !pipelineRunning
                        ? theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        : theme === 'dark' ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {task.status === 'completed' ? '重新生成' : '继续'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
