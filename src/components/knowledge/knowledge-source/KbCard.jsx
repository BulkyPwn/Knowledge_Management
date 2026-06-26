import React from 'react';
import { Database, FileText, Globe, RefreshCw, CheckCircle } from 'lucide-react';

export default function KbCard({
  kb, theme, isCommonKb, isSelected, activeKBKey,
  kbMetadata, kbStats, getKbKey, getKBStatus, openKBSettings, selectKnowledgeBase, kbListLoading,
  handleRescanKb,
  kbRescanProgress,
  kbIngestStatus,
}) {
  const kbId = kb.id || kb.knowledge_base_id;
  const kbKey = getKbKey(kb);
  const kbMeta = kbMetadata || {};
  const meta = kbMeta[kbId] || {};
  const kbName = meta.name || kb.name || kbId;
  const kbDesc = meta.description || kb.description || '';
  const stats = kbStats[kbId] || { documents: 0, web: 0, total: 0, processing: 0, wikiPages: 0 };
  const kbStatus = getKBStatus(kbId);
  const isActive = activeKBKey && kbKey === activeKBKey;
  const rescanProg = (kbRescanProgress || {})[kbId];
  const ingest = (kbIngestStatus || {})[kbId] || {};

  // 推导各状态的进度
  const ingestActive = ingest.ingestProcessing || ingest.ingestPending;
  const deleteActive = ingest.deleteProcessing || ingest.deletePending;
  // ingest-queue 中的 done 项会被移除，所以 done 永远为 0；
  // total 就是剩余工作量（递减），没有起始值无法算百分比
  const ingestRemaining = ingest.ingestTotal || 0;
  const deleteRemaining = ingest.deleteTotal || 0;
  const indexingDone = stats.wikiPages || 0;
  const indexingTotal = stats.total || 0;
  const indexingPct = indexingTotal > 0 ? Math.round((indexingDone / indexingTotal) * 100) : 0;

  return (
    <div
      key={kbKey}
      onClick={() => selectKnowledgeBase(kb)}
      className={`relative group cursor-pointer p-4 rounded-xl border-2 transition-all ${
        isSelected
          ? (theme === 'dark' ? 'border-indigo-500 bg-indigo-500/10' : theme === 'light' ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-500 bg-indigo-500/10')
          : (theme === 'dark' ? 'border-gray-600 hover:border-gray-500 bg-gray-600/30' : theme === 'light' ? 'border-gray-200 hover:border-gray-300 bg-gray-50' : 'border-gray-500 hover:border-gray-400 bg-gray-500/30')
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center relative ${
          isSelected
            ? (theme === 'dark' ? 'bg-indigo-500/20 text-indigo-400' : theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400')
            : (theme === 'dark' ? 'bg-gray-500/50 text-gray-400' : theme === 'light' ? 'bg-gray-200 text-gray-500' : 'bg-gray-500/50 text-gray-400')
        }`}>
          <Database className="w-5 h-5" />
          <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ${
            kbStatus.color === 'gray' ? 'bg-gray-400' : kbStatus.color === 'yellow' ? 'bg-yellow-400 animate-pulse' : kbStatus.color === 'blue' ? 'bg-blue-400 animate-pulse' : kbStatus.color === 'orange' ? 'bg-orange-400 animate-pulse' : kbStatus.color === 'red' ? 'bg-red-500' : 'bg-green-500'
          }`} title={kbStatus.label}></span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className={`text-sm font-medium truncate ${
              theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'
            }`}>
              {kbName}
            </h4>
            {isActive && (
              <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 text-green-400" title="当前活跃知识库" />
            )}
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              kbStatus.color === 'gray' 
                ? (theme === 'dark' ? 'bg-gray-600 text-gray-400' : 'bg-gray-200 text-gray-500')
                : kbStatus.color === 'yellow'
                  ? (theme === 'dark' ? 'bg-yellow-900/50 text-yellow-400' : 'bg-yellow-100 text-yellow-600')
                  : kbStatus.color === 'blue'
                    ? (theme === 'dark' ? 'bg-blue-900/50 text-blue-400' : 'bg-blue-100 text-blue-600')
                    : kbStatus.color === 'orange'
                      ? (theme === 'dark' ? 'bg-orange-900/50 text-orange-400' : 'bg-orange-100 text-orange-600')
                      : kbStatus.color === 'red'
                        ? (theme === 'dark' ? 'bg-red-900/50 text-red-400' : 'bg-red-100 text-red-600')
                        : (theme === 'dark' ? 'bg-green-900/50 text-green-400' : 'bg-green-100 text-green-600')
            }`}>
              {kbStatus.label}
            </span>
          </div>
          {kbDesc && (
            <p className={`text-xs mt-1 line-clamp-1 ${
              theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'
            }`}>
              {kbDesc}
            </p>
          )}
          <div className="flex items-center gap-3 mt-2">
            <span className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              <FileText className="w-3 h-3 inline mr-1" />
              {stats.documents || 0}
            </span>
            <span className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
              <Globe className="w-3 h-3 inline mr-1" />
              {stats.web || 0}
            </span>
          </div>

          {/* 各状态进度条（rescan 优先，其次导入/删除/索引中） */}
          {/* rescan: 显示队列中变更任务的处理进度 (queue.tasks 仅含变更文件) */}
          <ProgressBar
            theme={theme}
            color="blue"
            label="处理中"
            done={rescanProg?.done}
            total={rescanProg?.total}
            pct={rescanProg?.pct}
            subLabel={rescanProg?.total > 0 ? `${rescanProg?.processing || 0} active` : '扫描文件系统'}
            show={rescanProg?.status === 'running'}
          />
          <ProgressBar
            theme={theme}
            color="yellow"
            label="导入中"
            done={0}
            total={ingestRemaining}
            pct={0}
            subLabel={ingestRemaining > 0 ? `剩余 ${ingestRemaining} 个` : ''}
            show={!rescanProg && ingestActive && ingestRemaining > 0}
            indeterminate
          />
          <ProgressBar
            theme={theme}
            color="orange"
            label="删除中"
            done={0}
            total={deleteRemaining}
            pct={0}
            subLabel={deleteRemaining > 0 ? `剩余 ${deleteRemaining} 个` : ''}
            show={!rescanProg && deleteActive && deleteRemaining > 0}
            indeterminate
          />
          {/* 后端 KMA 索引进度：已生成 wiki 页数 / 总文件数 */}
          <ProgressBar
            theme={theme}
            color="yellow"
            label="索引中"
            done={indexingDone}
            total={indexingTotal}
            pct={indexingPct}
            subLabel={indexingTotal > 0 ? `已索引 ${indexingDone} / ${indexingTotal} 个文件` : ''}
            show={!rescanProg && !ingestActive && !deleteActive && kbStatus.status === 'processing' && indexingTotal > 0}
          />
          {/* rescan 完成/失败 */}
          {rescanProg?.status === 'done' && (
            <div className={`mt-2 flex items-center gap-1 text-xs ${theme === 'dark' ? 'text-green-400' : 'text-green-600'}`}>
              <span>&#x2705;</span>
              <span>扫描完成{rescanProg.total > 0 ? ` (${rescanProg.total}个文件)` : ''}</span>
            </div>
          )}
          {rescanProg?.status === 'error' && (
            <div className={`mt-2 flex items-center gap-1 text-xs ${theme === 'dark' ? 'text-red-400' : 'text-red-500'}`}>
              <span>&#x26A0;&#xFE0F;</span>
              <span className="truncate">扫描失败: {rescanProg.error || '未知错误'}</span>
            </div>
          )}
        </div>
      </div>
      
      <div className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
        {handleRescanKb && (
          <button
            onClick={(e) => { e.stopPropagation(); handleRescanKb(kb); }}
            className={`p-1.5 rounded-lg ${
              theme === 'dark' ? 'bg-gray-600 hover:bg-blue-600 text-gray-400 hover:text-white' : theme === 'light' ? 'bg-gray-200 hover:bg-blue-100 text-gray-500 hover:text-blue-600' : 'bg-gray-500 hover:bg-blue-500 text-gray-400 hover:text-white'
            }`}
            title="重新扫描"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); openKBSettings(kb); }}
          className={`p-1.5 rounded-lg ${
            theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500 text-gray-400 hover:text-white' : theme === 'light' ? 'bg-gray-200 hover:bg-gray-300 text-gray-500 hover:text-gray-700' : 'bg-gray-500 hover:bg-gray-400 text-gray-400 hover:text-white'
          }`}
          title="设置"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
        </button>
      </div>
    </div>
  );
}

