import React, { useState, useEffect, useCallback } from 'react';

// 耗时打点统计可视化弹窗
// 数据来源：后端 perf_tracker 记录的 JSONL 日志，经 /api/v1/perf/* 聚合后返回

const OP_COLORS = {
  import_file: '#6366f1',
  import_folder: '#8b5cf6',
  chat_query: '#10b981',
  agent_chat: '#14b8a6',
  test: '#f59e0b',
};
const DEFAULT_COLOR = '#3b82f6';

function _colorFor(op) {
  return OP_COLORS[op] || DEFAULT_COLOR;
}

// 友好格式化耗时
function _fmt(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export default function PerfStatsModal({ theme, onClose, projectPath }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [operationFilter, setOperationFilter] = useState('');
  const [view, setView] = useState('aggregate'); // 'aggregate' | 'recent' | 'deepeval' | 'langgraph' | 'llamaindex' | 'traces'
  // DeepEval 状态
  const [deepevalLoading, setDeepevalLoading] = useState(false);
  const [deepevalError, setDeepevalError] = useState('');
  const [deepevalResult, setDeepevalResult] = useState(null);
  // 柱状图指标：avg | total | max
  const [metric, setMetric] = useState('total');
  // LangGraph 状态
  const [langgraphData, setLanggraphData] = useState(null);
  const [lgLoading, setLgLoading] = useState(false);
  // LlamaIndex 状态
  const [liOverview, setLiOverview] = useState(null);
  const [liDocs, setLiDocs] = useState(null);
  const [liOffset, setLiOffset] = useState(0);
  const [liLoading, setLiLoading] = useState(false);
  const [liIndexName, setLiIndexName] = useState('');
  // Trace 状态
  const [traces, setTraces] = useState(null);
  const [trLoading, setTrLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = operationFilter ? `?operation=${encodeURIComponent(operationFilter)}` : '';
      const [statsRes, recentRes] = await Promise.all([
        fetch(`http://127.0.0.1:5002/api/v1/perf/stats${q}`),
        fetch(`http://127.0.0.1:5002/api/v1/perf/recent?limit=200${operationFilter ? `&operation=${encodeURIComponent(operationFilter)}` : ''}`),
      ]);
      const statsJson = await statsRes.json();
      const recentJson = await recentRes.json();
      if (statsJson.success) setStats(statsJson.data);
      else setError(statsJson.message || '加载统计数据失败');
      if (recentJson.success) setRecent(recentJson.data || []);
    } catch (e) {
      setError(`请求失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [operationFilter]);

  useEffect(() => { load(); }, [load]);

  // ── DeepEval 评估触发 ──
  const runDeepeval = useCallback(async () => {
    setDeepevalLoading(true);
    setDeepevalError('');
    setDeepevalResult(null);
    try {
      const res = await fetch('http://127.0.0.1:5002/api/v1/perf/deepeval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_name: 'sample',
          project_path: projectPath || '',
        }),
      });
      const json = await res.json();
      if (json.success) {
        setDeepevalResult(json.data);
      } else {
        setDeepevalError(json.message || 'DeepEval 评估失败');
      }
    } catch (e) {
      setDeepevalError(`请求失败: ${e.message}`);
    } finally {
      setDeepevalLoading(false);
    }
  }, [projectPath]);

  // ── LangGraph 流程 ──
  const loadLangGraph = useCallback(async () => {
    setLgLoading(true);
    try {
      const res = await fetch('http://127.0.0.1:5002/api/v1/debug/langgraph/graph');
      const json = await res.json();
      if (json.success) setLanggraphData(json.data);
    } catch (e) { /* silent */ }
    finally { setLgLoading(false); }
  }, []);

  // ── LlamaIndex 索引 ──
  const loadLiOverview = useCallback(async () => {
    setLiLoading(true);
    try {
      const res = await fetch('http://127.0.0.1:5002/api/v1/debug/llamaindex/overview');
      const json = await res.json();
      if (json.success) setLiOverview(json.data);
    } catch (e) { /* silent */ }
    finally { setLiLoading(false); }
  }, []);

  const browseLiDocs = useCallback(async (indexName, offset = 0) => {
    setLiIndexName(indexName);
    setLiOffset(offset);
    setLiLoading(true);
    try {
      const res = await fetch(`http://127.0.0.1:5002/api/v1/debug/llamaindex/documents?index_name=${encodeURIComponent(indexName)}&offset=${offset}&limit=10`);
      const json = await res.json();
      if (json.success) setLiDocs(json.data);
    } catch (e) { /* silent */ }
    finally { setLiLoading(false); }
  }, []);

  // ── 执行 Trace ──
  const loadTraces = useCallback(async () => {
    setTrLoading(true);
    try {
      const res = await fetch('http://127.0.0.1:5002/api/v1/debug/traces?limit=50');
      const json = await res.json();
      if (json.success) setTraces(json.data);
    } catch (e) { /* silent */ }
    finally { setTrLoading(false); }
  }, []);

  const dark = theme === 'dark';
  const cardBg = dark ? 'bg-gray-700/60' : 'bg-gray-50 border border-gray-200';
  const textMuted = dark ? 'text-gray-400' : 'text-gray-500';
  const borderCls = dark ? 'border-gray-700' : 'border-gray-200';

  const totals = stats?.totals || { count: 0, success: 0, fail: 0, total_ms: 0 };
  const operations = stats?.operations || {};
  const groups = stats?.groups || [];
  const timeRange = stats?.time_range || { start: '', end: '' };
  const successRate = totals.count ? ((totals.success / totals.count) * 100).toFixed(1) : '0.0';

  // 柱状图最大值（按当前指标）
  const metricKey = metric === 'avg' ? 'avg_ms' : metric === 'max' ? 'max_ms' : 'total_ms';
  const metricLabel = metric === 'avg' ? '平均耗时' : metric === 'max' ? '最大耗时' : '总耗时';
  const maxVal = groups.reduce((m, g) => Math.max(m, g[metricKey] || 0), 0) || 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className={`w-[920px] max-h-[90vh] rounded-xl shadow-2xl overflow-hidden flex flex-col ${
        dark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
      }`}>
        {/* 标题栏 */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${borderCls}`}>
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold">耗时打点统计</h3>
            {timeRange.start && (
              <span className={`text-xs ${textMuted}`}>
                {timeRange.start} ~ {timeRange.end}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className={`text-xs px-2.5 py-1 rounded-lg transition-all ${dark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
            >
              {loading ? '加载中…' : '刷新'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
          </div>
        </div>

        {/* 控制栏 */}
        <div className={`flex items-center gap-3 px-6 py-3 border-b ${borderCls} flex-wrap`}>
          <div className="flex items-center gap-1 rounded-lg overflow-hidden">
            <button
              onClick={() => setView('aggregate')}
              className={`text-xs px-3 py-1.5 transition-all ${view === 'aggregate' ? (dark ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white') : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')}`}
            >聚合统计</button>
            <button
              onClick={() => setView('recent')}
              className={`text-xs px-3 py-1.5 transition-all ${view === 'recent' ? (dark ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white') : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')}`}
            >最近记录</button>
            <button
              onClick={() => { setView('deepeval'); if (!deepevalResult && !deepevalLoading) runDeepeval(); }}
              className={`text-xs px-3 py-1.5 transition-all ${view === 'deepeval' ? (dark ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white') : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')}`}
            >DeepEval 评估</button>
            <button
              onClick={() => { setView('langgraph'); if (!langgraphData && !lgLoading) loadLangGraph(); }}
              className={`text-xs px-3 py-1.5 transition-all ${view === 'langgraph' ? (dark ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white') : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')}`}
            >LangGraph 流程</button>
            <button
              onClick={() => { setView('llamaindex'); if (!liOverview && !liLoading) loadLiOverview(); }}
              className={`text-xs px-3 py-1.5 transition-all ${view === 'llamaindex' ? (dark ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white') : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')}`}
            >LlamaIndex 索引</button>
            <button
              onClick={() => { setView('traces'); if (!traces && !trLoading) loadTraces(); }}
              className={`text-xs px-3 py-1.5 transition-all ${view === 'traces' ? (dark ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white') : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')}`}
            >执行 Trace</button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className={`text-xs ${textMuted}`}>操作类型:</span>
            <select
              value={operationFilter}
              onChange={(e) => setOperationFilter(e.target.value)}
              className={`text-xs px-2 py-1 rounded-lg outline-none border ${dark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-50 border-gray-200 text-gray-700'}`}
            >
              <option value="">全部</option>
              {Object.keys(operations).sort().map(op => (
                <option key={op} value={op}>{op} ({operations[op]})</option>
              ))}
            </select>
          </div>

          {view === 'aggregate' && (
            <div className="flex items-center gap-1.5">
              <span className={`text-xs ${textMuted}`}>柱状图:</span>
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                className={`text-xs px-2 py-1 rounded-lg outline-none border ${dark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-50 border-gray-200 text-gray-700'}`}
              >
                <option value="total">总耗时</option>
                <option value="avg">平均耗时</option>
                <option value="max">最大耗时</option>
              </select>
            </div>
          )}
        </div>

        {/* 内容区 */}
        <div className="p-6 overflow-y-auto flex-1">
          {loading && !stats && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
              <span className={textMuted}>正在加载统计数据...</span>
            </div>
          )}

          {error && !loading && (
            <div className={`p-4 rounded-lg text-sm ${dark ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600'}`}>
              {error}
            </div>
          )}

          {!loading && !error && view === 'aggregate' && (
            <div className="space-y-5">
              {/* 总览卡片 */}
              <div className="grid grid-cols-4 gap-3">
                <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                  <div className="text-2xl font-bold text-indigo-500">{totals.count}</div>
                  <div className={`text-xs mt-1 ${textMuted}`}>总打点数</div>
                </div>
                <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                  <div className="text-2xl font-bold text-emerald-500">{successRate}%</div>
                  <div className={`text-xs mt-1 ${textMuted}`}>成功率 ({totals.success}/{totals.count})</div>
                </div>
                <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                  <div className="text-2xl font-bold text-amber-500">{_fmt(totals.total_ms)}</div>
                  <div className={`text-xs mt-1 ${textMuted}`}>累计耗时</div>
                </div>
                <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                  <div className="text-2xl font-bold text-purple-500">{Object.keys(operations).length}</div>
                  <div className={`text-xs mt-1 ${textMuted}`}>操作类型数</div>
                </div>
              </div>

              {/* 柱状图：各分组耗时 */}
              {groups.length > 0 ? (
                <div className={`p-4 rounded-lg ${cardBg}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className={`text-sm font-medium`}>各步骤耗时分布（{metricLabel}）</h4>
                  </div>
                  <div className="space-y-2">
                    {groups.slice(0, 15).map((g, i) => {
                      const pct = ((g[metricKey] || 0) / maxVal) * 100;
                      const label = `${g.operation} / ${g.step}`;
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <div className={`w-48 flex-shrink-0 text-xs truncate ${dark ? 'text-gray-300' : 'text-gray-600'}`} title={label}>
                            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: _colorFor(g.operation) }}></span>
                            {label}
                          </div>
                          <div className={`flex-1 h-5 rounded-full overflow-hidden ${dark ? 'bg-gray-800' : 'bg-gray-200'}`}>
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: _colorFor(g.operation) }}
                            />
                          </div>
                          <div className={`w-20 flex-shrink-0 text-right text-xs font-mono ${dark ? 'text-gray-200' : 'text-gray-700'}`}>
                            {_fmt(g[metricKey])}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className={`p-8 text-center text-sm ${textMuted}`}>暂无统计数据</div>
              )}

              {/* 详细表格 */}
              {groups.length > 0 && (
                <div className={`p-4 rounded-lg ${cardBg}`}>
                  <h4 className="text-sm font-medium mb-3">分组明细</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className={`border-b ${borderCls} ${textMuted}`}>
                          <th className="text-left py-2 px-2 font-medium">操作 / 步骤</th>
                          <th className="text-right py-2 px-2 font-medium">次数</th>
                          <th className="text-right py-2 px-2 font-medium">平均</th>
                          <th className="text-right py-2 px-2 font-medium">最小</th>
                          <th className="text-right py-2 px-2 font-medium">最大</th>
                          <th className="text-right py-2 px-2 font-medium">总计</th>
                          <th className="text-right py-2 px-2 font-medium">成功率</th>
                          <th className="text-left py-2 px-2 font-medium">模型</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g, i) => (
                          <tr key={i} className={`border-b ${dark ? 'border-gray-700/50' : 'border-gray-100'}`}>
                            <td className="py-2 px-2">
                              <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: _colorFor(g.operation) }}></span>
                              <span className="font-medium">{g.operation}</span>
                              <span className={textMuted}> / {g.step}</span>
                            </td>
                            <td className="text-right py-2 px-2 font-mono">{g.count}</td>
                            <td className="text-right py-2 px-2 font-mono">{_fmt(g.avg_ms)}</td>
                            <td className="text-right py-2 px-2 font-mono">{_fmt(g.min_ms)}</td>
                            <td className="text-right py-2 px-2 font-mono">{_fmt(g.max_ms)}</td>
                            <td className="text-right py-2 px-2 font-mono font-semibold">{_fmt(g.total_ms)}</td>
                            <td className="text-right py-2 px-2 font-mono">
                              {g.count ? (
                                <span className={g.fail_count > 0 ? 'text-red-400' : 'text-emerald-400'}>
                                  {((g.success_count / g.count) * 100).toFixed(0)}%
                                  {g.fail_count > 0 && ` (${g.fail_count}失败)`}
                                </span>
                              ) : '-'}
                            </td>
                            <td className="py-2 px-2">
                              {Object.keys(g.models).length > 0 ? (
                                <span className={`text-xs ${textMuted}`}>{Object.entries(g.models).map(([m, c]) => `${m}×${c}`).join(', ')}</span>
                              ) : <span className={textMuted}>-</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {!loading && !error && view === 'recent' && (
            <div className={`p-4 rounded-lg ${cardBg}`}>
              <h4 className="text-sm font-medium mb-3">最近 {recent.length} 条记录</h4>
              {recent.length === 0 ? (
                <div className={`p-6 text-center text-sm ${textMuted}`}>暂无记录</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`border-b ${borderCls} ${textMuted}`}>
                        <th className="text-left py-2 px-2 font-medium">时间</th>
                        <th className="text-left py-2 px-2 font-medium">操作</th>
                        <th className="text-left py-2 px-2 font-medium">步骤</th>
                        <th className="text-right py-2 px-2 font-medium">耗时</th>
                        <th className="text-left py-2 px-2 font-medium">模型</th>
                        <th className="text-left py-2 px-2 font-medium">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r, i) => (
                        <tr key={i} className={`border-b ${dark ? 'border-gray-700/50' : 'border-gray-100'}`}>
                          <td className={`py-1.5 px-2 font-mono ${textMuted}`}>{r.timestamp}</td>
                          <td className="py-1.5 px-2">
                            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: _colorFor(r.operation) }}></span>
                            {r.operation}
                          </td>
                          <td className="py-1.5 px-2">{r.step}</td>
                          <td className="text-right py-1.5 px-2 font-mono">{_fmt(r.duration_ms)}</td>
                          <td className={`py-1.5 px-2 ${textMuted}`}>{r.model || '-'}</td>
                          <td className="py-1.5 px-2">
                            {r.success === false ? (
                              <span className="text-red-400" title={r.error || ''}>失败</span>
                            ) : (
                              <span className="text-emerald-400">成功</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {view === 'deepeval' && (
            <div className="space-y-5">
              {/* 触发按钮 */}
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium">DeepEval 检索质量评估</h4>
                  <p className={`text-xs mt-0.5 ${textMuted}`}>
                    基于 DeepEval 框架评估检索精确率、召回率和相关性
                    {deepevalResult?.used_fusion_search && '（使用实际融合检索）'}
                  </p>
                </div>
                <button
                  onClick={runDeepeval}
                  disabled={deepevalLoading}
                  className={`text-xs px-4 py-2 rounded-lg font-medium transition-all ${
                    deepevalLoading
                      ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                      : dark ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-indigo-500 hover:bg-indigo-400 text-white'
                  }`}
                >
                  {deepevalLoading ? '评估中…' : deepevalResult ? '重新评估' : '运行评估'}
                </button>
              </div>

              {/* 错误提示 */}
              {deepevalError && (
                <div className={`p-4 rounded-lg text-sm ${dark ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600'}`}>
                  {deepevalError}
                </div>
              )}

              {/* 加载状态 */}
              {deepevalLoading && !deepevalResult && (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
                  <span className={textMuted}>正在运行 DeepEval 评估，请稍候…</span>
                </div>
              )}

              {/* 评估结果 */}
              {deepevalResult && (
                <>
                  {/* 汇总卡片 */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                      <div className="text-2xl font-bold text-indigo-500">{deepevalResult.total_cases}</div>
                      <div className={`text-xs mt-1 ${textMuted}`}>测试用例数</div>
                    </div>
                    <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                      <div className="text-2xl font-bold text-emerald-500">
                        {deepevalResult.statistics.evaluated > 0
                          ? `${((deepevalResult.statistics.passed / deepevalResult.statistics.evaluated) * 100).toFixed(0)}%`
                          : '-'}
                      </div>
                      <div className={`text-xs mt-1 ${textMuted}`}>
                        通过率 ({deepevalResult.statistics.passed}/{deepevalResult.statistics.evaluated})
                      </div>
                    </div>
                    <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                      <div className="text-2xl font-bold text-amber-500">
                        {deepevalResult.statistics.avg_precision > 0
                          ? (deepevalResult.statistics.avg_precision * 100).toFixed(1) + '%'
                          : '-'}
                      </div>
                      <div className={`text-xs mt-1 ${textMuted}`}>平均精确率</div>
                    </div>
                    <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                      <div className="text-2xl font-bold text-purple-500">
                        {deepevalResult.statistics.avg_recall > 0
                          ? (deepevalResult.statistics.avg_recall * 100).toFixed(1) + '%'
                          : '-'}
                      </div>
                      <div className={`text-xs mt-1 ${textMuted}`}>平均召回率</div>
                    </div>
                  </div>

                  {/* 统计详情 */}
                  <div className={`p-4 rounded-lg ${cardBg}`}>
                    <h4 className="text-sm font-medium mb-3">评估指标详情</h4>
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className={textMuted}>精确率通过率</span>
                          <span className="font-mono">{deepevalResult.statistics.precision_passed_rate > 0 ? (deepevalResult.statistics.precision_passed_rate * 100).toFixed(1) + '%' : '-'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={textMuted}>召回率通过率</span>
                          <span className="font-mono">{deepevalResult.statistics.recall_passed_rate > 0 ? (deepevalResult.statistics.recall_passed_rate * 100).toFixed(1) + '%' : '-'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={textMuted}>相关性通过率</span>
                          <span className="font-mono">{deepevalResult.statistics.relevancy_passed_rate > 0 ? (deepevalResult.statistics.relevancy_passed_rate * 100).toFixed(1) + '%' : '-'}</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className={textMuted}>平均相关性</span>
                          <span className="font-mono">{deepevalResult.statistics.avg_relevancy > 0 ? (deepevalResult.statistics.avg_relevancy * 100).toFixed(1) + '%' : '-'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={textMuted}>数据集</span>
                          <span className="font-mono">{deepevalResult.dataset_name}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={textMuted}>评估方式</span>
                          <span className="font-mono">{deepevalResult.used_fusion_search ? '融合检索' : '预期上下文'}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 逐用例详情 */}
                  <div className={`p-4 rounded-lg ${cardBg}`}>
                    <h4 className="text-sm font-medium mb-3">用例详情</h4>
                    {deepevalResult.results.length === 0 ? (
                      <div className={`p-6 text-center text-sm ${textMuted}`}>无评估结果</div>
                    ) : (
                      <div className="space-y-3">
                        {deepevalResult.results.map((r, i) => {
                          const metrics = r.metrics || {};
                          const precisionOk = metrics.precision?.passed;
                          const recallOk = metrics.recall?.passed;
                          const relevancyOk = metrics.relevancy?.passed;
                          const allOk = r.overall_passed;
                          return (
                            <div key={i} className={`p-3 rounded-lg border ${dark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
                              <div className="flex items-start gap-2 mb-2">
                                <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${allOk ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium truncate" title={r.query}>{r.query}</div>
                                  {r.tags?.length > 0 && (
                                    <div className="flex gap-1 mt-1">
                                      {r.tags.map((t, ti) => (
                                        <span key={ti} className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>{t}</span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-xs">
                                <div className={`p-2 rounded text-center ${precisionOk ? (dark ? 'bg-emerald-900/30 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : (dark ? 'bg-red-900/20 text-red-300' : 'bg-red-50 text-red-600')}`}>
                                  <div className="font-mono font-bold">{(metrics.precision?.score || 0) * 100}%</div>
                                  <div className={textMuted}>精确率</div>
                                </div>
                                <div className={`p-2 rounded text-center ${recallOk ? (dark ? 'bg-emerald-900/30 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : (dark ? 'bg-red-900/20 text-red-300' : 'bg-red-50 text-red-600')}`}>
                                  <div className="font-mono font-bold">{(metrics.recall?.score || 0) * 100}%</div>
                                  <div className={textMuted}>召回率</div>
                                </div>
                                <div className={`p-2 rounded text-center ${relevancyOk ? (dark ? 'bg-emerald-900/30 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : (dark ? 'bg-red-900/20 text-red-300' : 'bg-red-50 text-red-600')}`}>
                                  <div className="font-mono font-bold">{(metrics.relevancy?.score || 0) * 100}%</div>
                                  <div className={textMuted}>相关性</div>
                                </div>
                              </div>
                              {/* 评估原因 */}
                              {metrics.relevancy?.reason && (
                                <details className="mt-2">
                                  <summary className={`text-xs cursor-pointer ${textMuted}`}>评估详情</summary>
                                  <div className={`mt-1 p-2 rounded text-xs max-h-32 overflow-y-auto ${dark ? 'bg-gray-900/50 text-gray-400' : 'bg-gray-100 text-gray-600'}`}>
                                    {metrics.relevancy.reason}
                                  </div>
                                </details>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {view === 'langgraph' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">LangGraph 检索流水线</h4>
                <button onClick={loadLangGraph} disabled={lgLoading} className={`text-xs px-3 py-1.5 rounded-lg ${dark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}>
                  {lgLoading ? '加载中…' : '刷新'}
                </button>
              </div>

              {lgLoading && !langgraphData && (
                <div className="flex flex-col items-center py-8">
                  <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2"></div>
                  <span className={`text-xs ${textMuted}`}>加载中…</span>
                </div>
              )}
              {!langgraphData && !lgLoading && (
                <div className={`p-8 text-center text-sm ${textMuted}`}>点击"刷新"加载图结构</div>
              )}
              {langgraphData && (
                <>
                  {/* 节点卡片 */}
                  <div className={`p-4 rounded-lg ${cardBg}`}>
                    <h4 className="text-sm font-medium mb-3">
                      流水线节点 ({langgraphData.nodes?.length || 0})
                    </h4>
                    <div className="overflow-x-auto">
                      <div className="flex items-center gap-1 min-w-max py-2" style={{ flexWrap: 'wrap' }}>
                        {langgraphData.nodes?.map((node, i) => {
                          const typeColors = {
                            entry: dark ? '#6366f1' : '#4f46e5',
                            process: dark ? '#8b5cf6' : '#7c3aed',
                            retrieval: dark ? '#10b981' : '#059669',
                            decision: dark ? '#f59e0b' : '#d97706',
                            output: dark ? '#ec4899' : '#db2777',
                          };
                          const color = typeColors[node.type] || '#3b82f6';
                          return (
                            <React.Fragment key={node.id}>
                              <div className="flex-shrink-0 rounded-lg p-2 text-center" style={{ border: `2px solid ${color}`, minWidth: '100px', backgroundColor: dark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.8)' }}>
                                <div className="text-xs font-semibold" style={{ color }}>{node.label}</div>
                                <div className={`text-xs mt-0.5 ${textMuted}`}>{node.desc}</div>
                              </div>
                              {i < langgraphData.nodes.length - 1 && (
                                <span className={`flex-shrink-0 text-lg ${textMuted}`}>→</span>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* 边详情 */}
                  {langgraphData.edges?.length > 0 && (
                    <div className={`p-4 rounded-lg ${cardBg}`}>
                      <h4 className="text-sm font-medium mb-3">连线关系</h4>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className={`border-b ${borderCls} ${textMuted}`}>
                            <th className="text-left py-2 px-2 font-medium">源节点</th>
                            <th className="text-left py-2 px-2 font-medium">目标节点</th>
                            <th className="text-left py-2 px-2 font-medium">标注</th>
                          </tr>
                        </thead>
                        <tbody>
                          {langgraphData.edges.map((e, i) => (
                            <tr key={i} className={`border-b ${dark ? 'border-gray-700/50' : 'border-gray-100'}`}>
                              <td className="py-1.5 px-2 font-medium">{e.from}</td>
                              <td className="py-1.5 px-2">{e.to}</td>
                              <td className={`py-1.5 px-2 ${textMuted}`}>{e.label || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Mermaid 源码 */}
                  {langgraphData.mermaid && (
                    <details className={`p-4 rounded-lg ${cardBg}`}>
                      <summary className="text-sm font-medium cursor-pointer">Mermaid 源码</summary>
                      <pre className={`mt-3 p-3 rounded text-xs overflow-x-auto ${dark ? 'bg-gray-900 text-gray-300' : 'bg-gray-100 text-gray-700'}`}>{langgraphData.mermaid}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
          )}

          {view === 'llamaindex' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">LlamaIndex 索引概览</h4>
                <button onClick={loadLiOverview} disabled={liLoading} className={`text-xs px-3 py-1.5 rounded-lg ${dark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}>
                  {liLoading ? '加载中…' : '刷新'}
                </button>
              </div>

              {liLoading && !liOverview && (
                <div className="flex flex-col items-center py-8">
                  <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2"></div>
                  <span className={`text-xs ${textMuted}`}>加载中…</span>
                </div>
              )}
              {!liOverview && !liLoading && (
                <div className={`p-8 text-center text-sm ${textMuted}`}>点击"刷新"加载索引数据</div>
              )}
              {liOverview && (
                <>
                  {/* 统计卡片 */}
                  {(() => {
                    const indexes = liOverview.indexes || [];
                    const totalDocs = indexes.reduce((s, i) => s + (i.doc_count || 0), 0);
                    const loadedCount = indexes.filter(i => i.status === 'loaded').length;
                    return (
                      <div className="grid grid-cols-3 gap-3">
                        <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                          <div className="text-2xl font-bold text-indigo-500">{indexes.length}</div>
                          <div className={`text-xs mt-1 ${textMuted}`}>索引数</div>
                        </div>
                        <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                          <div className="text-2xl font-bold text-emerald-500">{totalDocs}</div>
                          <div className={`text-xs mt-1 ${textMuted}`}>文档总数</div>
                        </div>
                        <div className={`p-3 rounded-lg text-center ${cardBg}`}>
                          <div className="text-2xl font-bold text-amber-500">{loadedCount}</div>
                          <div className={`text-xs mt-1 ${textMuted}`}>已加载</div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* 索引列表 */}
                  <div className={`p-4 rounded-lg ${cardBg}`}>
                    <h4 className="text-sm font-medium mb-3">索引列表</h4>
                    {((liOverview.indexes || []).length === 0) ? (
                      <div className={`p-4 text-center text-xs ${textMuted}`}>{liOverview.note || '暂无索引数据'}</div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className={`border-b ${borderCls} ${textMuted}`}>
                            <th className="text-left py-2 px-2 font-medium">名称</th>
                            <th className="text-right py-2 px-2 font-medium">文档数</th>
                            <th className="text-left py-2 px-2 font-medium">状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(liOverview.indexes || []).map((idx, i) => (
                            <tr key={i} className={`border-b ${dark ? 'border-gray-700/50' : 'border-gray-100'} ${idx.status === 'loaded' ? 'cursor-pointer' : ''}`}
                              onClick={() => idx.status === 'loaded' && browseLiDocs(idx.name)}>
                              <td className={`py-1.5 px-2 font-medium ${idx.status === 'loaded' ? 'text-indigo-400' : ''}`}>{idx.name}</td>
                              <td className="text-right py-1.5 px-2 font-mono">{idx.doc_count}</td>
                              <td className="py-1.5 px-2">
                                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                                  idx.status === 'loaded' ? (dark ? 'bg-emerald-900/30 text-emerald-300' : 'bg-emerald-50 text-emerald-600') :
                                  idx.status === 'error' ? (dark ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600') :
                                  dark ? 'bg-gray-700 text-gray-400' : 'bg-gray-200 text-gray-500'
                                }`}>{idx.status}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* 文档浏览 */}
                  {liDocs && liIndexName && (
                    <div className={`p-4 rounded-lg ${cardBg}`}>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-medium">文档浏览: {liDocs.index_name}</h4>
                        <span className={`text-xs ${textMuted}`}>
                          {liDocs.offset + 1}-{Math.min(liDocs.offset + (liDocs.limit || 10), liDocs.total)} / {liDocs.total}
                        </span>
                      </div>
                      <div className="space-y-2 max-h-80 overflow-y-auto">
                        {(liDocs.documents || []).map((doc, i) => (
                          <div key={i} className={`p-2 rounded border ${dark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
                            <div className="text-xs font-medium text-indigo-400">#{liDocs.offset + i + 1} {doc.doc_id}</div>
                            <pre className={`mt-1 text-xs whitespace-pre-wrap break-all ${dark ? 'text-gray-400' : 'text-gray-600'}`}>{doc.text}</pre>
                            {doc.metadata && Object.keys(doc.metadata).length > 0 && (
                              <div className={`mt-1 text-xs ${textMuted}`}>
                                {Object.entries(doc.metadata).map(([k, v]) => `${k}: ${v}`).join(' | ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2 mt-3">
                        {liDocs.offset > 0 && (
                          <button onClick={() => browseLiDocs(liIndexName, Math.max(0, liDocs.offset - (liDocs.limit || 10)))} className={`text-xs px-3 py-1.5 rounded-lg ${dark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}>上一页</button>
                        )}
                        {liDocs.offset + (liDocs.limit || 10) < liDocs.total && (
                          <button onClick={() => browseLiDocs(liIndexName, liDocs.offset + (liDocs.limit || 10))} className={`text-xs px-3 py-1.5 rounded-lg ${dark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}>下一页</button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {view === 'traces' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">
                  执行记录
                  {traces && <span className={`ml-2 text-xs ${textMuted}`}>({traces.total || 0} 条, 容量 {traces.max_capacity || 0})</span>}
                </h4>
                <div className="flex gap-2">
                  <button onClick={loadTraces} disabled={trLoading} className={`text-xs px-3 py-1.5 rounded-lg ${dark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}>
                    {trLoading ? '加载中…' : '刷新'}
                  </button>
                </div>
              </div>

              {trLoading && !traces && (
                <div className="flex flex-col items-center py-8">
                  <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2"></div>
                  <span className={`text-xs ${textMuted}`}>加载中…</span>
                </div>
              )}
              {!traces && !trLoading && (
                <div className={`p-8 text-center text-sm ${textMuted}`}>点击"刷新"加载执行记录</div>
              )}
              {traces && (
                <div className={`p-4 rounded-lg ${cardBg}`}>
                  {(traces.traces || []).length === 0 ? (
                    <div className={`p-6 text-center text-sm ${textMuted}`}>尚无记录（执行一次 fusion_search 后出现）</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className={`border-b ${borderCls} ${textMuted}`}>
                            <th className="text-left py-2 px-2 font-medium">时间</th>
                            <th className="text-left py-2 px-2 font-medium">类型</th>
                            <th className="text-left py-2 px-2 font-medium">级别</th>
                            <th className="text-left py-2 px-2 font-medium">数据</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...traces.traces].reverse().map((t, i) => (
                            <tr key={i} className={`border-b ${dark ? 'border-gray-700/50' : 'border-gray-100'}`}>
                              <td className={`py-1.5 px-2 font-mono whitespace-nowrap ${textMuted}`}>
                                {(t.timestamp || '').replace('T', ' ').substring(0, 19)}
                              </td>
                              <td className="py-1.5 px-2 whitespace-nowrap">
                                <span className="text-emerald-400">{t.type}</span>
                              </td>
                              <td className="py-1.5 px-2">
                                <span className={`text-xs px-1.5 py-0.5 rounded ${t.level === 'error' ? (dark ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600') : t.level === 'warn' ? (dark ? 'bg-amber-900/30 text-amber-300' : 'bg-amber-50 text-amber-600') : dark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-600'}`}>{t.level || 'info'}</span>
                              </td>
                              <td className="py-1.5 px-2">
                                <pre className={`text-xs whitespace-pre-wrap max-h-24 overflow-y-auto ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{JSON.stringify(t.data || {}, null, 0).substring(0, 200)}</pre>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
