import React, { useState, useEffect, useCallback } from 'react';
import { Activity, ChevronDown, ChevronUp, FileText, Clock, CheckCircle, XCircle, Loader, Minimize2, Maximize2, Trash2 } from 'lucide-react';

function IngestMonitor({ projectPath, theme }) {
  const [data, setData] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const hasActiveProject = projectPath && projectPath.trim() !== '';

  const fetchStatus = useCallback(async () => {
    if (!hasActiveProject) return;
    try {
      const resp = await fetch(
        `http://127.0.0.1:5002/api/v1/projects/ingest-status?project_path=${encodeURIComponent(projectPath)}`
      );
      if (resp.ok) {
        const result = await resp.json();
        if (result.success) {
          setData(result.data);
        }
      }
    } catch (_) {}
  }, [projectPath, hasActiveProject]);

  useEffect(() => {
    let active = true;
    let timer = null;

    const poll = async () => {
      if (!active) return;
      await fetchStatus();
      if (!active) return;
      timer = setTimeout(poll, 2000);
    };

    // immediate first fetch
    poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [fetchStatus, hasActiveProject]);

  const summary = data?.summary || {};
  const deleteSummary = data?.delete_summary || {};

  const hasIngestActivity = summary.total > 0;
  const isIngestProcessing = summary.processing > 0;
  const hasIngestPending = summary.pending > 0;
  const hasIngestFailed = summary.failed > 0;

  const hasDeleteActivity = deleteSummary.total > 0;
  const isDeleteProcessing = deleteSummary.processing > 0;
  const hasDeletePending = deleteSummary.pending > 0;
  const hasDeleteFailed = deleteSummary.failed > 0;

  const isAnyProcessing = isIngestProcessing || isDeleteProcessing;

  if (!hasActiveProject) return null;

  const containerClass = `rounded-xl border transition-all ${
    theme === 'dark'
      ? 'bg-gray-700/50 border-gray-600'
      : theme === 'light'
        ? 'bg-white border-gray-200 shadow-sm'
        : 'bg-gray-500/50 border-gray-400'
  }`;

  const textMuted = theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300';
  const textPrimary = theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200';
  const bgHighlight = theme === 'dark' ? 'bg-gray-600/50' : theme === 'light' ? 'bg-gray-100' : 'bg-gray-500/50';

  const minimizedLabel = () => {
    const parts = [];
    if (isIngestProcessing) parts.push(`摄入 ${summary.processing}`);
    else if (hasIngestPending) parts.push(`摄入待 ${summary.pending}`);
    if (isDeleteProcessing) parts.push(`删除 ${deleteSummary.processing}`);
    else if (hasDeletePending) parts.push(`删除待 ${deleteSummary.pending}`);
    if (parts.length > 0) return parts.join(' / ');
    if (hasIngestFailed) return `摄入失败 ${summary.failed}`;
    if (hasDeleteFailed) return `删除失败 ${deleteSummary.failed}`;
    return '就绪';
  };

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-medium transition-all ${
          theme === 'dark'
            ? 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700'
            : theme === 'light'
              ? 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              : 'bg-gray-600 border-gray-500 text-gray-200 hover:bg-gray-500'
        } ${isAnyProcessing ? 'border-indigo-500 ring-1 ring-indigo-500' : ''}`}
        title="展开监控日志"
      >
        <Activity className={`w-3.5 h-3.5 ${isAnyProcessing ? 'text-indigo-400 animate-pulse' : textMuted}`} />
        <span>{minimizedLabel()}</span>
        <Maximize2 className={`w-3 h-3 ${textMuted}`} />
      </button>
    );
  }

  const StatusBadge = ({ status }) => {
    const labelMap = { processing: '处理中', pending: '等待', failed: '失败', done: '完成' };
    const colorMap = {
      processing: 'bg-indigo-500/20 text-indigo-400',
      pending: 'bg-yellow-500/20 text-yellow-400',
      failed: 'bg-red-500/20 text-red-400',
      done: 'bg-green-500/20 text-green-400',
    };
    return (
      <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded ${colorMap[status] || 'bg-gray-500/20 text-gray-400'}`}>
        {labelMap[status] || status}
      </span>
    );
  };

  const StatusIcon = ({ status, className }) => {
    const cls = `w-3 h-3 flex-shrink-0 ${className || ''}`;
    if (status === 'processing') return <Loader className={`${cls} text-indigo-400 animate-spin`} />;
    if (status === 'pending') return <Clock className={`${cls} text-yellow-400`} />;
    if (status === 'failed') return <XCircle className={`${cls} text-red-400`} />;
    return <CheckCircle className={`${cls} text-green-400`} />;
  };

  const TaskRow = ({ task }) => (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${bgHighlight}`}>
      <StatusIcon status={task.status} />
      <span className={`truncate flex-1 ${textPrimary}`}>
        {task.sourcePath || task.filePath || task.path || task.id || task.source}
      </span>
      <StatusBadge status={task.status} />
      {task.error && (
        <span className="text-xs text-red-400 truncate max-w-[120px]" title={task.error}>
          {task.error}
        </span>
      )}
    </div>
  );

  // ── summary chip for one side ──
  const SummaryChips = ({ processing, pending, failed, done, total, colorClass, idleLabel }) => (
    <div className="flex items-center gap-2 flex-wrap">
      {processing > 0 && (
        <div className="flex items-center gap-1">
          <Loader className={`w-3 h-3 ${colorClass} animate-spin`} />
          <span className={`text-xs ${colorClass} font-medium`}>{processing} 处理中</span>
        </div>
      )}
      {pending > 0 && (
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3 text-yellow-400" />
          <span className="text-xs text-yellow-400 font-medium">{pending} 等待</span>
        </div>
      )}
      {failed > 0 && (
        <div className="flex items-center gap-1">
          <XCircle className="w-3 h-3 text-red-400" />
          <span className="text-xs text-red-400 font-medium">{failed} 失败</span>
        </div>
      )}
      {done > 0 && (
        <div className="flex items-center gap-1">
          <CheckCircle className="w-3 h-3 text-green-400" />
          <span className="text-xs text-green-400 font-medium">{done} 完成</span>
        </div>
      )}
      {total === 0 && <span className={`text-xs ${textMuted}`}>{idleLabel}</span>}
    </div>
  );

  // ── single progress bar (matches TaskPanel / UpdateDialog style) ──
  const ProgressBar = ({ total, done, isProcessing, hasFailed, fillClass }) => {
    if (total <= 0) return null;
    const w = Math.max(2, ((done || 0) / total) * 100);
    const colorClass = isProcessing ? fillClass : hasFailed ? 'bg-red-500' : 'bg-green-500';
    return (
      <div className={`w-full h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-200' : 'bg-gray-600'}`}>
        <div
          className={`h-full rounded-full transition-all duration-500 ${colorClass}`}
          style={{ width: `${w}%` }}
        />
      </div>
    );
  };

  return (
    <div className={`${containerClass} p-4`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Activity className={`w-4 h-4 ${isAnyProcessing ? 'text-indigo-400 animate-pulse' : textMuted}`} />
          <span className={`text-sm font-medium ${textPrimary}`}>状态监控</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`p-1 rounded transition-colors ${
              theme === 'dark' ? 'hover:bg-gray-600 text-gray-400' : theme === 'light' ? 'hover:bg-gray-200 text-gray-500' : 'hover:bg-gray-400 text-gray-300'
            }`}
            title={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <button
            onClick={() => setMinimized(true)}
            className={`p-1 rounded transition-colors ${
              theme === 'dark' ? 'hover:bg-gray-600 text-gray-400' : theme === 'light' ? 'hover:bg-gray-200 text-gray-500' : 'hover:bg-gray-400 text-gray-300'
            }`}
            title="缩放到左下角"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Two-column summary always visible */}
      <div className="grid grid-cols-2 gap-3 mb-2">
        {/* Ingest */}
        <div className={`p-2 rounded-lg ${theme === 'dark' ? 'bg-gray-600/30' : theme === 'light' ? 'bg-gray-100' : 'bg-gray-500/30'}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <FileText className="w-3.5 h-3.5 text-indigo-400" />
            <span className={`text-xs font-medium ${textPrimary}`}>摄入</span>
          </div>
          <SummaryChips
            processing={summary.processing} pending={summary.pending} failed={summary.failed}
            done={summary.done} total={summary.total} colorClass="text-indigo-400" idleLabel="无任务"
          />
          <div className="mt-1">
            <ProgressBar total={summary.total} done={summary.done} isProcessing={isIngestProcessing} hasFailed={hasIngestFailed} fillClass="bg-indigo-500" />
          </div>
        </div>

        {/* Delete */}
        <div className={`p-2 rounded-lg ${theme === 'dark' ? 'bg-gray-600/30' : theme === 'light' ? 'bg-gray-100' : 'bg-gray-500/30'}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
            <span className={`text-xs font-medium ${textPrimary}`}>删除</span>
          </div>
          <SummaryChips
            processing={deleteSummary.processing} pending={deleteSummary.pending} failed={deleteSummary.failed}
            done={deleteSummary.done} total={deleteSummary.total} colorClass="text-orange-400" idleLabel="无任务"
          />
          <div className="mt-1">
            <ProgressBar total={deleteSummary.total} done={deleteSummary.done} isProcessing={isDeleteProcessing} hasFailed={hasDeleteFailed} fillClass="bg-orange-500" />
          </div>
        </div>
      </div>

      {/* Collapsible detail — dual queue columns, single combined log */}
      {!collapsed && (
        <div className={`space-y-3 mt-2 pt-2 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
          {/* Ingest + Delete queue side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              {data?.queue && data.queue.length > 0 ? (
                <div>
                  <span className={`text-xs font-medium ${textMuted}`}>队列任务</span>
                  <div className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                    {data.queue.map((task) => <TaskRow key={task.id} task={task} />)}
                  </div>
                </div>
              ) : (
                <div className={`text-center py-2 ${textMuted}`}>
                  <FileText className="w-4 h-4 mx-auto mb-0.5 opacity-50" />
                  <p className="text-xs">暂无摄入任务</p>
                </div>
              )}
            </div>
            <div>
              {data?.delete_queue && data.delete_queue.length > 0 ? (
                <div>
                  <span className={`text-xs font-medium ${textMuted}`}>删除任务</span>
                  <div className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                    {data.delete_queue.map((task, idx) => <TaskRow key={task.id || idx} task={task} />)}
                  </div>
                </div>
              ) : (
                <div className={`text-center py-2 ${textMuted}`}>
                  <Trash2 className="w-4 h-4 mx-auto mb-0.5 opacity-50" />
                  <p className="text-xs">暂无删除任务</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default IngestMonitor;
