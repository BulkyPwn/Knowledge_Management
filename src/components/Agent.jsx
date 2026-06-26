import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, Send, Settings, Sparkles, Zap, Code, MessageSquare, Loader2, ChevronDown, ChevronUp, Wrench, CheckCircle2, XCircle, BookOpen, Search, Globe, FileText, Lightbulb } from 'lucide-react';

const API_BASE = 'http://127.0.0.1:5002/api/v1';

// ── SSE 解析器 ─────────────────────────────────────────────────
function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = null;
  let currentData = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(currentData) });
      } catch {
        events.push({ event: currentEvent, data: { raw: currentData } });
      }
      currentEvent = null;
      currentData = '';
    }
  }
  if (currentEvent && currentData) {
    try {
      events.push({ event: currentEvent, data: JSON.parse(currentData) });
    } catch {
      events.push({ event: currentEvent, data: { raw: currentData } });
    }
  }
  return events;
}

// ── Tool 图标映射 ────────────────────────────────────────────────
const TOOL_ICONS = {
  knowledge_query: BookOpen,
  web_search: Search,
  fetch_url: Globe,
  list_projects: FileText,
  get_current_time: Lightbulb,
  calculator: Wrench,
};

// ── Agent 定义 ──────────────────────────────────────────────────
const AGENTS = [
  { id: 'lingxi', name: '灵犀', icon: MessageSquare, description: '智能对话助手，支持多轮对话和工具调用', color: 'indigo', instructions: '' },
  { id: 'codeagent', name: 'CodeAgent', icon: Code, description: '代码生成与分析专家', color: 'green', instructions: 'You are a coding expert. Help with code generation, analysis, debugging, and optimization.' },
  { id: 'creative', name: '创意助手', icon: Sparkles, description: '激发创意灵感，头脑风暴', color: 'purple', instructions: 'You are a creative thinking partner. Help brainstorm ideas, write creatively, and think outside the box.' },
  { id: 'researcher', name: '调研员', icon: Search, description: '网络调研与知识库检索', color: 'orange', instructions: 'You are a research assistant. Thoroughly search knowledge bases and the web to provide comprehensive, well-cited answers.' },
];

