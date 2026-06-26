import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { writeMemoryFile } from '../shared/memoryFile';

// PPT 结构确认弹窗（意图分析/内容审核/幻灯片审核/结构规划）
export default function PptStructureDialog({
  pptStructureDialog, setPptStructureDialog,
  theme,
  pptWorkflowMode, pptMode, pptVisualStyle, pptContentFormat,
  setPptWorkflowMode, setPptMode, setPptVisualStyle, setPptContentFormat,
  resumePptPipeline,
  buildIntentOptionsPayload,
  editableSlides,
  updateEditableSlidePageType,
  moveEditableSlide,
  updateEditableSlide,
  updateEditableSlideFromEvent,
}) {
  if (!pptStructureDialog) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className={`rounded-xl shadow-xl ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`} style={{ width: 'min(1280px, 96vw)', height: 'min(860px, 92vh)', display: 'flex', flexDirection: 'column' }}>
                  <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
                    <div className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                      {pptStructureDialog.stage === 'content_review' ? '内容审核确认' : pptStructureDialog.stage === 'intent' ? '意图分析确认' : pptStructureDialog.stage === 'slide_review' ? '幻灯片审核' : '结构规划确认'}
                    </div>
                    <div className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {pptStructureDialog.stage === 'content_review'
                        ? `第 ${pptStructureDialog.round || '-'} 轮审核：${pptStructureDialog.score || '-'} 分，建议动作：${pptStructureDialog.action || '-'}`
                        : `目标 ${pptStructureDialog.expectedSlides || '-'} 页，最低 ${pptStructureDialog.minRequiredSlides || '-'} 页，当前 ${pptStructureDialog.slideCount || '-'} 页，来源标记 ${pptStructureDialog.sourceMarkerCount || 0} 条`
                      }
                    </div>
                  </div>

                  <div className={`p-4 space-y-3 flex-1 min-h-0 ${pptStructureDialog.stage === 'structure_review' ? 'overflow-hidden flex flex-col' : 'overflow-auto'}`}>
                    {/* Step 4 内容审核：显示 issues 和 suggestions */}
                    {pptStructureDialog.stage === 'content_review' && pptStructureDialog.issues?.length > 0 && (
                      <div className={`rounded-lg p-3 text-xs space-y-1 ${theme === 'dark' ? 'bg-red-900/20 text-red-200' : 'bg-red-50 text-red-700'}`}>
                        <div className="font-semibold">发现的问题：</div>
                        {pptStructureDialog.issues.map((issue, i) => (
                          <div key={i}>• {issue}</div>
                        ))}
                      </div>
                    )}
                    {pptStructureDialog.stage === 'content_review' && pptStructureDialog.suggestions?.length > 0 && (
                      <div className={`rounded-lg p-3 text-xs space-y-1 ${theme === 'dark' ? 'bg-blue-900/20 text-blue-200' : 'bg-blue-50 text-blue-700'}`}>
                        <div className="font-semibold">改进建议：</div>
                        {pptStructureDialog.suggestions.map((s, i) => (
                          <div key={i}>• {s}</div>
                        ))}
                      </div>
                    )}
                    {pptStructureDialog.stage !== 'content_review' && Object.keys(pptStructureDialog.typeCounts || {}).length > 0 && (
                      <div className={`text-xs ${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
                        页型分布：{Object.entries(pptStructureDialog.typeCounts).map(([k, v]) => `${k}:${v}`).join(' / ')}
                      </div>
                    )}
                    {pptStructureDialog.warnings?.length > 0 && (
                      <div className={`rounded-lg p-3 text-xs ${theme === 'dark' ? 'bg-yellow-900/20 text-yellow-200' : 'bg-yellow-50 text-yellow-700'}`}>
                        结构风险：{pptStructureDialog.warnings.join('；')}
                      </div>
                    )}

                    {/* 内容展示区 */}
                    <div className={`space-y-1 ${pptStructureDialog.stage === 'structure_review' ? 'flex-1 min-h-0' : ''}`}>
                      {pptStructureDialog.stage === 'intent' ? (
                        /* 意图分析：展示 JSON + 模式/风格/内容形式选择 */
                        <>
                          <label className={`block text-xs font-medium mb-1 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                            意图分析结果
                          </label>
                          <pre className={`w-full p-4 rounded-lg border text-xs leading-5 overflow-auto font-mono whitespace-pre-wrap ${
                            theme === 'dark'
                              ? 'bg-gray-900 border-gray-700 text-gray-200'
                              : 'bg-white border-gray-200 text-gray-700'
                          }`}>{JSON.stringify(pptStructureDialog.intent || {}, null, 2)}</pre>

                          <div className={`mt-3 rounded-lg border p-3 space-y-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
                            {/* 工作模式 */}
                            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                              <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>工作模式</div>
                              <div className="grid grid-cols-2 gap-1.5">
                                {[{ value: 'auto', label: '自动完成' }, { value: 'manual', label: '人工确认' }].map(o => {
                                  const active = pptWorkflowMode === o.value;
                                  return <button key={o.value} type="button" onClick={() => setPptWorkflowMode(o.value)} className={`px-3 py-2 rounded-md text-xs font-medium border transition-all ${active ? theme === 'dark' ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-indigo-500 bg-indigo-50 text-indigo-700' : theme === 'dark' ? 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>{o.label}</button>;
                                })}
                              </div>
                            </div>
                            {/* 内容密度 */}
                            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                              <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>内容密度</div>
                              <div className="grid grid-cols-3 gap-1.5">
                                {[{ value: 'detailed', label: '详细' }, { value: 'concise', label: '精简' }, { value: 'bullet', label: '要点' }].map(o => {
                                  const active = pptContentFormat === o.value;
                                  return <button key={o.value} type="button" onClick={() => setPptContentFormat(o.value)} className={`px-3 py-2 rounded-md text-xs font-medium border transition-all ${active ? theme === 'dark' ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-indigo-500 bg-indigo-50 text-indigo-700' : theme === 'dark' ? 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>{o.label}</button>;
                                })}
                              </div>
                            </div>
                            {/* 沟通模式 */}
                            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                              <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>沟通模式</div>
                              <div>
                                <select value={pptMode} onChange={e => setPptMode(e.target.value)} className={`w-full px-3 py-1.5 rounded-md text-xs border outline-none transition-all appearance-none ${theme === 'dark' ? 'bg-gray-800 border-gray-600 text-gray-200 focus:border-indigo-500' : theme === 'light' ? 'bg-white border-gray-200 text-gray-700 focus:border-indigo-400' : 'bg-gray-700 border-gray-500 text-gray-200 focus:border-indigo-500'}`}>
                                  {PPT_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>
                            </div>
                            {/* 视觉风格 */}
                            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                              <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>视觉风格</div>
                              <div>
                                <select value={pptVisualStyle} onChange={e => setPptVisualStyle(e.target.value)} className={`w-full px-3 py-1.5 rounded-md text-xs border outline-none transition-all appearance-none ${theme === 'dark' ? 'bg-gray-800 border-gray-600 text-gray-200 focus:border-indigo-500' : theme === 'light' ? 'bg-white border-gray-200 text-gray-700 focus:border-indigo-400' : 'bg-gray-700 border-gray-500 text-gray-200 focus:border-indigo-500'}`}>
                                  {PPT_STYLES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>
                            </div>
                          </div>
                        </>
                      ) : pptStructureDialog.stage === 'structure_review' ? (() => {
                        const pages = (pptStructureDialog.pagePlans?.length ? pptStructureDialog.pagePlans : (pptStructureDialog.slides || [])).slice(0, 40);
                        const activeIndex = Math.min(Math.max(pptStructureDialog.selectedPageIndex || 0, 0), Math.max(pages.length - 1, 0));
                        const activePage = pages[activeIndex] || {};
                        const activeType = activePage.type || activePage.slide_type || 'unknown';
                        const activeBullets = activePage.bullets || [];
                        const activeKpis = activePage.kpis || [];
                        const activeSections = activePage.sections || [];
                        return (
                          <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-4 h-full min-h-0">
                            <div className={`rounded-lg border overflow-hidden min-h-0 flex flex-col ${theme === 'dark' ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
                              <div className={`px-3 py-2 text-xs font-semibold border-b ${theme === 'dark' ? 'border-gray-700 text-gray-300' : 'border-gray-200 text-gray-600'}`}>
                                页面列表 ({pages.length})
                              </div>
                              <div className="flex-1 min-h-0 overflow-auto">
                                {pages.map((page, idx) => {
                                  const selected = idx === activeIndex;
                                  const type = page.type || page.slide_type || 'unknown';
                                  const hasRisk = (page.source_count || 0) === 0 || (page.bullets || []).length === 0;
                                  return (
                                    <button
                                      key={idx}
                                      onClick={() => setPptStructureDialog(prev => ({ ...prev, selectedPageIndex: idx }))}
                                      className={`w-full text-left px-3 py-2.5 border-b transition-all ${theme === 'dark' ? 'border-gray-800' : 'border-gray-200'} ${
                                        selected
                                          ? theme === 'dark' ? 'bg-indigo-600/25' : 'bg-indigo-50'
                                          : theme === 'dark' ? 'hover:bg-gray-800' : 'hover:bg-white'
                                      }`}
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] flex-shrink-0 ${selected ? 'bg-indigo-600 text-white' : theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                                          {idx + 1}
                                        </span>
                                        <span className={`text-sm font-medium truncate ${theme === 'dark' ? 'text-gray-100' : 'text-gray-800'}`}>
                                          {page.title || `第 ${idx + 1} 页`}
                                        </span>
                                      </div>
                                      <div className={`mt-1 ml-8 flex items-center gap-1.5 text-[10px] ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                                        <span className={`px-1.5 py-0.5 rounded ${theme === 'dark' ? 'bg-gray-800' : 'bg-white'}`}>{type}</span>
                                        <span>来源 {page.source_count || 0}</span>
                                        {hasRisk && <span className={theme === 'dark' ? 'text-yellow-300' : 'text-yellow-600'}>待检查</span>}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <div className={`rounded-lg border p-4 overflow-auto min-h-0 ${theme === 'dark' ? 'border-gray-700 bg-gray-900/60' : 'border-gray-200 bg-white'}`}>
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className={`text-xs mb-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>第 {activeIndex + 1} 页</div>
                                  <h4 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                                    {activePage.title || '未命名页面'}
                                  </h4>
                                </div>
                                <div className="flex gap-2 flex-wrap justify-end">
                                  <span className={`text-xs px-2 py-1 rounded ${theme === 'dark' ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>{activeType}</span>
                                  <span className={`text-xs px-2 py-1 rounded ${theme === 'dark' ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>来源 {activePage.source_count || 0}</span>
                                  {(activePage.visual_data_count || 0) > 0 && <span className={`text-xs px-2 py-1 rounded ${theme === 'dark' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}>图表数据 {activePage.visual_data_count}</span>}
                                </div>
                              </div>

                              {activePage.summary && (
                                <div className={`mt-4 rounded-lg p-3 text-sm ${theme === 'dark' ? 'bg-indigo-900/20 text-indigo-100' : 'bg-indigo-50 text-indigo-800'}`}>
                                  <div className="text-xs font-semibold mb-1">核心结论</div>
                                  {activePage.summary}
                                </div>
                              )}

                              <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
                                <div className={`rounded-lg p-3 ${theme === 'dark' ? 'bg-gray-800/70' : 'bg-gray-50'}`}>
                                  <div className={`text-xs font-semibold mb-2 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>主要内容</div>
                                  {activeBullets.length ? (
                                    <ul className={`space-y-1 text-sm ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}`}>
                                      {activeBullets.map((b, i) => <li key={i}>- {b}</li>)}
                                    </ul>
                                  ) : (
                                    <div className={`text-sm ${theme === 'dark' ? 'text-yellow-300' : 'text-yellow-700'}`}>暂无要点，建议补充。</div>
                                  )}
                                </div>

                                <div className={`rounded-lg p-3 ${theme === 'dark' ? 'bg-gray-800/70' : 'bg-gray-50'}`}>
                                  <div className={`text-xs font-semibold mb-2 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>关键指标 / 章节</div>
                                  {activeKpis.length || activeSections.length ? (
                                    <div className={`space-y-2 text-sm ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}`}>
                                      {activeKpis.map((k, i) => <div key={`kpi-${i}`}>[KPI] {k}</div>)}
                                      {activeSections.map((s, i) => <div key={`section-${i}`}>### {s}</div>)}
                                    </div>
                                  ) : (
                                    <div className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>未提取到指标或章节。</div>
                                  )}
                                </div>
                              </div>

                              <div className={`mt-4 rounded-lg p-3 text-sm ${theme === 'dark' ? 'bg-gray-800/70 text-gray-300' : 'bg-gray-50 text-gray-600'}`}>
                                <div className="text-xs font-semibold mb-2">页面检查</div>
                                <div className="space-y-1">
                                  {(activePage.source_count || 0) === 0 && <div className={theme === 'dark' ? 'text-yellow-300' : 'text-yellow-700'}>- 这一页没有来源标记，涉及数据或事实时建议补充。</div>}
                                  {activeBullets.length === 0 && <div className={theme === 'dark' ? 'text-yellow-300' : 'text-yellow-700'}>- 这一页没有主要内容要点。</div>}
                                  {(activePage.source_count || 0) > 0 && activeBullets.length > 0 && <div>当前页具备基础内容和来源标记，可继续人工判断表达是否合理。</div>}
                                </div>
                              </div>

                              {pptStructureDialog.outline && (
                                <details className="mt-4">
                                  <summary className={`text-xs cursor-pointer ${theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-600'}`}>查看完整大纲文本</summary>
                                  <pre className={`mt-2 w-full p-4 rounded-lg border text-xs leading-5 overflow-auto font-mono whitespace-pre-wrap ${
                                    theme === 'dark'
                                      ? 'bg-gray-950 border-gray-700 text-gray-200'
                                      : 'bg-white border-gray-200 text-gray-700'
                                  }`}>{pptStructureDialog.outline}</pre>
                                </details>
                              )}
                            </div>
                          </div>
                        );
                      })() : (
                        /* 其他阶段：页面列表 + 可折叠大纲 */
                        <>
                          <div className="space-y-1">
                            {(pptStructureDialog.pagePlans?.length ? pptStructureDialog.pagePlans : (pptStructureDialog.slides || [])).slice(0, 40).map((page, idx) => (
                              <div key={idx} className={`rounded-lg px-3 py-2 ${theme === 'dark' ? 'bg-gray-900/70' : 'bg-gray-50'}`}>
                                <div className={`text-sm font-medium flex items-center gap-2 ${theme === 'dark' ? 'text-gray-100' : 'text-gray-800'}`}>
                                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${theme === 'dark' ? 'bg-indigo-700 text-indigo-100' : 'bg-indigo-100 text-indigo-700'}`}>{idx + 1}</span>
                                  <span className="truncate">{page.title}</span>
                                  {(page.type || page.slide_type) && <span className={`text-[10px] px-1.5 py-0.5 rounded ${theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>{page.type || page.slide_type}</span>}
                                </div>
                                {page.bullets?.length > 0 && (
                                  <div className={`mt-1 ml-7 text-[11px] truncate ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                                    {page.bullets.slice(0, 2).join('；')}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                          {pptStructureDialog.outline && (
                            <details className="mt-2">
                              <summary className={`text-xs cursor-pointer ${theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-600'}`}>展开查看完整大纲文本</summary>
                              <pre className={`mt-2 w-full p-4 rounded-lg border text-xs leading-5 overflow-auto font-mono whitespace-pre-wrap ${
                                theme === 'dark'
                                  ? 'bg-gray-900 border-gray-700 text-gray-200'
                                  : 'bg-white border-gray-200 text-gray-700'
                              }`}>{pptStructureDialog.outline}</pre>
                            </details>
                          )}
                        </>
                      )}
                    </div>

                    {/* 意见输入框 - 固定在底部 */}
                    <div className={`border-t pt-3 mt-3 shrink-0 ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
                      <label className={`block text-xs font-semibold mb-1.5 ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}`}>
                        💬 {pptStructureDialog.stage === 'content_review'
                          ? '输入审核意见'
                          : pptStructureDialog.stage === 'intent'
                          ? '输入补充意见'
                          : '输入优化意见'}
                        <span className={`font-normal ml-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>(可选)</span>
                      </label>
                      <textarea
                        value={pptStructureDialog.userFeedback || ''}
                        onChange={(e) => setPptStructureDialog(prev => ({ ...prev, userFeedback: e.target.value }))}
                        placeholder={pptStructureDialog.stage === 'content_review'
                          ? '例如：数据来源不够充分、缺少竞品对比页、技术深度不足...'
                          : pptStructureDialog.stage === 'intent'
                          ? '例如：增加对推理加速的关注、受众是技术管理者、控制在 12 页以内...'
                          : pptStructureDialog.stage === 'structure_review'
                          ? '例如：第 5 页补充性能对比；第 8 页拆成两页；整体减少背景介绍，增加落地风险。'
                          : '例如：增加评测对比页、减少目录页、加强风险和部署部分、补充来源标记...'}
                        rows={pptStructureDialog.stage === 'structure_review' ? 2 : 3}
                        className={`w-full p-3 rounded-lg border text-sm leading-6 ${pptStructureDialog.stage === 'structure_review' ? 'resize-none' : 'resize-y'} outline-none ${
                          theme === 'dark'
                            ? 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500 focus:border-indigo-400'
                            : 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400 focus:border-indigo-500'
                        }`}
                      />
                    </div>
                  </div>

                  <div className={`p-4 border-t flex justify-end gap-2 flex-wrap ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
                    <button
                      onClick={() => {
                        resumePptPipeline(pptStructureDialog.pipelineId, 'cancel');
                        setPptStructureDialog(null);
                      }}
                      className={`px-4 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
                    >
                      取消
                    </button>
                    <button
                      onClick={() => {
                        const action = pptStructureDialog.stage === 'intent' ? 'reanalyze'
                          : pptStructureDialog.stage === 'content_review' ? 'edit'
                          : pptStructureDialog.stage === 'slide_review' ? 'regenerate'
                          : pptStructureDialog.stage === 'structure_review' ? 'smart_replan' : 'edit';
                        // 意图阶段：提交补充意见；其他阶段：用户意见
                        const content = pptStructureDialog.stage === 'intent'
                          ? buildIntentOptionsPayload({ feedback: (pptStructureDialog.userFeedback || '').trim() })
                          : (pptStructureDialog.userFeedback || pptStructureDialog.feedback || '');
                        resumePptPipeline(pptStructureDialog.pipelineId, action, content);
                        if (pptStructureDialog.stage === 'intent') {
                          writeMemoryFile({ pptSettings: { workflowMode: pptWorkflowMode, mode: pptMode, visualStyle: pptVisualStyle, contentFormat: pptContentFormat } });
                        }
                        setPptStructureDialog(null);
                      }}
                      className={`px-4 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
                    >
                      {pptStructureDialog.stage === 'structure_review' ? '按意见调整' : pptStructureDialog.stage === 'intent' ? '补充意见重分析' : pptStructureDialog.stage === 'content_review' ? '按意见修改大纲' : pptStructureDialog.stage === 'slide_review' ? '按意见重生成' : '按意见重规划'}
                    </button>
                    {pptStructureDialog.stage === 'content_review' && (
                      <button
                        onClick={() => {
                          resumePptPipeline(pptStructureDialog.pipelineId, 'search_replan', pptStructureDialog.userFeedback || '');
                          setPptStructureDialog(null);
                        }}
                        className={`px-4 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
                      >
                        搜索补充后{pptStructureDialog.stage === 'content_review' ? '重新审核' : '重规划'}
                      </button>
                    )}
                    {pptStructureDialog.stage !== 'content_review' && pptStructureDialog.stage !== 'structure_review' && (
                      <button
                        onClick={() => {
                          // 直接编辑：提交大纲文本
                          resumePptPipeline(pptStructureDialog.pipelineId, 'direct_edit', pptStructureDialog.outline || pptStructureDialog.feedback || '');
                          setPptStructureDialog(null);
                        }}
                        className={`px-4 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
                      >
                        直接采用编辑
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (
                          pptStructureDialog.stage === 'structure_review'
                          && (pptStructureDialog.userFeedback || '').trim()
                        ) {
                          const shouldContinue = window.confirm('意见栏还有未提交的内容。继续将忽略这些意见并进入下一步，是否继续？');
                          if (!shouldContinue) return;
                        }
                        // 意图阶段：传递工作模式、风格、内容形式
                        if (pptStructureDialog.stage === 'intent') {
                          const intentOptions = buildIntentOptionsPayload();
                          resumePptPipeline(pptStructureDialog.pipelineId, 'continue', intentOptions);
                          // 持久化设置
                          writeMemoryFile({ pptSettings: { workflowMode: pptWorkflowMode, mode: pptMode, visualStyle: pptVisualStyle, contentFormat: pptContentFormat } });
                        } else {
                          resumePptPipeline(pptStructureDialog.pipelineId, 'continue');
                        }
                        setPptStructureDialog(null);
                      }}
                      className={`px-4 py-2 rounded-lg text-sm text-white ${theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-500 hover:bg-indigo-600'}`}
                    >
                      {pptStructureDialog.stage === 'structure_review' ? '继续' : '确认继续'}
                    </button>
                  </div>
                </div>
              </div>
    </div>
  );
}