// 通用进度条子组件
// indeterminate=true: 无确定进度，显示 label + subLabel，进度条全宽滑动动画
function ProgressBar({ theme, color, label, done, total, pct, show, subLabel, indeterminate }) {
  if (!show) return null;

  const colorClasses = {
    blue:   { bg: 'bg-blue-500', text: theme === 'dark' ? 'text-blue-400' : 'text-blue-600' },
    yellow: { bg: 'bg-yellow-500', text: theme === 'dark' ? 'text-yellow-400' : 'text-yellow-600' },
    orange: { bg: 'bg-orange-500', text: theme === 'dark' ? 'text-orange-400' : 'text-orange-600' },
  };
  const c = colorClasses[color] || colorClasses.blue;

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={`w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0 ${c.text}`} />
        <span className={`text-xs truncate ${c.text}`}>
          {label}
        </span>
        {!indeterminate && total > 0 && (
          <span className={`text-xs ml-auto flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
            <span className="tabular-nums">{(done ?? 0)}/{(total ?? 0)}</span>
          </span>
        )}
      </div>
      {subLabel && (
        <div className={`text-[10px] mb-1 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
          {subLabel}
        </div>
      )}
      <div className={`w-full h-1 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-gray-600' : 'bg-gray-200'}`}>
        <div
          className={`h-full rounded-full ${c.bg} ${indeterminate ? 'animate-indeterminate' : 'transition-all duration-500'}`}
          style={indeterminate ? {} : { width: `${total > 0 ? Math.max(pct, 5) : 10}%` }}
        />
      </div>
    </div>
  );
}
