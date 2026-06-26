import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Loader2, CheckCircle2, XCircle, ChevronDown, ListTodo, FileText, Clock, Activity, AlertCircle, Zap, Bot, Wrench, RefreshCw } from 'lucide-react';

const STATUS_ICONS = {
  running: <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />,
  completed: <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />,
  failed: <XCircle className="w-3.5 h-3.5 text-red-400" />,
  cancelled: <XCircle className="w-3.5 h-3.5 text-gray-400" />,
};

const STATUS_COLORS = {
  running: { dot: 'bg-blue-400', text: 'text-blue-400' },
  completed: { dot: 'bg-green-400', text: 'text-green-400' },
  failed: { dot: 'bg-red-400', text: 'text-red-400' },
  cancelled: { dot: 'bg-gray-400', text: 'text-gray-400' },
};

const MAX_DONE_VISIBLE = 3;
const LONG_TASK_THRESHOLD = 3000; // 3秒后才显示宠物

/**
 * 右下角后台任务列表面板
 * - 折叠时仅显示图标 + 运行中任务数量角标
 * - 展开后显示：所有运行中任务 + 最近 3 个已完成任务
 * - 任务运行超过 3 秒时，上方显示小精灵宠物在书架间徘徊的动画
 * - 宠物等级基于知识库数量自动提升（每 3 个升一级，最高 Lv.10）
 */