function Agent({ theme, messages: propMessages, setMessages: setPropMessages }) {
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('lingxi');
  const [showMarket, setShowMarket] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState([]);
  const [activeSkillIds, setActiveSkillIds] = useState(new Set());
  const [streamingContent, setStreamingContent] = useState('');
  const abortRef = useRef({ controller: null });
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // 使用 propMessages 或默认欢迎消息
  const messages = propMessages.length > 0 ? propMessages : [
    { type: 'assistant', content: '您好！我是 AI 智能助手，可以帮您搜索知识库、查询网络、分析数据等。有什么可以帮助您的？' }
  ];

  // 加载可用技能
  useEffect(() => {
    fetch(`${API_BASE}/agent/skills`)
      .then(r => r.json())
      .then(d => { if (d.success) setSkills(d.data.skills || []); })
      .catch(() => {});
  }, []);

  // 自动滚动
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // ── 发送消息 ──────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    if (!inputValue.trim() || isTyping) return;

    const userMsg = { type: 'user', content: inputValue };
    const newMessages = [...messages, userMsg];
    setPropMessages(newMessages);
    setInputValue('');
    setIsTyping(true);
    setStreamingContent('');

    // 构建 API 消息格式
    const apiMessages = newMessages
      .filter(m => m.type === 'user' || m.type === 'assistant')
      .map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content }));

    const agent = AGENTS.find(a => a.id === selectedAgent);

    try {
      const controller = new AbortController();
      abortRef.current.controller = controller;

      const resp = await fetch(`${API_BASE}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          skill_ids: Array.from(activeSkillIds),
          custom_instructions: agent?.instructions || '',
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let toolSteps = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSE(buffer);
        // 保留未解析完的部分
        const lastNewline = buffer.lastIndexOf('\n\n');
        if (lastNewline >= 0) {
          buffer = buffer.slice(lastNewline + 2);
        }

        for (const evt of events) {
          switch (evt.event) {
            case 'agent_status':
              // thinking 状态 - 无需特别处理
              break;

            case 'tool_call':
              toolSteps.push({
                tool: evt.data.tool,
                args: evt.data.args,
                call_id: evt.data.call_id,
                status: 'calling',
                result: '',
              });
              setPropMessages([...newMessages, { type: 'thinking', toolSteps: [...toolSteps] }]);
              break;

            case 'tool_result':
              const idx = toolSteps.findIndex(t => t.call_id === evt.data.call_id);
              if (idx >= 0) {
                toolSteps[idx] = { ...toolSteps[idx], status: 'done', result: evt.data.result };
              }
              setPropMessages([...newMessages, { type: 'thinking', toolSteps: [...toolSteps] }]);
              break;

            case 'message':
              if (evt.data.type === 'delta') {
                fullContent += evt.data.content;
                setStreamingContent(fullContent);
              } else if (evt.data.type === 'complete') {
                fullContent = evt.data.content || fullContent;
                setStreamingContent('');
                // 移除 thinking 消息，添加最终回答
                const finalMessages = [
                  ...newMessages.filter(m => m.type !== 'thinking'),
                  ...toolSteps.length > 0 ? [{ type: 'tool_steps', steps: [...toolSteps] }] : [],
                  { type: 'assistant', content: fullContent },
                ];
                setPropMessages(finalMessages);
                toolSteps = [];
              }
              break;

            case 'error':
              setStreamingContent('');
              setPropMessages([...newMessages.filter(m => m.type !== 'thinking'),
                { type: 'error', content: evt.data.message || 'Unknown error' }]);
              break;

            case 'done':
              break;
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setStreamingContent('');
        setPropMessages([...messages.filter(m => m.type !== 'thinking'),
          { type: 'error', content: `请求失败: ${e.message}` }]);
      }
    } finally {
      setIsTyping(false);
      abortRef.current.controller = null;
    }
  }, [inputValue, isTyping, messages, selectedAgent, activeSkillIds, setPropMessages, abortRef]);

  const stopGenerating = () => {
    abortRef.current.controller?.abort();
    setIsTyping(false);
  };

  // ── 样式工具函数 ──────────────────────────────────────────────
  const getAgentColor = (color) => {
    const map = { indigo: 'bg-indigo-600', green: 'bg-emerald-600', purple: 'bg-purple-600', orange: 'bg-orange-600' };
    return theme === 'dark' ? map[color] || 'bg-indigo-600' : map[color] || 'bg-indigo-500';
  };
  const bg = theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500';
  const cardBg = theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white' : 'bg-gray-600';
  const textPrimary = theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white';
  const textSecondary = theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300';
  const borderColor = theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-500';

  const currentAgent = AGENTS.find(a => a.id === selectedAgent);

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className={`flex items-center gap-3 px-4 py-3 ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'} border-b ${borderColor}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${getAgentColor(currentAgent?.color || 'indigo')}`}>
          {(() => { const Icon = currentAgent?.icon || Bot; return <Icon className="w-5 h-5 text-white" />; })()}
        </div>
        <div>
          <h2 className={`text-sm font-semibold ${textPrimary}`}>{currentAgent?.name || 'AI Agent'}</h2>
          <p className={`text-xs ${textSecondary}`}>{currentAgent?.description || '智能助手'}</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Skills 按钮 */}
          <button
            onClick={() => setShowSkills(!showSkills)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
              showSkills
                ? `${theme === 'dark' ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white'}`
                : `${theme === 'dark' ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`
            }`}
          >
            <Wrench className="w-3.5 h-3.5" />
            Skills {activeSkillIds.size > 0 && `(${activeSkillIds.size})`}
          </button>
          {/* Agent 市场按钮 */}
          <button
            onClick={() => setShowMarket(!showMarket)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              showMarket
                ? `${theme === 'dark' ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white'}`
                : `${theme === 'dark' ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`
            }`}
          >
            Agent市场
          </button>
        </div>
      </div>

      {/* ── Skill 面板 ─────────────────────────────────────────── */}
      {showSkills && (
        <div className={`p-4 border-b ${borderColor} ${cardBg}`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className={`text-sm font-semibold ${textPrimary}`}>可用技能</h3>
            {activeSkillIds.size > 0 && (
              <button onClick={() => setActiveSkillIds(new Set())} className="text-xs text-indigo-400 hover:text-indigo-300">
                清除选择
              </button>
            )}
          </div>
          {skills.length === 0 ? (
            <p className={`text-xs ${textSecondary}`}>暂无可用技能</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {skills.map(skill => {
                const isActive = activeSkillIds.has(skill.id);
                return (
                  <button
                    key={skill.id}
                    onClick={() => {
                      const next = new Set(activeSkillIds);
                      if (isActive) next.delete(skill.id); else next.add(skill.id);
                      setActiveSkillIds(next);
                    }}
                    className={`p-3 rounded-lg text-left transition-all border ${
                      isActive
                        ? `border-indigo-500 ${theme === 'dark' ? 'bg-indigo-900/30' : 'bg-indigo-50'}`
                        : `border-transparent ${theme === 'dark' ? 'bg-gray-600/50 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'}`
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-indigo-400' : theme === 'dark' ? 'bg-gray-500' : 'bg-gray-300'}`} />
                      <span className={`text-sm font-medium ${textPrimary}`}>{skill.name}</span>
                    </div>
                    <p className={`text-xs ${textSecondary} line-clamp-2`}>{skill.description}</p>
                    {skill.tools_used && skill.tools_used.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {skill.tools_used.map(t => (
                          <span key={t} className={`text-[10px] px-1.5 py-0.5 rounded ${theme === 'dark' ? 'bg-gray-700 text-gray-400' : 'bg-gray-200 text-gray-500'}`}>
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <p className={`text-xs ${textSecondary} mt-2`}>
            选择技能后将优先使用对应流程；不选择则自动匹配。
          </p>
        </div>
      )}

      {/* ── Agent 市场面板 ─────────────────────────────────────── */}
      {showMarket && (
        <div className={`p-4 border-b ${borderColor} ${cardBg}`}>
          <h3 className={`text-sm font-semibold mb-3 ${textPrimary}`}>选择 Agent</h3>
          <div className="grid grid-cols-4 gap-3">
            {AGENTS.map(agent => {
              const Icon = agent.icon;
              return (
                <button
                  key={agent.id}
                  onClick={() => {
                    setSelectedAgent(agent.id);
                    setShowMarket(false);
                    setPropMessages([{ type: 'assistant', content: `您好！我是${agent.name}，${agent.description}。请问有什么可以帮助您的？` }]);
                  }}
                  className={`p-4 rounded-xl transition-all text-left ${
                    selectedAgent === agent.id
                      ? `${getAgentColor(agent.color)} text-white`
                      : `${theme === 'dark' ? 'bg-gray-600/50 text-gray-300 hover:bg-gray-600' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'}`
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-2 ${selectedAgent === agent.id ? 'bg-white/20' : theme === 'dark' ? 'bg-gray-600' : 'bg-gray-200'}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="font-semibold text-sm">{agent.name}</div>
                  <div className="text-xs opacity-70">{agent.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 聊天区域 ──────────────────────────────────────────── */}
      <div className={`flex-1 overflow-auto p-4 ${bg}`}>
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg, idx) => {
            if (msg.type === 'user') {
              return (
                <div key={idx} className="flex justify-end">
                  <div className="max-w-[75%] px-4 py-3 rounded-2xl bg-indigo-600 text-white text-sm">
                    {msg.content}
                  </div>
                </div>
              );
            }

            if (msg.type === 'assistant') {
              return (
                <div key={idx} className="flex justify-start">
                  <div className="flex items-start gap-3 max-w-[80%]">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getAgentColor(currentAgent?.color)}`}>
                      {(() => { const Icon = currentAgent?.icon || Bot; return <Icon className="w-4 h-4 text-white" />; })()}
                    </div>
                    <div className={`px-4 py-3 rounded-2xl ${cardBg} text-sm ${textPrimary} whitespace-pre-wrap leading-relaxed`}>
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            }

            if (msg.type === 'error') {
              return (
                <div key={idx} className="flex justify-start">
                  <div className="flex items-start gap-3 max-w-[80%]">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-red-500">
                      <XCircle className="w-4 h-4 text-white" />
                    </div>
                    <div className={`px-4 py-3 rounded-2xl border border-red-500/30 ${theme === 'dark' ? 'bg-red-900/20' : 'bg-red-50'} text-sm text-red-400`}>
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            }

            if (msg.type === 'tool_steps') {
              return <ToolStepsCard key={idx} steps={msg.steps} theme={theme} cardBg={cardBg} textPrimary={textPrimary} textSecondary={textSecondary} borderColor={borderColor} />;
            }

            // thinking (in-progress tool steps)
            if (msg.type === 'thinking') {
              return <ToolStepsCard key={idx} steps={msg.toolSteps} theme={theme} cardBg={cardBg} textPrimary={textPrimary} textSecondary={textSecondary} borderColor={borderColor} isLive />;
            }

            return null;
          })}

          {/* 流式输出中 */}
          {streamingContent && (
            <div className="flex justify-start">
              <div className="flex items-start gap-3 max-w-[80%]">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getAgentColor(currentAgent?.color)}`}>
                  {(() => { const Icon = currentAgent?.icon || Bot; return <Icon className="w-4 h-4 text-white" />; })()}
                </div>
                <div className={`px-4 py-3 rounded-2xl ${cardBg} text-sm ${textPrimary} whitespace-pre-wrap leading-relaxed`}>
                  {streamingContent}
                  <span className="inline-block w-1 h-4 bg-indigo-400 animate-pulse ml-0.5" />
                </div>
              </div>
            </div>
          )}

          {/* 思考中动画 */}
          {isTyping && !streamingContent && !messages.some(m => m.type === 'thinking') && (
            <div className="flex justify-start">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getAgentColor(currentAgent?.color)}`}>
                  <Loader2 className="w-4 h-4 text-white animate-spin" />
                </div>
                <div className={`px-4 py-3 rounded-2xl ${cardBg}`}>
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* ── 输入区域 ──────────────────────────────────────────── */}
      <div className={`p-4 border-t ${borderColor} ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
        <div className="max-w-3xl mx-auto">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="输入您的问题..."
              disabled={isTyping}
              className={`flex-1 px-4 py-3 rounded-xl outline-none transition-all text-sm ${
                theme === 'dark'
                  ? 'bg-gray-700 text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500'
                  : theme === 'light'
                    ? 'bg-gray-100 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-indigo-500'
                    : 'bg-gray-500 text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500'
              } ${isTyping ? 'opacity-60' : ''}`}
            />
            {isTyping ? (
              <button onClick={stopGenerating} className="px-4 py-3 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all">
                <XCircle className="w-5 h-5" />
              </button>
            ) : (
              <button onClick={sendMessage} disabled={!inputValue.trim()} className={`px-5 py-3 rounded-xl transition-all ${inputValue.trim() ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'}`}>
                <Send className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 工具调用步骤卡片 ──────────────────────────────────────────────
function ToolStepsCard({ steps, theme, cardBg, textPrimary, textSecondary, borderColor, isLive }) {
  const [expanded, setExpanded] = useState(true);
  const cardBorder = theme === 'dark' ? 'border-gray-600' : 'border-gray-200';

  return (
    <div className={`rounded-xl border ${cardBorder} ${cardBg} overflow-hidden max-w-[80%] ml-11`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center justify-between px-4 py-2.5 text-xs font-medium ${textPrimary} hover:opacity-80 transition-opacity`}
      >
        <div className="flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5 text-indigo-400" />
          <span>工具调用 ({steps.length})</span>
          {isLive && <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />}
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {expanded && (
        <div className={`px-4 pb-3 space-y-2 border-t ${cardBorder}`}>
          {steps.map((step, idx) => {
            const Icon = TOOL_ICONS[step.tool] || Wrench;
            const isDone = step.status === 'done';
            return (
              <div key={idx} className="pt-2">
                <div className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 text-indigo-400" />
                  <span className={`text-xs font-medium ${textPrimary}`}>{step.tool}</span>
                  {isDone ? (
                    <CheckCircle2 className="w-3 h-3 text-green-400" />
                  ) : (
                    <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />
                  )}
                </div>
                {/* 参数 */}
                {step.args && Object.keys(step.args).length > 0 && (
                  <div className={`mt-1 text-[11px] font-mono ${textSecondary} pl-5.5`}>
                    {Object.entries(step.args).map(([k, v]) => (
                      <span key={k} className="inline-block mr-2">
                        <span className="text-indigo-400">{k}</span>=
                        <span className={`${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
                          {typeof v === 'string' ? (v.length > 40 ? v.slice(0, 40) + '...' : v) : JSON.stringify(v)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
                {/* 结果摘要 */}
                {isDone && step.result && (
                  <div className={`mt-1 text-[11px] ${textSecondary} pl-5.5 max-h-16 overflow-hidden`}>
                    {step.result.length > 200 ? step.result.slice(0, 200) + '...' : step.result}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Agent;
