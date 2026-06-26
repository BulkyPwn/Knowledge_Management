/**
 * PPT 流水线 —— 启动/恢复/任务监控/Review卡片渲染
 */
import React, { useState } from 'react';

export default function usePptPipeline({
  WIKI_BASE,
  targetFileType, renderMode,
  messages, setMessages,
  setIsTyping, isTyping,
  selectedKBIds, getKbKey,
  projectPath,
  pipelineState, setPipelineState,
  pipelineAbortRef, pipelineDetailsOpen, setPipelineDetailsOpen,
  pptTasks, setPptTasks,
  addTask, updateTask, runTask,
  readMemoryFile,
  renderMarkdown,
  writeMemoryFile,
  pptContentFormat, setPptContentFormat,
  pptMode, setPptMode,
  pptVisualStyle, setPptVisualStyle,
  pptWorkflowMode, setPptWorkflowMode,
  showPptTaskModal, setShowPptTaskModal,
  pptStructureDialog, setPptStructureDialog,
  pptTasksLoading, setPptTasksLoading,
  PPT_MODES, PPT_STYLES,
  pptTemplate, setPptTemplate, referencePptx, pptSvgMaxWorkers,
  platforms, theme, workMode,
  setPptPreviewModal,
}) {
  const [pptPreviewSrc, setPptPreviewSrc] = useState(null);
  const [pptPreviewIndex, setPptPreviewIndex] = useState(0);

  const runPptPipeline = async (query) => {
    const initSteps = [
      { id: 1, name: '意图分析', status: 'pending' },
      { id: 2, name: '信息收集', status: 'pending' },
      { id: 3, name: '结构规划', status: 'pending' },
      { id: 4, name: '内容审核', status: 'pending' },
      { id: 5, name: '渲染PPT', status: 'pending' },
      { id: 6, name: '视觉审核', status: 'pending' },
    ];
    setPipelineState({ running: true, steps: initSteps, logs: [], stepDetails: {}, result: null, error: null });
    setPipelineDetailsOpen(false);
    setMessages(prev => [...prev, { type: 'assistant', content: '🚀 启动 PPT 六步流水线...', isStep: true, isPipelineStart: true }]);

    const controller = new AbortController();
    pipelineAbortRef.current = controller;

    let renderData = null;
    try {
      // Map unified workMode to optimization_mode: speed→speed, normal→balanced, professional→quality
      const optimizationMode = workMode === 'speed' ? 'speed' : workMode === 'professional' ? 'quality' : 'balanced';
      const res = await fetch(`${WIKI_BASE}/ppt-pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          template: pptTemplate || 'default',
          project_ids: selectedKBIds.map(k => String(k).split('::')[0]).filter(Boolean),
          use_web_search: !!platforms.webSearch,
          platforms: { local: !!platforms.local, hiDesk: !!platforms.hiDesk, haiwen: !!platforms.haiwen, webSearch: !!platforms.webSearch },
          workflow_mode: pptWorkflowMode,
          optimization_mode: optimizationMode,
          svg_max_workers: pptSvgMaxWorkers,
          max_search_rounds: 10,
          max_content_rounds: 3,
          max_visual_rounds: 5,
          reference_pptx: referencePptx || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '未知错误');
        throw new Error(`后端返回 ${res.status}: ${errText.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            // manual 模式：步骤 1/3/4/5 的人工确认卡片嵌入聊天流
            if ([1, 3, 4, 5].includes(evt.step) && evt.status === 'await_user' && evt.data?.pipeline_id && evt.data?.manual === true && !evt.data?.heartbeat) {
              if (evt.data.stage === 'intent') {
                const nextTemplate = evt.data.template || 'default';
                setPptTemplate(nextTemplate);
                setPptMode(evt.data.default_mode || 'briefing');
                setPptVisualStyle(
                  nextTemplate === 'huawei_standard'
                    ? 'huawei-corporate'
                    : (evt.data.default_visual_style || 'dark-tech')
                );
              }
              setPptStructureDialog(null);
              setIsTyping(false);
              setMessages(prev => [...prev, buildPptReviewMessage(evt)]);
            }
            setPipelineState(prev => {
              if (!prev) return prev;
              const steps = [...prev.steps];
              const logs = [...prev.logs];
              const stepDetails = { ...prev.stepDetails };
              if (typeof evt.step === 'number') {
                if (evt.step === 2.5) {
                  if (steps[0] && steps[0].status !== 'error') {
                    steps[0] = { ...steps[0], status: 'done' };
                  }
                  if (steps[1] && steps[1].status !== 'error') {
                    steps[1] = {
                      ...steps[1],
                      status: evt.status === 'done' ? 'done' : 'running',
                    };
                  }
                  if ((evt.status === 'running' || evt.status === 'done') && evt.data) {
                    stepDetails[2.5] = { ...stepDetails[2.5], ...evt.data, message: evt.message };
                  }
                } else {
                  const idx = evt.step - 1;
                  if (steps[idx]) {
                    for (let i = 0; i < idx; i += 1) {
                      if (steps[i] && steps[i].status !== 'error') {
                        steps[i] = { ...steps[i], status: 'done' };
                      }
                    }
                    const mappedStatus =
                      (evt.status === 'running' || evt.status === 'await_user' || evt.status === 'search_done'
                        || evt.status === 'searching_again' || evt.status === 'targeted_refine'
                        || evt.status === 'review_result' || evt.status === 'visual_review'
                        || evt.status === 'rendering_slide' || evt.status === 'slide_preview' || evt.status === 'refining'
                        || evt.status === 'rollback' || evt.status === 'ready_for_render'
                      ) ? 'running'
                        : evt.status === 'done' ? 'done'
                        : (evt.status === 'blocked' || evt.status === 'error') ? 'error'
                        : steps[idx].status;
                    if (steps[idx]) {
                      steps[idx] = { ...steps[idx], status: mappedStatus };
                      // Step 5 done → mark step 6 auto-done too (executor exports directly)
                      if (evt.step === 5 && mappedStatus === 'done' && steps[5]) {
                        steps[5] = { ...steps[5], status: 'running' };
                      }
                      if (evt.step === 6 && mappedStatus === 'done' && steps[5]) {
                        steps[5] = { ...steps[5], status: 'done' };
                      }
                    }
                    if (evt.step >= 5 && (mappedStatus === 'done' || mappedStatus === 'running')) {
                      // Auto-complete earlier steps
                      for (let i = 0; i < Math.min(4, evt.step - 1); i++) {
                        if (steps[i] && steps[i].status !== 'error') {
                          steps[i] = { ...steps[i], status: 'done' };
                        }
                      }
                    }
                  }
                  if (evt.step === 2 && evt.status === 'search_done' && evt.data) {
                    const prevRounds = stepDetails[2]?.live_rounds || [];
                    const nextRounds = [...prevRounds.filter(r => r.round !== evt.data.round), evt.data]
                      .sort((a, b) => (a.round || 0) - (b.round || 0));
                    stepDetails[2] = { ...stepDetails[2], live_rounds: nextRounds, message: evt.message };
                  }
                  if (evt.step === 4 && evt.status === 'review_result' && evt.data) {
                    const round = {
                      round: evt.data.round, score: evt.data.score, action: evt.data.action,
                      issues: evt.data.issues || [], suggestions: evt.data.suggestions || [],
                      next_action: evt.data.next_action,
                    };
                    const prevRounds = stepDetails[4]?.review_rounds || [];
                    const nextRounds = [...prevRounds.filter(r => r.round !== round.round), round]
                      .sort((a, b) => (a.round || 0) - (b.round || 0));
                    stepDetails[4] = {
                      ...stepDetails[4], review_rounds: nextRounds, rounds_used: nextRounds.length,
                      final_score: round.score, next_action: round.next_action,
                      message: `第${round.round}轮审核：${round.score}分，动作：${round.action}`,
                    };
                  }
                  if (evt.step === 5 && evt.status === 'slide_preview' && evt.data) {
                    const preview = {
                      page_num: evt.data.page_num || evt.data.current_page,
                      title: evt.data.title || '',
                      filename: evt.data.filename || '',
                      filepath: evt.data.filepath || '',
                      svg: evt.data.svg || '',
                    };
                    const prevPreviews = stepDetails[5]?.slide_previews || [];
                    const nextPreviews = [
                      ...prevPreviews.filter(p => p.page_num !== preview.page_num),
                      preview,
                    ].sort((a, b) => (a.page_num || 0) - (b.page_num || 0));
                    stepDetails[5] = {
                      ...stepDetails[5],
                      ...evt.data,
                      slide_previews: nextPreviews,
                      message: evt.message,
                    };
                  }
                  // Track page-level issues (timeout/error)
                  if (evt.step === 5 && evt.data?.error_type) {
                    const pageIssue = {
                      page_num: evt.data.page_num || evt.data.current_page,
                      title: evt.data.title || '',
                      error_type: evt.data.error_type,
                      error_msg: evt.data.error_msg || evt.message,
                    };
                    const prevIssues = stepDetails[5]?.page_issues || [];
                    stepDetails[5] = {
                      ...stepDetails[5],
                      page_issues: [
                        ...prevIssues.filter(p => p.page_num !== pageIssue.page_num),
                        pageIssue,
                      ].sort((a, b) => (a.page_num || 0) - (b.page_num || 0)),
                    };
                  }
                  if ((evt.status === 'running' || evt.status === 'await_user' || evt.status === 'targeted_refine'
                    || evt.status === 'refining' || evt.status === 'rollback' || evt.status === 'done'
                    || evt.status === 'blocked' || evt.status === 'ready_for_render' || evt.status === 'slide_preview') && evt.data) {
                    const existingPreviews = stepDetails[evt.step]?.slide_previews;
                    stepDetails[evt.step] = { ...stepDetails[evt.step], ...evt.data, message: evt.message };
                    if (existingPreviews?.length && !stepDetails[evt.step].slide_previews) {
                      stepDetails[evt.step].slide_previews = existingPreviews;
                    }
                  }
                }
              }
              // 日志去重：如果最后一条 log 的 step+status+message 相同（heartbeat），只更新不追加
              const lastLog = logs[logs.length - 1];
              const isHeartbeat = evt.data?.heartbeat === true
                || (lastLog && lastLog.step === evt.step && lastLog.status === evt.status
                    && lastLog.message && evt.message
                    && lastLog.message.replace(/\d+\.\d+秒/g, '').replace(/\d+秒/g, '')
                    === evt.message.replace(/\d+\.\d+秒/g, '').replace(/\d+秒/g, ''));
              if (isHeartbeat && lastLog) {
                logs[logs.length - 1] = evt;  // 原地更新最后一条
              } else {
                logs.push(evt);
              }
              return { ...prev, steps, logs, stepDetails };
            });
            // ready_for_render 步骤1-4完成，记录渲染数据（Chrys fallback）
            if (evt.status === 'ready_for_render' && evt.data) {
              renderData = evt.data;
            }
            // Step 6 done: executor 直接完成（新流程）
            if (evt.step === 6 && evt.status === 'done' && evt.data) {
              renderData = { ...evt.data, _executor_done: true };
            }
            // Error from executor
            if (evt.step === 'error' && evt.data?.error && !renderData) {
              renderData = { _error: evt.data.error, _executor_failed: true };
            }
            if (evt.step === 'complete') {
              setPipelineState(prev => {
                if (!prev) return prev;
                const steps = prev.steps.map(s => (
                  s.status === 'error' ? s : { ...s, status: 'done' }
                ));
                return { ...prev, steps, running: false, result: evt.data };
              });
            }
            if (evt.step === 'error') {
              setPipelineState(prev => prev ? { ...prev, running: false, error: evt.message } : prev);
              setMessages(prev => [...prev, { type: 'assistant', content: `❌ 流水线失败: ${evt.message}`, isStep: true }]);
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setPipelineState(prev => prev ? { ...prev, running: false, error: e.message } : prev);
        setMessages(prev => [...prev, { type: 'assistant', content: `❌ 流水线出错: ${e.message}`, isStep: true }]);
      }
    } finally {
      pipelineAbortRef.current = null;
    }
    return renderData;
  };

  const resumePptPipeline = async (pipelineId, action, editedContent = '', feedback = '') => {
    try {
      await fetch(`${WIKI_BASE}/ppt-pipeline/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline_id: pipelineId, action, edited_content: editedContent, feedback }),
      });
    } catch (err) {
      setIsTyping(false);
      setMessages(prev => [...prev, { type: 'assistant', content: `结构确认提交失败：${err.message}`, isStep: true }]);
    }
  };

  const fetchPptTasks = async () => {
    setPptTasksLoading(true);
    try {
      const res = await fetch(`${WIKI_BASE}/ppt-pipeline/tasks?limit=20`);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || '获取任务列表失败');
      setPptTasks(Array.isArray(data.data) ? data.data : []);
      setShowPptTaskModal(true);
    } catch (err) {
      setMessages(prev => [...prev, { type: 'assistant', content: `获取 PPT 任务失败：${err.message}`, isStep: true }]);
    } finally {
      setPptTasksLoading(false);
    }
  };

  const resumePersistedPptTask = async (task) => {
    const initSteps = [
      { id: 1, name: '意图分析', status: 'done' },
      { id: 2, name: '信息收集', status: 'done' },
      { id: 3, name: '结构规划', status: 'done' },
      { id: 4, name: '内容审核', status: task.resume_from === 'step4' ? 'done' : 'pending' },
      { id: 5, name: '渲染PPT', status: 'running' },
      { id: 6, name: '视觉审核', status: 'pending' },
    ];
    setShowPptTaskModal(false);
    setPipelineState({ running: true, steps: initSteps, logs: [], stepDetails: {}, result: null, error: null });
    setPipelineDetailsOpen(false);
    setMessages(prev => [...prev, { type: 'assistant', content: `继续 PPT 任务：${task.query || task.name || task.pipeline_id}`, isStep: true }]);

    const controller = new AbortController();
    pipelineAbortRef.current = controller;
    try {
      const res = await fetch(`${WIKI_BASE}/ppt-pipeline/resume-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_dir: task.task_dir, pipeline_id: task.pipeline_id, template: task.template || 'default' }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '未知错误');
        throw new Error(`后端返回 ${res.status}: ${errText.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            setPipelineState(prev => {
              if (!prev) return prev;
              const steps = [...prev.steps];
              const logs = [...prev.logs, evt];
              const stepDetails = { ...prev.stepDetails };
              if (typeof evt.step === 'number') {
                const idx = evt.step - 1;
                for (let i = 0; i < idx; i += 1) {
                  if (steps[i] && steps[i].status !== 'error') steps[i] = { ...steps[i], status: 'done' };
                }
                if (steps[idx]) {
                  const mappedStatus = evt.status === 'done' ? 'done'
                    : (evt.status === 'blocked' || evt.status === 'error') ? 'error'
                    : 'running';
                  steps[idx] = { ...steps[idx], status: mappedStatus };
                }
                if (evt.step === 6 && evt.status === 'done') {
                  return { ...prev, steps: steps.map(s => s.status === 'error' ? s : { ...s, status: 'done' }), logs, stepDetails, running: false, result: evt.data };
                }
                if (evt.step === 5 && evt.status === 'slide_preview' && evt.data) {
                  const preview = {
                    page_num: evt.data.page_num || evt.data.current_page,
                    title: evt.data.title || '',
                    filename: evt.data.filename || '',
                    filepath: evt.data.filepath || '',
                    svg: evt.data.svg || '',
                  };
                  const prevPreviews = stepDetails[5]?.slide_previews || [];
                  const nextPreviews = [
                    ...prevPreviews.filter(p => p.page_num !== preview.page_num),
                    preview,
                  ].sort((a, b) => (a.page_num || 0) - (b.page_num || 0));
                  stepDetails[5] = {
                    ...stepDetails[5],
                    ...evt.data,
                    slide_previews: nextPreviews,
                    message: evt.message,
                  };
                } else if ((evt.status === 'running' || evt.status === 'done' || evt.status === 'blocked' || evt.status === 'error') && evt.data) {
                  stepDetails[evt.step] = { ...stepDetails[evt.step], ...evt.data, message: evt.message };
                }
              }
              if (evt.step === 'error') {
                return { ...prev, logs, stepDetails, running: false, error: evt.message };
              }
              return { ...prev, steps, logs, stepDetails };
            });
            if (evt.step === 'error') {
              setMessages(prev => [...prev, { type: 'assistant', content: `继续 PPT 任务失败：${evt.message}`, isStep: true }]);
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setPipelineState(prev => prev ? { ...prev, running: false, error: err.message } : prev);
        setMessages(prev => [...prev, { type: 'assistant', content: `继续 PPT 任务出错：${err.message}`, isStep: true }]);
      }
    } finally {
      pipelineAbortRef.current = null;
    }
  };

  const buildPptReviewMessage = (evt) => {
    const stage = evt.data.stage || (evt.step === 1 ? 'intent' : evt.step === 4 ? 'content_review' : evt.step === 5 ? 'slide_review' : 'structure_review');
    return {
      id: `ppt-review-${evt.data.pipeline_id}-${stage}-${Date.now()}`,
      type: 'assistant',
      kind: 'ppt_review',
      content: evt.message || 'PPT 流程等待确认',
      review: {
        pipelineId: evt.data.pipeline_id,
        stage,
        step: evt.step,
        message: evt.message,
        intent: evt.data.intent,
        template: evt.data.template || 'default',
        templateOptions: evt.data.template_options || [],
        default_mode: evt.data.default_mode,
        default_visual_style: evt.data.default_visual_style,
        query: evt.data.query,
        outline: evt.data.outline || '',
        outputPath: evt.data.output_path,
        slides: evt.data.slides || [],
        slideCount: evt.data.slide_count,
        expectedSlides: evt.data.expected_slides,
        minRequiredSlides: evt.data.min_required_slides,
        pagePlans: evt.data.page_plans || [],
        typeCounts: evt.data.type_counts || {},
        sourceMarkerCount: evt.data.source_marker_count || 0,
        warnings: evt.data.warnings || [],
        selectedPageIndex: 0,
        round: evt.data.round,
        score: evt.data.score,
        issues: evt.data.issues || [],
        suggestions: evt.data.suggestions || [],
        action: evt.data.action,
        feedback: stage === 'intent'
          ? JSON.stringify(evt.data.intent || {}, null, 2)
          : (evt.data.outline || ''),
        userFeedback: '',
        submitted: false,
        submittedAction: '',
      },
    };
  };

  const updatePptReviewMessage = (messageId, updater) => {
    setMessages(prev => prev.map(msg => {
      if (msg.id !== messageId || msg.kind !== 'ppt_review') return msg;
      const nextReview = typeof updater === 'function' ? updater(msg.review) : { ...msg.review, ...updater };
      return { ...msg, review: nextReview };
    }));
  };

  const submitPptReviewMessage = (messageId, review, action, content = '') => {
    setIsTyping(action !== 'cancel');
    resumePptPipeline(review.pipelineId, action, content);
    setMessages(prev => prev.map(msg => (
      msg.id === messageId && msg.kind === 'ppt_review'
        ? { ...msg, review: { ...msg.review, submitted: true, submittedAction: action, submittedContent: content } }
        : msg
    )));
  };

  const buildIntentOptionsPayload = (extra = {}) => JSON.stringify({
    workflow_mode: pptWorkflowMode,
    template: pptTemplate,
    mode: pptMode,
    visual_style: pptTemplate === 'huawei_standard' ? 'huawei-corporate' : pptVisualStyle,
    content_format: pptContentFormat,
    ...extra,
  });

  const svgToPreviewSrc = (svg) => {
    if (!svg) return '';
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  const openPptPreviewModal = (previews, index) => {
    if (!Array.isArray(previews) || previews.length === 0) return;
    setPptPreviewModal({ previews, index: Math.max(0, Math.min(index, previews.length - 1)) });
  };

  const movePptPreviewModal = (delta) => {
    setPptPreviewModal(prev => {
      if (!prev?.previews?.length) return prev;
      const nextIndex = (prev.index + delta + prev.previews.length) % prev.previews.length;
      return { ...prev, index: nextIndex };
    });
  };

  const renderPptReviewCard = (msg) => {
    const review = msg.review || {};
    const disabled = !!review.submitted;
    const pages = (review.pagePlans?.length ? review.pagePlans : (review.slides || [])).slice(0, 40);
    const activeIndex = Math.min(Math.max(review.selectedPageIndex || 0, 0), Math.max(pages.length - 1, 0));
    const activePage = pages[activeIndex] || {};
    const activeType = activePage.type || activePage.slide_type || 'unknown';
    const activeBullets = activePage.bullets || [];
    const activeKpis = activePage.kpis || [];
    const activeSections = activePage.sections || [];
    const selectStructurePage = (index) => {
      if (disabled || !pages.length) return;
      const nextIndex = Math.min(Math.max(index, 0), pages.length - 1);
      updatePptReviewMessage(msg.id, prev => ({ ...prev, selectedPageIndex: nextIndex }));
    };
    const handleStructurePageKeyDown = (e) => {
      if (disabled || !pages.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectStructurePage(activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectStructurePage(activeIndex - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        selectStructurePage(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        selectStructurePage(pages.length - 1);
      }
    };
    const title = review.stage === 'content_review' ? '内容审核确认'
      : review.stage === 'intent' ? '意图分析确认'
      : review.stage === 'slide_review' ? '幻灯片审核'
      : '结构规划确认';
    const actionLabelMap = {
      cancel: '取消',
      continue: '继续',
      reanalyze: '补充意见重分析',
      edit: '按意见修改',
      regenerate: '按意见重生成',
      smart_replan: '按意见调整',
      search_replan: '搜索补充后重新审核',
      direct_edit: '直接采用编辑',
    };

    if (disabled) {
      let selectedSummary = '';
      if (review.stage === 'intent' && review.submittedAction === 'continue') {
        try {
          const opts = JSON.parse(review.submittedContent || '{}');
          const modeLabel = opts.workflow_mode === 'manual' ? '人工确认' : '自动完成';
          const cmLabel = opts.mode === 'narrative' ? '故事' : opts.mode === 'briefing' ? '简报' : '结论先行';
          const VS_LABELS = { 'swiss-minimal': '极简', 'huawei-corporate': '华为企业', 'soft-rounded': '圆角', 'editorial': '编辑', 'dark-tech': '暗色科技', 'glassmorphism': '毛玻璃', 'blueprint': '蓝图', 'sketch-notes': '手绘', 'ink-notes': '墨水', 'chalkboard': '黑板', 'ink-wash': '水墨' };
          const vsLabel = opts.template === 'huawei_standard'
            ? '华为 16:9（品牌模板）'
            : (VS_LABELS[opts.visual_style] || '暗色科技');
          const densityLabel = opts.content_format === 'concise' ? '精简' : opts.content_format === 'bullet' ? '要点' : '详细';
          selectedSummary = `模式：${modeLabel}；叙事：${cmLabel}；风格：${vsLabel}；密度：${densityLabel}`;
        } catch (_) {
          selectedSummary = review.submittedContent || '';
        }
      } else if (review.stage === 'structure_review') {
        selectedSummary = `目标 ${review.expectedSlides || '-'} 页，当前 ${review.slideCount || '-'} 页，来源标记 ${review.sourceMarkerCount || 0} 条`;
      } else if (review.stage === 'content_review') {
        selectedSummary = `第 ${review.round || '-'} 轮审核，得分 ${review.score ?? '-'} 分`;
      } else if (review.stage === 'slide_review') {
        selectedSummary = review.outputPath ? `输出：${review.outputPath.split(/[/\\]/).pop()}` : '';
      }
      const feedbackSummary = (review.submittedContent || '').trim();
      const showFeedback = feedbackSummary && review.submittedAction !== 'continue';
      return (
        <div className={`w-full rounded-lg border px-4 py-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/80' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-100' : 'text-gray-900'}`}>
                {title}已提交
              </div>
              <div className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                操作：{actionLabelMap[review.submittedAction] || review.submittedAction || '-'}
                {selectedSummary ? ` | ${selectedSummary}` : ''}
              </div>
              {showFeedback && (
                <div className={`mt-2 rounded-md px-3 py-2 text-xs line-clamp-3 ${theme === 'dark' ? 'bg-gray-900 text-gray-300' : 'bg-gray-50 text-gray-600'}`}>
                  意见：{feedbackSummary}
                </div>
              )}
            </div>
            <span className={`shrink-0 text-xs px-2 py-1 rounded ${theme === 'dark' ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
              已继续
            </span>
          </div>
        </div>
      );
    }

    const buttonBase = `px-3 py-2 rounded-md text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed`;
    const neutralButton = `${buttonBase} ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`;
    const primaryButton = `${buttonBase} text-white ${theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-500 hover:bg-indigo-600'}`;

    const submitContinue = () => {
      if (review.stage === 'structure_review' && (review.userFeedback || '').trim()) {
        const shouldContinue = window.confirm('意见栏还有未提交的内容。继续将忽略这些意见并进入下一步，是否继续？');
        if (!shouldContinue) return;
      }
      if (review.stage === 'intent') {
        const intentOptions = buildIntentOptionsPayload();
        submitPptReviewMessage(msg.id, review, 'continue', intentOptions);
        writeMemoryFile({ pptSettings: { workflowMode: pptWorkflowMode, template: pptTemplate, mode: pptMode, visualStyle: pptVisualStyle, contentFormat: pptContentFormat } });
      } else {
        submitPptReviewMessage(msg.id, review, 'continue');
      }
    };

    const submitSmartContinue = () => {
      const feedback = (review.userFeedback || '').trim();
      if (!feedback) {
        submitContinue();
        return;
      }

      if (review.stage === 'intent') {
        const intentOptions = buildIntentOptionsPayload({ feedback });
        submitPptReviewMessage(msg.id, review, 'reanalyze', intentOptions);
        writeMemoryFile({ pptSettings: { workflowMode: pptWorkflowMode, template: pptTemplate, mode: pptMode, visualStyle: pptVisualStyle, contentFormat: pptContentFormat } });
      } else if (review.stage === 'structure_review') {
        submitPptReviewMessage(msg.id, review, 'smart_replan', feedback);
      } else if (review.stage === 'content_review') {
        const needsSearch = /搜索|联网|补充|资料|来源|引用|最新|对比|竞品|数据|事实|查找|缺少|缺乏/i.test(feedback);
        submitPptReviewMessage(msg.id, review, needsSearch ? 'search_replan' : 'edit', feedback);
      } else if (review.stage === 'slide_review') {
        submitPptReviewMessage(msg.id, review, 'regenerate', feedback);
      } else {
        submitPptReviewMessage(msg.id, review, 'edit', feedback);
      }
    };

    return (
      <div className={`w-full rounded-lg border overflow-hidden ${theme === 'dark' ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        <div className={`px-4 py-3 border-b ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className={`text-sm font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>{title}</div>
              <div className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                {review.stage === 'content_review'
                  ? `第 ${review.round || '-'} 轮审核：${review.score ?? '-'} 分，建议动作：${review.action || '-'}`
                  : review.stage === 'intent'
                    ? '请确认生成模式、风格和内容密度'
                    : `目标 ${review.expectedSlides || '-'} 页，最低 ${review.minRequiredSlides || '-'} 页，当前 ${review.slideCount || '-'} 页，来源标记 ${review.sourceMarkerCount || 0} 条`}
              </div>
            </div>
            {disabled && (
              <span className={`text-xs px-2 py-1 rounded ${theme === 'dark' ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                已提交：{review.submittedAction}
              </span>
            )}
          </div>
        </div>

        <div className="p-4 space-y-3">
          {review.stage === 'content_review' && review.issues?.length > 0 && (
            <div className={`rounded-lg p-3 text-xs space-y-1 ${theme === 'dark' ? 'bg-red-900/20 text-red-200' : 'bg-red-50 text-red-700'}`}>
              <div className="font-semibold">发现的问题：</div>
              {review.issues.map((issue, i) => <div key={i}>- {issue}</div>)}
            </div>
          )}
          {review.stage === 'content_review' && review.suggestions?.length > 0 && (
            <div className={`rounded-lg p-3 text-xs space-y-1 ${theme === 'dark' ? 'bg-blue-900/20 text-blue-200' : 'bg-blue-50 text-blue-700'}`}>
              <div className="font-semibold">改进建议：</div>
              {review.suggestions.map((s, i) => <div key={i}>- {s}</div>)}
            </div>
          )}
          {review.stage !== 'content_review' && Object.keys(review.typeCounts || {}).length > 0 && (
            <div className={`text-xs ${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
              页型分布：{Object.entries(review.typeCounts).map(([k, v]) => `${k}:${v}`).join(' / ')}
            </div>
          )}
          {review.warnings?.length > 0 && (
            <div className={`rounded-lg p-3 text-xs ${theme === 'dark' ? 'bg-yellow-900/20 text-yellow-200' : 'bg-yellow-50 text-yellow-700'}`}>
              结构风险：{review.warnings.join('；')}
            </div>
          )}

          {review.stage === 'intent' ? (() => {
            const MODE_OPTIONS = PPT_MODES;
            const STYLE_OPTIONS = PPT_STYLES;
            const dropdownClass = `w-full px-3 py-1.5 rounded-md text-xs border outline-none transition-all disabled:opacity-50 appearance-none ${theme === 'dark' ? 'bg-gray-800 border-gray-600 text-gray-200 focus:border-indigo-500' : theme === 'light' ? 'bg-white border-gray-200 text-gray-700 focus:border-indigo-400' : 'bg-gray-700 border-gray-500 text-gray-200 focus:border-indigo-500'}`;

            return (
            <>
              <pre className={`w-full max-h-64 p-3 rounded-lg border text-xs leading-5 overflow-auto font-mono whitespace-pre-wrap ${theme === 'dark' ? 'bg-gray-900 border-gray-700 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>
                {JSON.stringify(review.intent || {}, null, 2)}
              </pre>
              <div className={`rounded-lg border p-3 space-y-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
                {/* 工作模式 */}
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                  <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>工作模式</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[{ value: 'auto', label: '自动完成' }, { value: 'manual', label: '人工确认' }].map(o => {
                      const active = pptWorkflowMode === o.value;
                      return <button key={o.value} type="button" disabled={disabled} onClick={() => setPptWorkflowMode(o.value)} className={`px-3 py-2 rounded-md text-xs font-medium border transition-all disabled:opacity-50 ${active ? theme === 'dark' ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-indigo-500 bg-indigo-50 text-indigo-700' : theme === 'dark' ? 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>{o.label}</button>;
                    })}
                  </div>
                </div>
                {/* 内容密度 */}
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                  <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>内容密度</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[{ value: 'detailed', label: '详细' }, { value: 'concise', label: '精简' }, { value: 'bullet', label: '要点' }].map(o => {
                      const active = pptContentFormat === o.value;
                      return <button key={o.value} type="button" disabled={disabled} onClick={() => setPptContentFormat(o.value)} className={`px-3 py-2 rounded-md text-xs font-medium border transition-all disabled:opacity-50 ${active ? theme === 'dark' ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-indigo-500 bg-indigo-50 text-indigo-700' : theme === 'dark' ? 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>{o.label}</button>;
                    })}
                  </div>
                </div>
                {/* 沟通模式 */}
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                  <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>沟通模式</div>
                  <div>
                    <select value={pptMode} onChange={e => setPptMode(e.target.value)} disabled={disabled} className={dropdownClass}>
                      {MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>
                {/* 视觉风格 */}
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 items-center">
                  <div className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>视觉风格</div>
                  <div>
                    <select
                      value={pptTemplate === 'huawei_standard' ? 'huawei_standard' : pptVisualStyle}
                      onChange={e => {
                        const value = e.target.value;
                        if (value === 'huawei_standard') {
                          setPptTemplate('huawei_standard');
                          setPptVisualStyle('huawei-corporate');
                        } else {
                          setPptTemplate('default');
                          setPptVisualStyle(value);
                        }
                      }}
                      disabled={disabled}
                      className={dropdownClass}
                    >
                      {STYLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      <option value="huawei_standard">华为 16:9（品牌模板）</option>
                    </select>
                  </div>
                </div>
              </div>
            </>
          )})() : review.stage === 'structure_review' ? (
            <div className="grid grid-cols-[minmax(220px,320px)_minmax(0,1fr)] gap-4 h-[520px] min-h-0">
              <div className={`rounded-lg border overflow-hidden min-h-0 flex flex-col ${theme === 'dark' ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
                <div className={`px-3 py-2 text-xs font-semibold border-b ${theme === 'dark' ? 'border-gray-700 text-gray-300' : 'border-gray-200 text-gray-600'}`}>
                  页面列表 ({pages.length})
                </div>
                <div
                  className={`flex-1 min-h-0 overflow-auto outline-none focus:ring-2 focus:ring-inset ${theme === 'dark' ? 'focus:ring-indigo-500/60' : 'focus:ring-indigo-400/60'}`}
                  tabIndex={disabled ? -1 : 0}
                  role="listbox"
                  aria-label="PPT 页面列表"
                  onKeyDown={handleStructurePageKeyDown}
                >
                  {pages.map((page, idx) => {
                    const selected = idx === activeIndex;
                    const type = page.type || page.slide_type || 'unknown';
                    const hasRisk = (page.source_count || 0) === 0 || (page.bullets || []).length === 0;
                    return (
                      <button
                        key={idx}
                        disabled={disabled}
                        onClick={() => selectStructurePage(idx)}
                        onFocus={() => selectStructurePage(idx)}
                        role="option"
                        aria-selected={selected}
                        className={`w-full text-left px-3 py-2.5 border-b transition-all disabled:opacity-70 ${theme === 'dark' ? 'border-gray-800' : 'border-gray-200'} ${selected
                          ? theme === 'dark' ? 'bg-indigo-600/25' : 'bg-indigo-50'
                          : theme === 'dark' ? 'hover:bg-gray-800' : 'hover:bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] flex-shrink-0 ${selected ? 'bg-indigo-600 text-white' : theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>{idx + 1}</span>
                          <span className={`text-sm font-medium truncate ${theme === 'dark' ? 'text-gray-100' : 'text-gray-800'}`}>{page.title || `第 ${idx + 1} 页`}</span>
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
                    <h4 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>{activePage.title || '未命名页面'}</h4>
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

                <div className="mt-4">
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
                  <div className={`hidden rounded-lg p-3 ${theme === 'dark' ? 'bg-gray-800/70' : 'bg-gray-50'}`}>
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

                {review.outline && (
                  <details className="mt-4">
                    <summary className={`text-xs cursor-pointer ${theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-600'}`}>查看完整大纲文本</summary>
                    <pre className={`mt-2 w-full p-4 rounded-lg border text-xs leading-5 overflow-auto font-mono whitespace-pre-wrap ${theme === 'dark' ? 'bg-gray-950 border-gray-700 text-gray-200' : 'bg-white border-gray-200 text-gray-700'}`}>{review.outline}</pre>
                  </details>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                {pages.map((page, idx) => (
                  <div key={idx} className={`rounded-lg px-3 py-2 ${theme === 'dark' ? 'bg-gray-900/70' : 'bg-gray-50'}`}>
                    <div className={`text-sm font-medium flex items-center gap-2 ${theme === 'dark' ? 'text-gray-100' : 'text-gray-800'}`}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${theme === 'dark' ? 'bg-indigo-700 text-indigo-100' : 'bg-indigo-100 text-indigo-700'}`}>{idx + 1}</span>
                      <span className="truncate">{page.title || `第 ${idx + 1} 页`}</span>
                      {(page.type || page.slide_type) && <span className={`text-[10px] px-1.5 py-0.5 rounded ${theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>{page.type || page.slide_type}</span>}
                    </div>
                    {page.bullets?.length > 0 && <div className={`mt-1 ml-7 text-[11px] truncate ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>{page.bullets.slice(0, 2).join('；')}</div>}
                  </div>
                ))}
              </div>
              {review.outline && (
                <details className="mt-2">
                  <summary className={`text-xs cursor-pointer ${theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-600'}`}>展开查看完整大纲文本</summary>
                  <pre className={`mt-2 w-full max-h-80 p-4 rounded-lg border text-xs leading-5 overflow-auto font-mono whitespace-pre-wrap ${theme === 'dark' ? 'bg-gray-900 border-gray-700 text-gray-200' : 'bg-white border-gray-200 text-gray-700'}`}>{review.outline}</pre>
                </details>
              )}
            </>
          )}

          <div className={`border-t pt-3 mt-3 ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
            <label className={`block text-xs font-semibold mb-1.5 ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}`}>
              {review.stage === 'content_review' ? '输入审核意见' : review.stage === 'intent' ? '输入补充意见' : '输入优化意见'}
              <span className={`font-normal ml-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>(可选)</span>
            </label>
            <textarea
              disabled={disabled}
              value={review.userFeedback || ''}
              onChange={(e) => updatePptReviewMessage(msg.id, prev => ({ ...prev, userFeedback: e.target.value }))}
              placeholder={review.stage === 'content_review'
                ? '例如：数据来源不够充分、缺少竞品对比页、技术深度不足...'
                : review.stage === 'intent'
                  ? '例如：增加对推理加速的关注、受众是技术管理者、控制在 12 页以内...'
                  : review.stage === 'structure_review'
                    ? '例如：第 5 页补充性能对比；第 8 页拆成两页；整体减少背景介绍...'
                    : '例如：增加评测对比页、减少目录页、加强风险和部署部分...'}
              rows={review.stage === 'structure_review' ? 2 : 3}
              className={`w-full p-3 rounded-lg border text-sm leading-6 ${review.stage === 'structure_review' ? 'resize-none' : 'resize-y'} outline-none disabled:opacity-70 ${theme === 'dark' ? 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500 focus:border-indigo-400' : 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400 focus:border-indigo-500'}`}
            />
          </div>
        </div>

        <div className={`px-4 py-3 border-t flex justify-end gap-2 flex-wrap ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
          <button disabled={disabled} onClick={() => submitPptReviewMessage(msg.id, review, 'cancel')} className={neutralButton}>取消</button>
          {false && review.stage !== 'intent' && (
          <button
            disabled={disabled}
            onClick={() => {
              const action = review.stage === 'intent' ? 'reanalyze'
                : review.stage === 'content_review' ? 'edit'
                : review.stage === 'slide_review' ? 'regenerate'
                : review.stage === 'structure_review' ? 'smart_replan' : 'edit';
              const content = review.userFeedback || review.feedback || '';
              submitPptReviewMessage(msg.id, review, action, content);
            }}
            className={neutralButton}
          >
            {review.stage === 'structure_review' ? '按意见调整' : review.stage === 'intent' ? '补充意见重分析' : review.stage === 'content_review' ? '按意见修改大纲' : review.stage === 'slide_review' ? '按意见重生成' : '按意见重规划'}
          </button>
          )}
          {false && review.stage === 'content_review' && (
            <button disabled={disabled} onClick={() => submitPptReviewMessage(msg.id, review, 'search_replan', review.userFeedback || '')} className={neutralButton}>搜索补充后重新审核</button>
          )}
          {false && review.stage !== 'intent' && review.stage !== 'content_review' && review.stage !== 'structure_review' && (
            <button disabled={disabled} onClick={() => submitPptReviewMessage(msg.id, review, 'direct_edit', review.outline || review.feedback || '')} className={neutralButton}>直接采用编辑</button>
          )}
          <button disabled={disabled} onClick={submitSmartContinue} className={primaryButton}>继续</button>
        </div>
      </div>
    );
  };

  return {
    runPptPipeline, resumePptPipeline, fetchPptTasks, resumePersistedPptTask,
    buildPptReviewMessage, updatePptReviewMessage, submitPptReviewMessage,
    buildIntentOptionsPayload, svgToPreviewSrc, openPptPreviewModal, movePptPreviewModal,
    renderPptReviewCard,
  };
}