function TaskPanel({ tasks, onCancel, onClearCompleted, theme = 'dark', kbCount = 0 }) {
  const [collapsed, setCollapsed] = useState(true);
  const [visible, setVisible] = useState(false);
  // 每秒更新一次，用于驱动倒计时刷新
  const [tick, setTick] = useState(Date.now());

  // 面板高度拖拽调整
  const [panelHeight, setPanelHeight] = useState(520); // 默认高度
  const panelRef = useRef(null);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);

  // 拖拽手柄事件
  const handleDragStart = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY || e.touches?.[0]?.clientY || 0;
    dragStartH.current = panelHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  }, [panelHeight]);

  useEffect(() => {
    const onMove = (e) => {
      if (!isDragging.current) return;
      const clientY = e.clientY || e.touches?.[0]?.clientY || 0;
      const dy = dragStartY.current - clientY;
      const newH = Math.max(280, Math.min(dragStartH.current + dy, window.innerHeight - 100));
      setPanelHeight(newH);
    };
    const onUp = () => {
      isDragging.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, []);

  // Chrys 日志查看器状态
  const [logViewerTask, setLogViewerTask] = useState(null);
  const [logData, setLogData] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logTab, setLogTab] = useState('overview'); // 'overview' | 'traces' | 'logs'
  const [selectedTrace, setSelectedTrace] = useState(null);

  // 获取 chrys 日志（可复用于初始加载和刷新）
  const fetchLogs = useCallback(async (task) => {
    try {
      const { ipcRenderer } = window.require('electron');
      const data = await ipcRenderer.invoke('read-chrys-session-logs', task.metadata.sessionId);
      setLogViewerTask(task);
      setLogData(data);
      return data;
    } catch (e) {
      const errData = { error: e.message, found: false };
      setLogData(errData);
      return errData;
    }
  }, []);

  // 打开 Chrys 日志查看器
  const openLogViewer = useCallback(async (task) => {
    setLogLoading(true);
    setLogTab('overview');
    setSelectedTrace(null);
    await fetchLogs(task);
    setLogLoading(false);
  }, [fetchLogs]);

  // 自动刷新（chrys 运行中时每 3 秒拉一次；结束后额外拉两次确认完整性）
  useEffect(() => {
    if (!logViewerTask) return;

    let stopped = false;
    let retriesAfterEnd = 2; // 进程结束后再拉 2 次

    const doPoll = async () => {
      if (stopped) return;
      const data = await fetchLogs(logViewerTask);
      if (stopped) return;

      if (data.running) {
        // 仍在运行：每 3 秒继续
        if (!stopped) setTimeout(doPoll, 3000);
      } else if (retriesAfterEnd > 0) {
        // 已结束：延迟 2 秒后额外拉取，确保日志已写入磁盘
        retriesAfterEnd--;
        if (!stopped) setTimeout(doPoll, 2000);
      }
    };

    // 首次延迟 2 秒
    const initialTimer = setTimeout(doPoll, 2000);

    return () => {
      stopped = true;
      clearTimeout(initialTimer);
    };
  }, [logViewerTask, fetchLogs]);

  const closeLogViewer = useCallback(() => {
    setLogViewerTask(null);
    setLogData(null);
    setSelectedTrace(null);
  }, []);

  // 每秒刷新 tick 以驱动倒计时
  useEffect(() => {
    const running = tasks.some(t => t.status === 'running' && t.deadline);
    if (!running) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tasks]);

  // 格式化剩余时间
  const formatRemaining = (deadline) => {
    const remain = deadline - tick;
    if (remain <= 0) return '超时';
    const s = Math.ceil(remain / 1000);
    if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
    return `${s}s`;
  };

  const runningTasks = useMemo(() => tasks.filter(t => t.status === 'running'), [tasks]);
  const doneTasks = useMemo(() => tasks.filter(t => t.status !== 'running'), [tasks]);

  // 宠物等级：基于知识库数量，每 3 个知识库升一级，最高 Lv.10
  const librarianLevel = useMemo(() => Math.max(1, Math.min(10, Math.floor(kbCount / 3) + 1)), [kbCount]);

  // SVG gradient ID 前缀，避免多实例 namespace 冲突
  const svgId = useRef(`tp-${Math.random().toString(36).slice(2, 8)}`).current;

  // 宠物状态: 'hidden' | 'pushing' | 'resting'
  const [petState, setPetState] = useState('hidden');
  const [restMessage, setRestMessage] = useState('');
  const petTimerRef = useRef(null);
  const petCycleStartedRef = useRef(false);

  // 休息时的随机提示消息池
  const restMessages = useRef([
    '任务执行中，请稍候，我正在为您加速...',
    '数据计算中，马上就好...',
    '信息检索中，请稍等片刻...',
    '正在为您分析信息，请稍候...',
    '处理中，喝杯水休息一下吧...',
    '为您提供最佳结果，请稍候...',
    '整理思路中，结果马上出来...',
    '正在为您全力奔跑中...',
    '我已经在超频运作了，请再等一下...',
  ]);

  const clearPetTimer = useCallback(() => {
    if (petTimerRef.current !== null) {
      clearTimeout(petTimerRef.current);
      petTimerRef.current = null;
    }
    petCycleStartedRef.current = false;
  }, []);

  // 启动宠物推石头 → 休息 → 继续的循环
  const startPetCycle = useCallback(() => {
    clearPetTimer();
    petCycleStartedRef.current = true;
    setPetState('pushing');

    // 随机 3~30 秒后进入休息状态
    const restDelay = 3000 + Math.random() * 27000;
    petTimerRef.current = setTimeout(() => {
      setPetState('resting');
      // 随机选取一条提示消息
      const pool = restMessages.current;
      setRestMessage(pool[Math.floor(Math.random() * pool.length)]);

      // 休息 1.5~3 秒后恢复推石头
      const resumeDelay = 1500 + Math.random() * 1500;
      petTimerRef.current = setTimeout(() => {
        startPetCycle();
      }, resumeDelay);
    }, restDelay);
  }, [clearPetTimer]);

  // 检测是否有任务运行超过阈值，并管理宠物显隐
  useEffect(() => {
    if (collapsed || runningTasks.length === 0) {
      setPetState('hidden');
      clearPetTimer();
      return;
    }

    const checkAndMaybeStart = () => {
      const hasLongTask = runningTasks.some(t => Date.now() - t.startTime > LONG_TASK_THRESHOLD);
      if (hasLongTask && !petCycleStartedRef.current) {
        startPetCycle();
      }
    };

    checkAndMaybeStart();
    const checkInterval = setInterval(checkAndMaybeStart, 1000);

    // 注意：此处不清除 petTimer，避免 runningTasks 数量变化时打断正在运行的动画循环
    return () => clearInterval(checkInterval);
  }, [collapsed, runningTasks.length]);

  // 保留所有运行中任务 + 最近的 3 个终态任务（按完成时间排序，最新的在前）
  const displayTasks = useMemo(() => {
    if (collapsed) return tasks;
    // 按完成时间降序排列终态任务（无 completedAt 的回退到 startTime）
    const sortedDone = [...doneTasks].sort((a, b) => (b.completedAt || b.startTime) - (a.completedAt || a.startTime));
    const recentDone = sortedDone.slice(0, MAX_DONE_VISIBLE);
    const sortedRunning = [...runningTasks].reverse();
    return [...sortedRunning, ...recentDone];
  }, [tasks, runningTasks, doneTasks, collapsed]);

  // 有运行中任务时自动展开
  useEffect(() => {
    if (runningTasks.length > 0) {
      setVisible(true);
      setCollapsed(false);
    }
  }, [runningTasks.length]);

  // 所有任务都终态后，延迟 8 秒自动折叠；任务被清空则立即折叠
  useEffect(() => {
    if (tasks.length > 0 && tasks.every(t => t.status !== 'running') && visible) {
      const timer = setTimeout(() => setCollapsed(true), 8000);
      return () => clearTimeout(timer);
    }
    if (tasks.length === 0 && visible) {
      const timer = setTimeout(() => {
        setCollapsed(true);
        const hideTimer = setTimeout(() => setVisible(false), 3000);
        return () => clearTimeout(hideTimer);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [tasks, visible]);

  // 无任务时完全隐藏
  if (tasks.length === 0 && !visible) return null;

  const isDark = theme === 'dark';
  const bg = isDark ? 'bg-gray-800/95' : 'bg-white/95';
  const border = isDark ? 'border-gray-600' : 'border-gray-200';
  const textSecondary = isDark ? 'text-gray-400' : 'text-gray-500';
  const textPrimary = isDark ? 'text-gray-200' : 'text-gray-700';
  const hoverBg = isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100';

  // 计算未读的已完成任务数（自上次折叠以来的新增终态任务）
  const totalRunning = runningTasks.length;

  // 折叠状态：仅显示小图标按钮
  if (collapsed) {
    // 无任务时不显示
    if (!visible && tasks.length === 0) return null;

    return (
      <button
        onClick={() => setCollapsed(false)}
        className={`fixed bottom-4 right-4 z-50 w-10 h-10 rounded-full flex items-center justify-center shadow-lg border transition-all hover:scale-110 ${bg} ${border}`}
        title="后台任务"
      >
        <ListTodo className={`w-5 h-5 ${textSecondary}`} />
        {totalRunning > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center">
            {totalRunning}
          </span>
        )}
        {totalRunning === 0 && doneTasks.length > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
            <CheckCircle2 className="w-2.5 h-2.5 text-white" />
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className={`fixed bottom-4 right-4 z-50 w-80 flex flex-col rounded-xl shadow-2xl border ${bg} ${border}`}
      style={{ height: panelHeight }}
    >
      {/* 拖拽调整高度手柄 */}
      <div
        className="absolute -top-1 left-2 right-2 h-3 cursor-ns-resize flex items-center justify-center group"
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
      >
        <div className="w-8 h-1 rounded-full bg-gray-500/40 group-hover:bg-gray-400/60 transition-colors" />
      </div>      {/* 动画关键帧 - 始终注入，避免条件渲染反复销毁重建 */}
      <style>{`
        @keyframes librarianSearch {
          0%   { transform: translateX(0px); }
          30%  { transform: translateX(28px); }
          48%  { transform: translateX(28px); }
          52%  { transform: translateX(28px) scaleX(-1); }
          82%  { transform: translateX(-28px) scaleX(-1); }
          88%  { transform: translateX(-28px) scaleX(-1); }
          96%  { transform: translateX(0px) scaleX(-1); }
          100% { transform: translateX(0px) scaleX(1); }
        }
        @keyframes librarianBounce {
          0%, 100% { transform: translateY(0); }
          30%      { transform: translateY(-4px); }
          70%      { transform: translateY(1px); }
        }
        @keyframes sweatFloat {
          0%, 100% { opacity: 0; transform: translateY(0); }
          30%      { opacity: 1; transform: translateY(-10px); }
          60%      { opacity: 1; transform: translateY(-10px); }
        }
        @keyframes bookFloat {
          0%, 100% { opacity: 0.4; transform: translateY(3px) scale(0.9); }
          50%      { opacity: 0.8; transform: translateY(0px) scale(1); }
        }
        @keyframes wingFlap {
          0%, 100% { transform: scaleY(1) rotate(0deg); }
          30%      { transform: scaleY(0.6) rotate(3deg); }
          60%      { transform: scaleY(1.1) rotate(-2deg); }
        }
        @keyframes sparkleFloat {
          0%, 100% { opacity: 0; transform: translateY(0) scale(0.5); }
          50%      { opacity: 1; transform: translateY(-12px) scale(1); }
        }
        @keyframes earWiggle {
          0%, 100% { transform: rotate(0deg); }
          25%      { transform: rotate(-8deg); }
          75%      { transform: rotate(8deg); }
        }
      `}</style>
      {/* 小精灵在银河间徘徊 - 在任务列表上方 */}
      {petState !== 'hidden' && (
        <div className="relative w-full select-none overflow-hidden" style={{ height: '66px', background: 'linear-gradient(180deg, #0a0a2e 0%, #0d1030 30%, #151840 60%, #1a1d4a 100%)' }}>

          {/* 银河背景 SVG */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 320 66" preserveAspectRatio="none">
            <defs>
              <radialGradient id={`${svgId}-starGlow`} cx="0.5" cy="0.5" r="0.5">
                <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
            </defs>
            {/* 散布的星星 */}
            {[[8,5,0.8],[22,12,1.2],[38,3,0.7],[55,16,1],[72,6,0.6],[90,20,0.9],[108,8,1.1],[125,2,0.5],[140,14,0.8],[158,7,1.3],[175,18,0.6],[192,4,0.9],[210,11,0.7],[228,19,1],[245,7,0.5],[260,15,0.8],[278,5,1.1],[295,13,0.6]].map(([cx,cy,r],i) => (
              <circle key={`s-${i}`} cx={cx} cy={cy} r={r} fill="white" opacity={[0.5,0.7,0.4,0.9,0.6,0.3,0.8,0.5,0.7,0.4,0.6,1,0.5,0.7,0.3,0.8,0.6,0.4][i]} />
            ))}
            {/* 银河光带 */}
            <ellipse cx="160" cy="22" rx="180" ry="18" fill="rgba(100,120,255,0.06)" />
            <ellipse cx="120" cy="18" rx="120" ry="10" fill="rgba(150,130,255,0.05)" />
            <ellipse cx="200" cy="28" rx="100" ry="8" fill="rgba(130,150,255,0.04)" />
          </svg>

          {/* 左侧星球 + 书本 */}
          <div className="absolute left-1 bottom-0 flex flex-col items-center" style={{ animation: 'bookFloat 4s ease-in-out infinite' }}>
            {/* 小书本在星球上方 */}
            <span className="text-[9px] leading-none pointer-events-none mb-0.5">📖</span>
            {/* 星球 */}
            <svg width="36" height="36" viewBox="0 0 40 40">
              <defs>
                <radialGradient id={`${svgId}-planet1`} cx="0.35" cy="0.3" r="0.6">
                  <stop offset="0%" stopColor="#a7c7e7" />
                  <stop offset="70%" stopColor="#5b8ec4" />
                  <stop offset="100%" stopColor="#2d5a8e" />
                </radialGradient>
              </defs>
              <circle cx="20" cy="22" r="16" fill={`url(#${svgId}-planet1)`} />
              {/* 环形山 */}
              <circle cx="12" cy="16" r="3.5" fill="rgba(0,0,0,0.12)" />
              <circle cx="26" cy="28" r="2.5" fill="rgba(0,0,0,0.1)" />
              <circle cx="16" cy="30" r="2" fill="rgba(0,0,0,0.08)" />
            </svg>
          </div>

          {/* 中间星球 + 书本堆 */}
          <div className="absolute left-[30%] bottom-0 flex flex-col items-center" style={{ animation: 'bookFloat 5s ease-in-out 1.5s infinite' }}>
            <span className="text-[11px] leading-none pointer-events-none mb-0.5">📚</span>
            <svg width="44" height="44" viewBox="0 0 48 48">
              <defs>
                <radialGradient id={`${svgId}-planet2`} cx="0.4" cy="0.3" r="0.6">
                  <stop offset="0%" stopColor="#e8c0a0" />
                  <stop offset="70%" stopColor="#c47a5a" />
                  <stop offset="100%" stopColor="#8b5a3c" />
                </radialGradient>
                {/* 土星环 */}
                <linearGradient id={`${svgId}-ring`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="rgba(210,180,140,0)" />
                  <stop offset="20%" stopColor="rgba(210,180,140,0.15)" />
                  <stop offset="50%" stopColor="rgba(210,180,140,0.5)" />
                  <stop offset="80%" stopColor="rgba(210,180,140,0.15)" />
                  <stop offset="100%" stopColor="rgba(210,180,140,0)" />
                </linearGradient>
              </defs>
              {/* 土星环 */}
              <ellipse cx="24" cy="24" rx="22" ry="6" fill="none" stroke={`url(#${svgId}-ring)`} strokeWidth="3" transform="rotate(-15, 24, 24)" />
              <circle cx="24" cy="24" r="14" fill={`url(#${svgId}-planet2)`} />
              <circle cx="18" cy="20" r="3" fill="rgba(0,0,0,0.08)" />
              <circle cx="28" cy="30" r="2" fill="rgba(0,0,0,0.06)" />
            </svg>
          </div>

          {/* 右侧星球 + 书本 */}
          <div className="absolute right-2 bottom-0 flex flex-col items-center" style={{ animation: 'bookFloat 3.5s ease-in-out 1s infinite' }}>
            <span className="text-[10px] leading-none pointer-events-none mb-0.5">📕</span>
            <svg width="30" height="30" viewBox="0 0 34 34">
              <defs>
                <radialGradient id={`${svgId}-planet3`} cx="0.35" cy="0.3" r="0.6">
                  <stop offset="0%" stopColor="#c9b8f4" />
                  <stop offset="70%" stopColor="#7b5ea7" />
                  <stop offset="100%" stopColor="#4a3070" />
                </radialGradient>
              </defs>
              <circle cx="17" cy="19" r="13" fill={`url(#${svgId}-planet3)`} />
              <circle cx="10" cy="14" r="2.5" fill="rgba(0,0,0,0.1)" />
              <circle cx="22" cy="23" r="2" fill="rgba(0,0,0,0.08)" />
            </svg>
          </div>

          {/* 宠物角色容器 */}
          <div
            className="absolute bottom-0 flex flex-col items-center"
            style={{
              left: '50%',
              transform: 'translateX(-50%)',
              animation: petState === 'pushing' ? 'librarianSearch 5s ease-in-out infinite' : 'none',
              transition: 'none',
            }}
          >
            {/* 休息汗滴 */}
            {petState === 'resting' && (
              <span className="text-xs mb-0.5 pointer-events-none" style={{ animation: 'sweatFloat 1.2s ease-in-out infinite' }}>
                💦
              </span>
            )}

            {/* 小精灵 SVG 插画 */}
            <div
              className="relative"
              style={{
                animation: petState === 'pushing' ? 'librarianBounce 0.55s ease-in-out infinite' : 'none',
                filter: 'drop-shadow(0 3px 3px rgba(0,0,0,0.25))',
              }}
            >
              {/* 等级徽章 — 右上角 */}
              <svg
                className="absolute z-10"
                width="16" height="18"
                viewBox="0 0 32 36"
                style={{
                  top: '6px',
                  right: '-6px',
                  filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.35))',
                }}
              >
                <defs>
                  <linearGradient id={`${svgId}-badgeGrad`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fbbf24" />
                    <stop offset="50%" stopColor="#f59e0b" />
                    <stop offset="100%" stopColor="#b45309" />
                  </linearGradient>
                  <linearGradient id={`${svgId}-badgeInner`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fef3c7" />
                    <stop offset="100%" stopColor="#fde68a" />
                  </linearGradient>
                </defs>
                {/* 盾形外框 */}
                <path d="M16 0 L28 4 L28 16 C28 24 16 32 16 32 C16 32 4 24 4 16 L4 4 Z" fill={`url(#${svgId}-badgeGrad)`} stroke="#92400e" strokeWidth="1" />
                {/* 内框 */}
                <path d="M16 3 L25 6 L25 16 C25 22 16 28 16 28 C16 28 7 22 7 16 L7 6 Z" fill={`url(#${svgId}-badgeInner)`} />
                {/* 等级数字 */}
                <text x="16" y="20" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#92400e" fontFamily="Arial, sans-serif">{librarianLevel}</text>
              </svg>
              <svg width="44" height="52" viewBox="0 0 88 104" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <radialGradient id={`${svgId}-bodyGrad`} cx="0.5" cy="0.35" r="0.65">
                    <stop offset="0%" stopColor="#C9B8F4" />
                    <stop offset="60%" stopColor="#9B7ED8" />
                    <stop offset="100%" stopColor="#7B5EA7" />
                  </radialGradient>
                  <radialGradient id={`${svgId}-bellyGrad`} cx="0.5" cy="0.4" r="0.55">
                    <stop offset="0%" stopColor="#F8F0FF" />
                    <stop offset="100%" stopColor="#E8D5F5" />
                  </radialGradient>
                  <radialGradient id={`${svgId}-eyeGrad`} cx="0.4" cy="0.35" r="0.55">
                    <stop offset="0%" stopColor="#4A3070" />
                    <stop offset="100%" stopColor="#1A0A2E" />
                  </radialGradient>
                </defs>

                {/* 魔法光晕 */}
                <ellipse cx="44" cy="62" rx="34" ry="38" fill="rgba(179,157,219,0.12)" />

                {/* 翅膀（背后） */}
                <g style={{ transformOrigin: '44px 58px', animation: petState === 'pushing' ? 'wingFlap 0.35s ease-in-out infinite' : 'none' }}>
                  {/* 左翅 */}
                  <path d="M 22 56 Q 4 38 10 58 Q 14 68 22 62 Z" fill="rgba(210,225,255,0.55)" stroke="rgba(180,200,240,0.4)" strokeWidth="0.8" />
                  <path d="M 22 60 Q 8 50 12 64 Q 16 70 22 64 Z" fill="rgba(230,238,255,0.4)" />
                  {/* 右翅 */}
                  <path d="M 66 56 Q 84 38 78 58 Q 74 68 66 62 Z" fill="rgba(210,225,255,0.55)" stroke="rgba(180,200,240,0.4)" strokeWidth="0.8" />
                  <path d="M 66 60 Q 80 50 76 64 Q 72 70 66 64 Z" fill="rgba(230,238,255,0.4)" />
                </g>

                {/* 身体 */}
                <ellipse cx="44" cy="62" rx="24" ry="22" fill={`url(#${svgId}-bodyGrad)`} />
                {/* 肚皮 */}
                <ellipse cx="44" cy="66" rx="16" ry="14" fill={`url(#${svgId}-bellyGrad)`} />
                {/* 肚皮花纹 */}
                <path d="M 36 60 Q 44 56 52 60" stroke="rgba(155,126,216,0.3)" strokeWidth="1" fill="none" strokeLinecap="round" />

                {/* 脚 */}
                <ellipse cx="32" cy="84" rx="7" ry="4.5" fill="#7B5EA7" />
                <ellipse cx="56" cy="84" rx="7" ry="4.5" fill="#7B5EA7" />
                {/* 脚掌肉垫 */}
                <ellipse cx="32" cy="85.5" rx="4" ry="2.5" fill="#9B7ED8" />
                <ellipse cx="56" cy="85.5" rx="4" ry="2.5" fill="#9B7ED8" />

                {/* 手（短胖小手） */}
                <ellipse cx="20" cy="60" rx="7" ry="10" fill={`url(#${svgId}-bodyGrad)`} transform="rotate(-18, 20, 60)" />
                <ellipse cx="68" cy="60" rx="7" ry="10" fill={`url(#${svgId}-bodyGrad)`} transform="rotate(18, 68, 60)" />

                {/* 头 */}
                <ellipse cx="44" cy="30" rx="20" ry="18" fill={`url(#${svgId}-bodyGrad)`} />

                {/* 耳朵 */}
                <g style={{ transformOrigin: '26px 26px', animation: petState === 'resting' ? 'earWiggle 1.2s ease-in-out infinite' : 'none' }}>
                  <path d="M 26 24 L 12 8 L 30 16 Z" fill={`url(#${svgId}-bodyGrad)`} />
                  <path d="M 27 22 L 17 12 L 29 18 Z" fill="#F0C0D8" opacity="0.7" />
                </g>
                <g style={{ transformOrigin: '62px 26px', animation: petState === 'resting' ? 'earWiggle 1.2s ease-in-out 0.4s infinite' : 'none' }}>
                  <path d="M 62 24 L 76 8 L 58 16 Z" fill={`url(#${svgId}-bodyGrad)`} />
                  <path d="M 61 22 L 71 12 L 59 18 Z" fill="#F0C0D8" opacity="0.7" />
                </g>

                {/* 呆毛 / 天线 */}
                <path d="M 42 14 Q 40 4 44 2 Q 48 4 46 14" fill={`url(#${svgId}-bodyGrad)`} />
                <circle cx="44" cy="2" r="2.5" fill="#C9B8F4" stroke="#9B7ED8" strokeWidth="0.5" />
                {/* 呆毛发光点 */}
                {petState === 'pushing' && (
                  <circle cx="44" cy="2" r="4" fill="rgba(255,255,200,0.5)" style={{ animation: 'sparkleFloat 1.5s ease-in-out infinite' }} />
                )}

                {/* 眼睛 */}
                <ellipse cx="34" cy="28" rx="5.5" ry="6" fill={`url(#${svgId}-eyeGrad)`} />
                <ellipse cx="54" cy="28" rx="5.5" ry="6" fill={`url(#${svgId}-eyeGrad)`} />
                {/* 眼睛大高光 */}
                <ellipse cx="35.5" cy="25.5" rx="2.5" ry="2.8" fill="white" opacity="0.9" />
                <ellipse cx="55.5" cy="25.5" rx="2.5" ry="2.8" fill="white" opacity="0.9" />
                {/* 眼睛小高光 */}
                <circle cx="32.5" cy="30" r="1.3" fill="white" opacity="0.7" />
                <circle cx="52.5" cy="30" r="1.3" fill="white" opacity="0.7" />

                {/* 嘴（猫嘴 ^_^） */}
                <path d="M 40 35 Q 44 39 48 35" stroke="#5B3A8C" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                <path d="M 40 35 L 38 33" stroke="#5B3A8C" strokeWidth="1" fill="none" strokeLinecap="round" />
                <path d="M 48 35 L 50 33" stroke="#5B3A8C" strokeWidth="1" fill="none" strokeLinecap="round" />

                {/* 腮红 */}
                <ellipse cx="28" cy="33" rx="4.5" ry="3" fill="#F0A0C0" opacity="0.45" />
                <ellipse cx="60" cy="33" rx="4.5" ry="3" fill="#F0A0C0" opacity="0.45" />

                {/* 尾巴 */}
                <path d="M 64 70 Q 78 62 76 74 Q 74 82 68 76" stroke={`url(#${svgId}-bodyGrad)`} strokeWidth="5" fill="none" strokeLinecap="round" />
                <path d="M 64 70 Q 78 62 76 74 Q 74 82 68 76" stroke="#9B7ED8" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.5" />
                {/* 尾巴尖 */}
                <circle cx="68" cy="76" r="3.5" fill="#C9B8F4" />

                {/* 身旁漂浮的小书本 */}
                <g style={{ animation: 'bookFloat 3s ease-in-out 0.5s infinite' }}>
                  <rect x="68" y="22" width="9" height="12" rx="1.5" fill="#E74C3C" />
                  <rect x="68" y="22" width="2.5" height="12" rx="1" fill="#C0392B" />
                  <line x1="71" y1="25" x2="76" y2="25" stroke="rgba(255,255,255,0.4)" strokeWidth="0.5" />
                  <line x1="71" y1="28" x2="75" y2="28" stroke="rgba(255,255,255,0.4)" strokeWidth="0.5" />
                  <line x1="71" y1="31" x2="76" y2="31" stroke="rgba(255,255,255,0.4)" strokeWidth="0.5" />
                </g>
              </svg>

              {/* 搜寻时的星星特效 */}
              {petState === 'pushing' && (
                <>
                  <span className="absolute text-xs pointer-events-none" style={{ top: '-4px', right: '-4px', animation: 'sparkleFloat 1.8s ease-in-out infinite' }}>
                    ✨
                  </span>
                  <span className="absolute text-xs pointer-events-none" style={{ top: '6px', left: '0px', animation: 'sparkleFloat 2.2s ease-in-out 0.6s infinite' }}>
                    ⭐
                  </span>
                </>
              )}

              {/* 休息时的汗滴 */}
              {petState === 'resting' && (
                <span className="absolute text-base pointer-events-none" style={{ top: '-6px', right: '-6px', animation: 'sweatFloat 0.8s ease-in-out infinite' }}>
                  💦
                </span>
              )}
            </div>
          </div>

          {/* 休息提示文字 */}
          {petState === 'resting' && restMessage && (
            <div className="absolute top-1 left-0 right-0 flex items-center justify-center">
              <span className="text-xs font-medium text-amber-400">
                {restMessage}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 标题栏 */}
      <div
        className={`flex items-center justify-between px-3 py-2 cursor-pointer select-none border-b ${border}`}
        onClick={() => setCollapsed(true)}
      >
        <div className="flex items-center gap-2">
          <ListTodo className={`w-4 h-4 ${textSecondary}`} />
          <span className={`text-xs font-medium ${textPrimary}`}>
            后台任务
            {totalRunning > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400">
                {totalRunning}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {doneTasks.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); if (onClearCompleted) onClearCompleted(); }}
              className={`p-1 rounded ${textSecondary} ${hoverBg} transition-colors`}
              title="清除已完成任务"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <ChevronDown className={`w-4 h-4 ${textSecondary}`} />
        </div>
      </div>

      {/* 任务列表 — 最多容纳 5 条，超出显示滚动条 */}
      <div className="max-h-[200px] overflow-auto flex-shrink-0">
        {displayTasks.length === 0 ? (
          <div className={`px-3 py-6 text-center text-xs ${textSecondary}`}>
            暂无后台任务
          </div>
        ) : (
          <div className="py-1">
            {displayTasks.map(task => {
              const colors = STATUS_COLORS[task.status] || STATUS_COLORS.running;
              const isRunning = task.status === 'running';
              const isChrys = task.metadata?.type === 'chrys';
              return (
                <div
                  key={task.id}
                  className={`px-3 py-2 ${hoverBg} transition-colors ${isChrys ? 'cursor-pointer' : ''}`}
                  onClick={() => isChrys && openLogViewer(task)}
                >
                  <div className="flex items-center gap-2.5">
                    {/* 状态图标 */}
                    <div className="flex-shrink-0 mt-0.5">
                      {STATUS_ICONS[task.status]}
                    </div>
                    {/* 内容 */}
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium truncate ${textPrimary} ${isChrys ? 'underline decoration-dotted decoration-gray-500' : ''}`}>
                        {task.name}
                      </div>
                      {task.message && (
                        <div className={`text-[10px] mt-0.5 truncate ${colors.text}`}>
                          {task.message}
                        </div>
                      )}
                    </div>
                    {/* 右侧：倒计时 或 取消按钮 */}
                    {isRunning && task.deadline ? (
                      <span className={`flex-shrink-0 text-[10px] font-mono ${task.deadline - tick <= 10000 ? 'text-red-400' : textSecondary}`}>
                        {formatRemaining(task.deadline)}
                      </span>
                    ) : isRunning && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onCancel && onCancel(task.id); }}
                        className={`flex-shrink-0 p-0.5 rounded ${textSecondary} ${hoverBg} transition-colors`}
                        title="取消任务"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                    {/* Chrys 任务显示日志图标 */}
                    {isChrys && (
                      <FileText className={`w-3 h-3 flex-shrink-0 ${textSecondary}`} />
                    )}
                  </div>
                  {/* 进度条：仅运行中且有进度的任务显示 */}
                  {isRunning && task.progress != null && (
                    <div className="mt-1.5 w-full h-1 rounded-full bg-gray-700 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-300 ease-out"
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {/* 提示有更多已完成任务被隐藏 */}
            {doneTasks.length > MAX_DONE_VISIBLE && (
              <div className={`px-3 py-1.5 text-center text-[10px] ${textSecondary}`}>
                还有 {doneTasks.length - MAX_DONE_VISIBLE} 个已完成任务未显示
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chrys 日志查看器 */}
      {logViewerTask && (
        <ChrysLogViewer
          task={logViewerTask}
          logData={logData}
          logLoading={logLoading}
          logTab={logTab}
          setLogTab={setLogTab}
          selectedTrace={selectedTrace}
          setSelectedTrace={setSelectedTrace}
          onClose={closeLogViewer}
          onRefresh={() => fetchLogs(logViewerTask)}
          theme={theme}
        />
      )}
    </div>
  );
}

export default TaskPanel;

// ========== Chrys 日志查看器子组件 ==========

/**
 * 格式化纳秒为可读时间
 */
function formatNs(ns) {
  if (!ns && ns !== 0) return '-';
  const ms = ns / 1e6;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

/**
 * 获取 span 类型图标
 */
function getSpanIcon(name) {
  if (!name) return <Activity className="w-3 h-3" />;
  if (name.startsWith('chat ')) return <Bot className="w-3 h-3 text-green-400" />;
  if (name.startsWith('invoke_agent')) return <Zap className="w-3 h-3 text-yellow-400" />;
  if (name.startsWith('execute_tool')) return <Wrench className="w-3 h-3 text-blue-400" />;
  return <Activity className="w-3 h-3" />;
}

/**
 * 获取日志级别颜色
 */
function getSeverityColor(severity) {
  switch (severity) {
    case 'ERROR': return 'text-red-400';
    case 'WARN': return 'text-yellow-400';
    case 'INFO': return 'text-blue-300';
    case 'DEBUG': return 'text-gray-400';
    default: return 'text-gray-300';
  }
}

function ChrysLogViewer({ task, logData, logLoading, logTab, setLogTab, selectedTrace, setSelectedTrace, onClose, onRefresh, theme }) {
  const isDark = theme === 'dark';
  const bg = isDark ? 'bg-gray-900' : 'bg-white';
  const border = isDark ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = isDark ? 'text-gray-200' : 'text-gray-700';
  const textSecondary = isDark ? 'text-gray-400' : 'text-gray-500';
  const panelBg = isDark ? 'bg-gray-800' : 'bg-gray-50';
  const tabActive = isDark ? 'border-blue-400 text-blue-400' : 'border-blue-500 text-blue-500';
  const tabInactive = isDark ? 'border-transparent text-gray-400 hover:text-gray-300' : 'border-transparent text-gray-500 hover:text-gray-700';

  // 关联 traces 和 logs
  const correlatedData = useMemo(() => {
    if (!logData || !logData.traces) return null;
    return logData.traces.map(trace => {
      const relatedLogs = (logData.logs || []).filter(log => log.trace_id === trace.trace_id);
      return { ...trace, relatedLogs };
    });
  }, [logData]);

  const renderOverview = () => {
    if (!logData) return null;
    const traces = logData.traces || [];
    const logs = logData.logs || [];

    // 统计
    const chatTraces = traces.filter(t => t.name && t.name.startsWith('chat '));
    const toolTraces = traces.filter(t => t.name && t.name.startsWith('execute_tool'));
    const totalInputTokens = chatTraces.reduce((sum, t) => sum + (t.attributes?.['gen_ai.usage.input_tokens'] || 0), 0);
    const totalOutputTokens = chatTraces.reduce((sum, t) => sum + (t.attributes?.['gen_ai.usage.output_tokens'] || 0), 0);
    // 总耗时 = 最早 start 到最晚 end 的墙上时间（非累加，避免嵌套 span 重复计算）
    const starts = traces.map(t => t.start_time_ns).filter(Boolean);
    const ends = traces.map(t => t.end_time_ns).filter(Boolean);
    const totalDuration = (starts.length && ends.length) ? Math.max(...ends) - Math.min(...starts) : 0;

    // 以 k 为单位，向上取整
    const toK = (n) => Math.ceil(n / 1000).toLocaleString();
    const tokenDisplay = `${toK(totalInputTokens)}k / ${toK(totalOutputTokens)}k`;

    const errorLogs = logs.filter(l => l.severity_text === 'ERROR');
    const warnLogs = logs.filter(l => l.severity_text === 'WARN');

    return (
      <div className="p-3 space-y-3 overflow-auto flex-1 min-h-0">
        <div className={`text-xs font-medium ${textPrimary}`}>会话概要</div>

        <div className="grid grid-cols-2 gap-2">
          <StatCard label="LLM 调用" value={chatTraces.length} icon={<Bot className="w-3 h-3 text-green-400" />} theme={theme} />
          <StatCard label="工具执行" value={toolTraces.length} icon={<Wrench className="w-3 h-3 text-blue-400" />} theme={theme} />
          <StatCard label="Token 用量" value={tokenDisplay} icon={<Zap className="w-3 h-3 text-yellow-400" />} theme={theme} />
          <StatCard label="总耗时" value={formatNs(totalDuration)} icon={<Clock className="w-3 h-3 text-purple-400" />} theme={theme} />
        </div>

        <div className={`text-xs font-medium ${textPrimary} mt-3`}>Session ID</div>
        <div className={`text-[10px] font-mono break-all ${textSecondary} p-2 rounded ${panelBg}`}>
          {task.metadata?.sessionId || '-'}
        </div>

        {errorLogs.length > 0 && (
          <div>
            <div className="flex items-center gap-1 mb-1">
              <AlertCircle className="w-3 h-3 text-red-400" />
              <span className={`text-xs ${textPrimary}`}>错误 ({errorLogs.length})</span>
            </div>
            <div className={`max-h-32 overflow-auto ${panelBg} rounded p-2`}>
              {errorLogs.slice(0, 5).map((log, i) => (
                <div key={i} className="text-[10px] text-red-400 truncate">{log.body || JSON.stringify(log).slice(0, 100)}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderTraces = () => {
    if (!correlatedData || correlatedData.length === 0) {
      return (
        <div className={`p-4 text-center text-xs ${textSecondary}`}>暂无 Trace 数据</div>
      );
    }
    return (
      <div className="overflow-auto flex-1 min-h-0">
        {[...correlatedData].reverse().map((trace, i) => (
          <TraceItem
            key={i}
            trace={trace}
            index={i}
            isSelected={selectedTrace === i}
            onSelect={() => setSelectedTrace(selectedTrace === i ? null : i)}
            theme={theme}
          />
        ))}
      </div>
    );
  };

  const renderTraceDetail = () => {
    if (selectedTrace == null || !correlatedData) return null;
    const trace = correlatedData[selectedTrace];
    if (!trace) return null;

    return (
      <div className={`border-t ${border} p-3 overflow-auto flex-shrink-0`} style={{ maxHeight: '40%' }}>
        <div className={`text-xs font-medium ${textPrimary} mb-2`}>
          详情: {trace.name || 'Span'}
        </div>
        <div className="space-y-1 text-[10px]">
          <DetailRow label="Span ID" value={trace.span_id} theme={theme} />
          <DetailRow label="Trace ID" value={trace.trace_id} theme={theme} />
          <DetailRow label="耗时" value={formatNs(trace.duration_ns)} theme={theme} />
          <DetailRow label="状态" value={trace.status?.code || '-'} theme={theme} />
          {trace.attributes && (
            <>
              <DetailRow label="模型" value={trace.attributes['gen_ai.request.model']} theme={theme} />
              <DetailRow label="Input Tokens" value={trace.attributes['gen_ai.usage.input_tokens']} theme={theme} />
              <DetailRow label="Output Tokens" value={trace.attributes['gen_ai.usage.output_tokens']} theme={theme} />
            </>
          )}
        </div>
        {trace.relatedLogs && trace.relatedLogs.length > 0 && (
          <div className="mt-2">
            <div className={`text-[10px] font-medium ${textSecondary} mb-1`}>关联日志 ({trace.relatedLogs.length})</div>
            <div className={`${panelBg} rounded p-2 max-h-24 overflow-auto space-y-1`}>
              {trace.relatedLogs.map((log, i) => (
                <div key={i} className={`text-[10px] ${getSeverityColor(log.severity_text)}`}>
                  {log.body || JSON.stringify(log).slice(0, 120)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderLogs = () => {
    const logs = logData?.logs || [];
    if (logs.length === 0) {
      return (
        <div className={`p-4 text-center text-xs ${textSecondary}`}>暂无日志</div>
      );
    }
    return (
      <div className="overflow-auto flex-1 min-h-0">
        {[...logs].reverse().map((log, i) => (
          <div key={i} className={`px-3 py-1.5 border-b ${border} last:border-b-0`}>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-mono flex-shrink-0 ${textSecondary}`}>
                {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '-'}
              </span>
              <span className={`text-[10px] font-medium flex-shrink-0 ${getSeverityColor(log.severity_text)}`}>
                {log.severity_text || 'INFO'}
              </span>
              <span className={`text-[10px] flex-shrink-0 ${textSecondary}`}>
                {log.attributes?.event?.name || ''}
              </span>
            </div>
            <div className={`text-[10px] mt-0.5 ${textPrimary} break-all line-clamp-2`}>
              {log.body || '-'}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={`border-t ${border} flex flex-col flex-1 min-h-0 overflow-hidden`}>
      {/* 标题栏 */}
      <div className={`flex items-center justify-between px-3 py-2 ${panelBg}`}>
        <div className="flex items-center gap-2">
          <FileText className={`w-3.5 h-3.5 ${textSecondary}`} />
          <span className={`text-xs font-medium ${textPrimary}`}>Chrys 执行日志</span>
          {logData?.running && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} className={`p-1 rounded ${textSecondary} hover:bg-gray-600/30`} title="刷新">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button onClick={onClose} className={`p-0.5 rounded ${textSecondary} hover:bg-gray-600/30`}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 标签切换 */}
      <div className={`flex border-b ${border}`}>
        {['overview', 'traces', 'logs'].map(tab => (
          <button
            key={tab}
            onClick={() => { setLogTab(tab); setSelectedTrace(null); }}
            className={`px-3 py-1.5 text-[10px] font-medium border-b-2 transition-colors ${logTab === tab ? tabActive : tabInactive}`}
          >
            {tab === 'overview' ? '概览' : tab === 'traces' ? 'Traces' : '日志'}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {logLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
        </div>
      ) : logData?.error ? (
        <div className={`p-4 text-center text-xs text-red-400`}>
          读取日志失败: {logData.error}
        </div>
      ) : logData?.missing ? (
        <div className={`p-4 text-center text-xs text-red-400`}>
          Session 目录不存在（Chrys 进程可能异常退出或尚未创建）
        </div>
      ) : logData?.found && !logData.traces.length && !logData.logs.length ? (
        <div className="p-4 space-y-3">
          {logData?.running ? (
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                <span className={`text-xs ${textSecondary}`}>Chrys 正在运行，等待首次日志输出...</span>
              </div>
              <div className={`text-[10px] ${textSecondary}`}>日志将在首次 LLM 调用后自动加载</div>
              <button
                onClick={onRefresh}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                手动刷新
              </button>
            </div>
          ) : logData?.stdout ? (
            <>
              <div className={`text-xs font-medium ${textPrimary}`}>Chrys 控制台输出</div>
              <div className={`${panelBg} rounded p-2 overflow-auto flex-1 min-h-0 font-mono text-[10px] whitespace-pre-wrap break-all ${textSecondary}`}>
                {logData.stdout}
              </div>
              {logData?.stderr && (
                <>
                  <div className={`text-xs font-medium text-red-400`}>错误输出</div>
                  <div className="bg-red-900/20 rounded p-2 max-h-20 overflow-auto font-mono text-[10px] whitespace-pre-wrap break-all text-red-400">
                    {logData.stderr}
                  </div>
                </>
              )}
              <button
                onClick={onRefresh}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                手动刷新（等待 OTEL 日志写入）
              </button>
            </>
          ) : (
            <div className="text-center space-y-3">
              <div className={`text-xs ${textSecondary}`}>暂无日志数据</div>
              <button
                onClick={onRefresh}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                手动刷新
              </button>
            </div>
          )}
        </div>
      ) : !logData?.found ? (
        <div className={`p-4 text-center text-xs ${textSecondary}`}>
          暂无日志数据
        </div>
      ) : (
        <>
          {logTab === 'overview' && renderOverview()}
          {logTab === 'traces' && renderTraces()}
          {logTab === 'logs' && renderLogs()}
          {logTab === 'traces' && renderTraceDetail()}
        </>
      )}
    </div>
  );
}

// 统计卡片
function StatCard({ label, value, icon, theme }) {
  const isDark = theme === 'dark';
  const bg = isDark ? 'bg-gray-700/50' : 'bg-gray-100';
  const textSecondary = isDark ? 'text-gray-400' : 'text-gray-500';
  return (
    <div className={`${bg} rounded p-2`}>
      <div className="flex items-center gap-1 mb-0.5">
        {icon}
        <span className={`text-[10px] ${textSecondary}`}>{label}</span>
      </div>
      <div className={`text-sm font-semibold ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{value}</div>
    </div>
  );
}

// Trace 条目
function TraceItem({ trace, index, isSelected, onSelect, theme }) {
  const isDark = theme === 'dark';
  const border = isDark ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = isDark ? 'text-gray-200' : 'text-gray-700';
  const textSecondary = isDark ? 'text-gray-400' : 'text-gray-500';
  const hoverBg = isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100';

  const isChat = trace.name && trace.name.startsWith('chat ');
  const isTool = trace.name && trace.name.startsWith('execute_tool');
  const model = trace.attributes?.['gen_ai.request.model'] || '';

  return (
    <div
      onClick={onSelect}
      className={`px-3 py-2 border-b ${border} cursor-pointer ${hoverBg} transition-colors ${isSelected ? (isDark ? 'bg-gray-700' : 'bg-gray-100') : ''}`}
    >
      <div className="flex items-center gap-2">
        {getSpanIcon(trace.name)}
        <div className="flex-1 min-w-0">
          <div className={`text-[10px] font-medium truncate ${textPrimary}`}>
            {trace.name || `Span #${index + 1}`}
          </div>
          {model && (
            <div className={`text-[9px] truncate ${textSecondary}`}>{model}</div>
          )}
        </div>
        <div className="flex-shrink-0 flex flex-col items-end">
          <span className={`text-[10px] ${textPrimary}`}>{formatNs(trace.duration_ns)}</span>
          {trace.attributes && (
            <span className={`text-[9px] ${textSecondary}`}>
              {[trace.attributes['gen_ai.usage.input_tokens'], trace.attributes['gen_ai.usage.output_tokens']].filter(Boolean).join('/')} tok
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// 详情行
function DetailRow({ label, value, theme }) {
  if (value == null || value === '') return null;
  const isDark = theme === 'dark';
  return (
    <div className="flex gap-2">
      <span className={isDark ? 'text-gray-500' : 'text-gray-400'}>{label}:</span>
      <span className={`truncate ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>{String(value)}</span>
    </div>
  );
}
