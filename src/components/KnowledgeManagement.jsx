import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Send, Image, Trash2, Save, Search, Plus, X, Bot, MessageSquare, ChevronLeft, ChevronRight, Check, Trash2 as TrashIcon, Settings, ChevronDown, ChevronUp, Database, FileText, Globe, Upload, Edit3, Folder, Link, Download, RefreshCw, FolderOpen, Loader2, Sparkles, BarChart3 } from 'lucide-react';
import { useTaskManager } from '../hooks/useTaskManager';
import TaskPanel from './TaskPanel';
import KBSettingsModal from './knowledge/components/KBSettingsModal';
import PreprocessorSettingsModal, { DEFAULT_PROCESSORS } from './knowledge/components/PreprocessorSettingsModal';
import IngestMonitor from './knowledge/components/IngestMonitor';
import PathTypeModal from './knowledge/config/PathTypeModal';
import BrowseModal from './knowledge/config/BrowseModal';
import SettingsPanelModal from './knowledge/config/SettingsPanelModal';
import VectorModal from './knowledge/config/VectorModal';
import PerfStatsModal from './knowledge/config/PerfStatsModal';
import KbFileListModal from './knowledge/knowledge-source/KbFileListModal';
import CreateKbModal from './knowledge/knowledge-source/CreateKbModal';
import SearchImportModal from './knowledge/knowledge-source/SearchImportModal';
import KbCard from './knowledge/knowledge-source/KbCard';
import HiDeskPanel from './knowledge/knowledge-source/HiDeskPanel';
import PlatformSelector from './knowledge/knowledge-source/PlatformSelector';
import PptSettingsModal from './knowledge/knowledge-application/PptSettingsModal';
import CodeSettingsModal from './knowledge/knowledge-application/CodeSettingsModal';
import ImagePickerModal from './knowledge/chat/ImagePickerModal';
import PptTaskRecoveryModal from './knowledge/chat/PptTaskRecoveryModal';
import PptPreviewModal from './knowledge/knowledge-application/PptPreviewModal';
import PptPipelineStatusBar from './knowledge/knowledge-application/PptPipelineStatusBar';
import ChatMessageBubble from './knowledge/chat/ChatMessageBubble';
import TypingIndicator from './knowledge/chat/TypingIndicator';
import ChrysSessionBanner from './knowledge/chat/ChrysSessionBanner';
import ChatToolbar from './knowledge/chat/ChatToolbar';
import ImageThumbnailBar from './knowledge/chat/ImageThumbnailBar';
import PptStructureDialog from './knowledge/knowledge-application/PptStructureDialog';
import KnowledgeBaseTreePanel from './knowledge/shared/KnowledgeBaseTreePanel';
import { buildChatCompletionsUrl, buildSystemPrompt, refineAnswerWithImages, describeImagesToText } from './knowledge/chatHelpers';
import { WIKI_BASE, DEFAULT_MODELS, DEFAULT_MODEL_ID, DEFAULT_PPT_PROMPT, DEFAULT_PPT_AGENT, DEFAULT_CODE_PROMPT, DEFAULT_CODE_AGENT } from './knowledge/shared/constants';
import { readMemoryFile, writeMemoryFile, getFs as getFsRef } from './knowledge/shared/memoryFile';
import { buildFileTree } from './knowledge/shared/fileTree';
import { extractAndCleanCitations, buildReferenceMaterialsSection, appendReferenceMaterials } from './knowledge/shared/citations';
import { renderMarkdown } from './knowledge/shared/renderMarkdown';
import useModelConfig from './knowledge/hooks/useModelConfig';
import useRemoteTree from './knowledge/hooks/useRemoteTree';
import useBrowsing from './knowledge/hooks/useBrowsing';
import useHiDesk from './knowledge/hooks/useHiDesk';
import useWebSearch from './knowledge/hooks/useWebSearch';
import usePptPipeline from './knowledge/hooks/usePptPipeline';

// 标记自动启动后台任务是否已显示（每次页面加载仅显示一次）
let autoStartTasksShown = false;

function KnowledgeManagement({ theme, tabs, setTabs, activeTab, setActiveTab, tabStates, setTabStates, userInfo }) {
  const [showDomainDropdown, setShowDomainDropdown] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  
  // Wiki区域状态
  const [importPath, setImportPath] = useState('');
  const [selectedKBIds, setSelectedKBIds] = useState([]);
  const [projectPath, setProjectPath] = useState('');
  const [showFileListModal, setShowFileListModal] = useState(false);
  const [fileList, setFileList] = useState([]);
  const [fileTree, setFileTree] = useState([]);
  const [browseTarget, setBrowseTarget] = useState('importPath');
  
  // 知识库列表和创建弹窗状态
  const [knowledgeBaseList, setKnowledgeBaseList] = useState([]);
  const [showCreateKBModal, setShowCreateKBModal] = useState(false);
  const [newKBName, setNewKBName] = useState('');
  const [newKBPath, setNewKBPath] = useState('');
  const [lastKbDir, setLastKbDir] = useState('');
  
  // 知识库设置弹窗状态
  const [showKBSettingsModal, setShowKBSettingsModal] = useState(false);
  // 预处理设置弹窗状态
  const [showPreprocessorSettingsModal, setShowPreprocessorSettingsModal] = useState(false);
  const [editingKB, setEditingKB] = useState(null);
  const [editingKBName, setEditingKBName] = useState('');
  const [editingKBDesc, setEditingKBDesc] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState('');
  const [kbKnowledgeList, setKbKnowledgeList] = useState([]);
  const kbKnowledgeTree = useMemo(() => buildFileTree(kbKnowledgeList), [kbKnowledgeList]);
  const [kbKnowledgeLoading, setKbKnowledgeLoading] = useState(false);
  const [kbStats, setKbStats] = useState({});

  // 当前活跃知识库（用于右侧面板扁平显示）
  const [activeKbForTree, setActiveKbForTree] = useState(null);

  // 树状目录可拖拽调整宽度
  const [treePanelWidth, setTreePanelWidth] = useState(140);
  const treePanelRef = useRef(null);
  const isResizingRef = useRef(false);

  const handleTreeResizeStart = useCallback((e) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.min(400, Math.max(100, e.clientX - (treePanelRef.current?.parentElement?.getBoundingClientRect().left || 0)));
      setTreePanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const [kbIngestStatus, setKbIngestStatus] = useState({});
  // 搜索导入状态
  const [showSearchImport, setShowSearchImport] = useState(false);
  const [searchImportQuery, setSearchImportQuery] = useState('');
  const [searchImportResults, setSearchImportResults] = useState([]);
  const [searchImportSelected, setSearchImportSelected] = useState(new Set());
  const [searchImportLoading, setSearchImportLoading] = useState(false);
  const [searchImportImporting, setSearchImportImporting] = useState(false);
  const [searchImportTargetKB, setSearchImportTargetKB] = useState(null);
  const searchImportInputRef = useRef(null);
  const newKBNameInputRef = useRef(null);
  const newKBPathInputRef = useRef(null);

  // 搜索导入弹窗打开时，显式聚焦输入框
  useEffect(() => {
    if (showSearchImport && searchImportInputRef.current) {
      searchImportInputRef.current.focus();
    }
  }, [showSearchImport]);

  // 创建知识库弹窗打开时，聚焦名称输入框
  useEffect(() => {
    if (showCreateKBModal && newKBNameInputRef.current) {
      newKBNameInputRef.current.focus();
    }
  }, [showCreateKBModal]);
  const [kbMetadata, setKbMetadata] = useState({});

  const updateKbMetadata = (kbId, meta) => {
    setKbMetadata(prev => ({ ...prev, [kbId]: meta }));
    const currentMeta = readMemoryFile().kbMetadata || {};
    currentMeta[kbId] = meta;
    writeMemoryFile({ kbMetadata: currentMeta });
  };

  const removeKbMetadata = (kbId) => {
    setKbMetadata(prev => {
      const next = { ...prev };
      delete next[kbId];
      return next;
    });
    const currentMeta = readMemoryFile().kbMetadata || {};
    delete currentMeta[kbId];
    writeMemoryFile({ kbMetadata: currentMeta });
  };

  const getKBStatus = (kbId) => {
    // 正在预处理的 KB 优先显示"预处理中"
    if (preprocessingKbIds.has(kbId)) {
      return { status: 'preprocessing', color: 'blue', label: '预处理中' };
    }
    const stats = kbStats[kbId];
    const ingest = kbIngestStatus[kbId];
    if (!stats || stats.total === 0) {
      // 即使 sources 为空，也可能有摄入或删除队列在运行
      if (ingest) {
        if (ingest.ingestProcessing || ingest.ingestPending) return { status: 'processing', color: 'yellow', label: '导入中' };
        if (ingest.deleteProcessing || ingest.deletePending) return { status: 'deleting', color: 'orange', label: '删除中' };
      }
      return { status: 'empty', color: 'gray', label: '无知识' };
    }
    if (stats.processing > 0) {
      return { status: 'processing', color: 'yellow', label: '处理中' };
    }
    // 使用实时队列状态覆盖粗略估计
    if (ingest) {
      if (ingest.ingestProcessing || ingest.ingestPending) return { status: 'processing', color: 'yellow', label: '导入中' };
      if (ingest.deleteProcessing || ingest.deletePending) return { status: 'deleting', color: 'orange', label: '删除中' };
      if (ingest.ingestFailed > 0 || ingest.deleteFailed > 0) return { status: 'error', color: 'red', label: '异常' };
    }
    return { status: 'ready', color: 'green', label: '正常' };
  };

  const fetchKBStats = async (kb) => {
    const kbId = kb.id || kb.knowledge_base_id;
    const projectPath = kb.path;
    const genSnapshot = kbGenerationRef.current;
    try {
      let documents = 0;
      let web = 0;
      let total = 0;
      let processing = 0;
      let wikiPages = 0;

      const overviewRes = await fetch(`http://127.0.0.1:5002/api/v1/projects/${kbId}/overview`);
      if (kbGenerationRef.current !== genSnapshot) return;
      if (overviewRes.ok) {
        const overviewData = await overviewRes.json();
        if (overviewData.success && overviewData.data && overviewData.data.stats) {
          const s = overviewData.data.stats;
          wikiPages = s.wiki_pages || 0;
        }
      }

      if (projectPath) {
        const sourcesRes = await fetch(`http://127.0.0.1:5002/api/v1/projects/sources?project_path=${encodeURIComponent(projectPath)}&recursive=true`);
        if (kbGenerationRef.current !== genSnapshot) return;
        if (sourcesRes.ok) {
          const sourcesData = await sourcesRes.json();
          if (sourcesData.success && sourcesData.data && sourcesData.data.sources) {
            const sources = sourcesData.data.sources;
            const fileSources = sources.filter(s => !s.is_dir);
            const webSources = sources.filter(s => !s.is_dir && ((s.filename && s.filename.endsWith('.url')) || (s.relative_path && s.relative_path.includes('web'))));
            documents = fileSources.length - webSources.length;
            web = webSources.length;
            total = fileSources.length;
          }
        }
      }

      if (total > 0 && wikiPages === 0) {
        processing = total;
      }

      // 代际守卫：如果已切换 KB，丢弃过期结果
      if (kbGenerationRef.current !== genSnapshot) return;
      setKbStats(prev => ({ ...prev, [kbId]: { documents, web, total, processing, wikiPages } }));

      // 同时获取摄入/删除队列实时状态
      if (projectPath) {
        try {
          const ingestRes = await fetch(`http://127.0.0.1:5002/api/v1/projects/ingest-status?project_path=${encodeURIComponent(projectPath)}`);
          if (kbGenerationRef.current !== genSnapshot) return;
          if (ingestRes.ok) {
            const ingestData = await ingestRes.json();
            if (ingestData.success && ingestData.data) {
              const d = ingestData.data;
              const s = d.summary || {};
              const ds = d.delete_summary || {};
              if (kbGenerationRef.current !== genSnapshot) return;
              setKbIngestStatus(prev => ({
                ...prev,
                [kbId]: {
                  ingestProcessing: s.processing > 0,
                  ingestPending: s.pending > 0,
                  ingestFailed: s.failed,
                  ingestDone: s.done,
                  deleteProcessing: ds.processing > 0,
                  deletePending: ds.pending > 0,
                  deleteFailed: ds.failed,
                  deleteDone: ds.done,
                  ingestTotal: s.total,
                  deleteTotal: ds.total,
                },
              }));
            }
          }
        } catch (_) {
          // ignore ingest status errors
        }
      }
    } catch (e) {
      console.error('Failed to fetch KB stats:', e);
    }
  };

  const fetchAllKBStats = async (kbList) => {
    const list = kbList || knowledgeBaseList;
    const genSnapshot = kbGenerationRef.current;
    for (const kb of list) {
      // 代际守卫：如果 KB 已切换，停止后续轮询
      if (kbGenerationRef.current !== genSnapshot) return;
      await fetchKBStats(kb);
    }
  };

  useEffect(() => {
    if (knowledgeBaseList.length > 0) {
      fetchAllKBStats();
      const interval = setInterval(() => {
        // 代际守卫：如果 KB 已切换，跳过本轮轮询（interval 不自动清理，但回调无效）
        fetchAllKBStats();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [knowledgeBaseList]);

  // 向量可视化状态
  const [showVectorModal, setShowVectorModal] = useState(false);
  const [vectorData, setVectorData] = useState(null);
  const [vectorLoading, setVectorLoading] = useState(false);
  const [vectorError, setVectorError] = useState('');
  const vectorCanvasRef = useRef(null);
  const vectorTooltipRef = useRef(null);

  // 跟踪自动启动后台任务的 taskId（按 taskKey 索引）
  const autoStartTaskRef = useRef({});

  // KB 切换保护：abort 控制器 + 代际守卫，防止旧项目异步回调污染新项目
  const fetchAbortRef = useRef(null);
  const kbGenerationRef = useRef(0);

  // 切换确认弹窗（有进行中任务时提示用户）
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false);
  const [pendingSwitchKb, setPendingSwitchKb] = useState(null);

  // 知识库层级映射（纯逻辑层级，不改变文件系统路径）
  // 格式: { parentKbKey: [childKbKey1, childKbKey2, ...] }
  const [kbHierarchy, setKbHierarchy] = useState({});
  const kbHierarchyRef = useRef({});
  const updateKbHierarchy = useCallback((newHierarchy) => {
    setKbHierarchy(newHierarchy);
    kbHierarchyRef.current = newHierarchy;
    writeMemoryFile({ kbHierarchy: newHierarchy });
  }, []);

  const loadMemory = () => {
    const data = readMemoryFile();
    if (data.lastKbDir) setLastKbDir(data.lastKbDir);
    if (data.platforms) setPlatforms(prev => ({ ...prev, ...data.platforms }));
    if (data.webSearchConfig) {
      setSearchEngine(data.webSearchConfig.engine || 'bing');
      setSearxngUrl(data.webSearchConfig.searxng_url || '');
    }
    if (data.hiDeskServer) setHiDeskServer(prev => ({ ...prev, ...data.hiDeskServer }));
    else writeMemoryFile({ hiDeskServer: { ip: '127.0.0.1', port: 5858 } });
    if (data.hiDeskRemoteConfig) setHiDeskRemoteConfig(prev => ({ ...prev, ...data.hiDeskRemoteConfig }));
    else writeMemoryFile({ hiDeskRemoteConfig: { ip: '7.212.122.246', remotePath: '/home/Knowledge_Management/HiDesk_Knowledge_API.exe' } });
    if (data.activeKnowledgeBases && Array.isArray(data.activeKnowledgeBases) && data.activeKnowledgeBases.length > 0) {
      setSelectedKBIds(data.activeKnowledgeBases);
      const lastKey = data.activeKnowledgeBases[data.activeKnowledgeBases.length - 1];
      if (data.activeKnowledgeBase && data.activeKnowledgeBase.path) {
        setProjectPath(data.activeKnowledgeBase.path);
      }
    } else if (data.activeKnowledgeBase) {
      const kb = data.activeKnowledgeBase;
      if (kb.id) setSelectedKBIds([kb.id]);
      if (kb.path) setProjectPath(kb.path);
    }
    // 预处理服务配置
    if (data.preprocessor) {
      // 合并默认 processors 中可能新增的项（保留用户已有配置）
      const mergedProcessors = { ...DEFAULT_PROCESSORS, ...(data.preprocessor.processors || {}) };
      setPreprocessorConfig({ ...data.preprocessor, processors: mergedProcessors });
    } else {
      writeMemoryFile({ preprocessor: { enabled: false, port: 5900, timeout_seconds: 300, username: "", password: "", processors: { cloudmodeling_plantuml: { name: "CloudModeling PlantUML 转换", description: "将 Markdown 中的 CloudModeling diagram URL 转换为 PlantUML 代码块", enabled: true }, cloudmodeling_svg: { name: "CloudModeling SVG 导出", description: "PlantUML 转换失败时，回退导出为 SVG 图片引用", enabled: true }, image_to_desc: { name: "图片结构化分析 (image_to_desc)", description: "用 Vision LLM 将文档中图片转为结构化图表描述（Mermaid/表格/代码）", enabled: false } } } });
    }
    // 预处理自动管理
    if (data.preprocessorAutoManage !== undefined) {
      setPreprocessorAutoManage(data.preprocessorAutoManage);
    }
    // 加载保存的模型配置列表
    let _loadedModels = [];
    if (data.savedModels && Array.isArray(data.savedModels) && data.savedModels.length > 0) {
      setSavedModels(data.savedModels);
      _loadedModels = data.savedModels;
    } else {
      // 从用户配置目录加载默认模型配置
      try {
        const fs = getFsRef();
        const pathMod = window.require('path');
        const osMod = window.require('os');
        const modelsPath = pathMod.join(osMod.homedir(), '.SSSC_AI', 'models.json');
        if (fs.existsSync(modelsPath)) {
          const modelsConfig = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
          if (modelsConfig.MODELS && Array.isArray(modelsConfig.MODELS)) {
            setSavedModels([...modelsConfig.MODELS]);
            _loadedModels = modelsConfig.MODELS;
          }
        }
      } catch (_) {}
    }
    // 加载选中的模型配置ID
    const _loadedModelId = data.selectedModelConfigId || '';
    if (_loadedModelId) {
      setSelectedModelConfigId(_loadedModelId);
      // 同步当前模型到 Chrys Rust 后端（初始化时 Chrys 可能尚未启动，异步执行不阻塞）
      try {
        const { ipcRenderer } = window.require('electron');
        ipcRenderer.invoke('set-chrys-active-model', _loadedModelId).catch(() => {});
      } catch (_) {}
    }
    // 从已加载的模型列表中恢复当前 LLM 状态（取代旧 llmConfig 字段）
    if (_loadedModelId && _loadedModels.length > 0) {
      const matchedModel = _loadedModels.find(m => m.id === _loadedModelId) || _loadedModels[0];
      if (matchedModel) {
        if (matchedModel.url) setLlmUrl(matchedModel.url);
        if (matchedModel.apiKey) setLlmApiKey(matchedModel.apiKey);
        if (matchedModel.model) setLlmModel(matchedModel.model);
        if (matchedModel.embeddingModel) setLlmEmbeddingModel(matchedModel.embeddingModel);
      }
    }
    // 加载目标文件与回答模式配置
    if (data.qaConfig) {
      if (data.qaConfig.targetFileType) setTargetFileType(data.qaConfig.targetFileType);
      if (data.qaConfig.answerMode || data.qaConfig.workMode) setWorkMode(data.qaConfig.workMode || data.qaConfig.answerMode || 'normal');
    }
    // 加载统一的文档保存目录
    if (data.documentSettings) {
      if (data.documentSettings.outputDir) setOutputDir(data.documentSettings.outputDir);
    }
    // 加载 PPT 设置（精简后）
    if (data.pptSettings) {
      if (data.pptSettings.promptTemplate) setPptPromptTemplate(data.pptSettings.promptTemplate);
      if (data.pptSettings.template) setPptTemplate(data.pptSettings.template);
      if (data.pptSettings.referencePptx) setReferencePptx(data.pptSettings.referencePptx);
      if (data.pptSettings.workflowMode) setPptWorkflowMode(data.pptSettings.workflowMode);
      if (data.pptSettings.mode) setPptMode(data.pptSettings.mode);
      if (data.pptSettings.visualStyle) setPptVisualStyle(data.pptSettings.visualStyle);
      if (data.pptSettings.contentFormat) setPptContentFormat(data.pptSettings.contentFormat);
      if (data.pptSettings.svgMaxWorkers != null) setPptSvgMaxWorkers(data.pptSettings.svgMaxWorkers);
    }
    // 加载代码生成自定义设置
    if (data.codeSettings) {
      if (data.codeSettings.outputDir) setCodeOutputDir(data.codeSettings.outputDir);
      if (data.codeSettings.promptTemplate) setCodePromptTemplate(data.codeSettings.promptTemplate);
      if (data.codeSettings.agent) setCodeAgent(data.codeSettings.agent);
    }
    // 加载问题历史记录
    if (data.questionHistory && Array.isArray(data.questionHistory)) {
      questionHistoryRef.current = data.questionHistory.slice(0, 100);
    }
    // 加载知识库元数据
    if (data.kbMetadata) {
      setKbMetadata(data.kbMetadata);
    }
    // 加载知识库层级映射
    if (data.kbHierarchy) {
      setKbHierarchy(data.kbHierarchy);
      kbHierarchyRef.current = data.kbHierarchy;
    }
    // 加载 HiDesk 问答模式（不存在时写入默认值确保 JSON 中可见）
    if (data.hiDeskChatMode) {
      setHiDeskChatMode(data.hiDeskChatMode);
    } else {
      writeMemoryFile({ hiDeskChatMode: 'stream' });
    }
  };

  const saveMemory = (dir) => {
    writeMemoryFile({ lastKbDir: dir });
    setLastKbDir(dir);
  };

  // ===== 公共知识库同步相关函数 =====

  // 获取已配置的服务器列表
  const fetchCommonKbServerList = async () => {
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/servers');
      const result = await resp.json();
      if (result.success && result.data) {
        setCommonKbServerList(result.data);
        if (result.data.length > 0 && !commonKbActiveServer) {
          setCommonKbActiveServer(result.data[0].name);
        }
      }
    } catch (e) {
      console.error('Failed to fetch server list:', e);
    }
  };

  // 切换服务器配置
  const switchCommonKbServer = async (serverName) => {
    if (!serverName || serverName === commonKbActiveServer) return;
    // 保存当前服务器的密码到本地缓存
    const data = readMemoryFile();
    const pwdCache = data.commonKbPasswordCache || {};
    if (commonKbActiveServer && commonKbConfig.password) {
      pwdCache[commonKbActiveServer] = commonKbConfig.password;
    }
    writeMemoryFile({ commonKbPasswordCache: pwdCache });

    setCommonKbActiveServer(serverName);
    // 从本地缓存恢复密码
    const cachedPassword = pwdCache[serverName] || '';
    // 从服务端加载该服务器配置
    try {
      const resp = await fetch(`http://127.0.0.1:5002/api/v1/common-kb/config?name=${encodeURIComponent(serverName)}`);
      const result = await resp.json();
      if (result.success && result.data) {
        const d = result.data;
        setCommonKbConfig({
          host: d.host || '',
          port: d.port || 22,
          username: d.username || 'root',
          password: cachedPassword,
          remotePath: d.remote_path || '',
          localPath: d.local_path || '',
        });
        writeMemoryFile({ commonKbConfig: { host: d.host, port: d.port, username: d.username, remotePath: d.remote_path, localPath: d.local_path } });
        // 重置状态
        setCommonKbStatus({ type: 'info', message: `已切换到: ${serverName}` });
        setCommonKbServerReachable(null);
        setCommonKbLocalExists(null);
      }
    } catch (e) {
      console.error('Failed to switch server:', e);
    }
  };

  // 加载公共知识库配置（从 memory file 和服务端）
  const loadCommonKbConfig = async () => {
    await fetchCommonKbServerList();
    // 先从本地 memory 加载
    const data = readMemoryFile();
    if (data.commonKbConfig) {
      setCommonKbConfig(prev => ({ ...prev, ...data.commonKbConfig }));
    }
    // 再从服务端加载（使用当前选中的服务器）
    const name = commonKbActiveServer || '';
    const url = name
      ? `http://127.0.0.1:5002/api/v1/common-kb/config?name=${encodeURIComponent(name)}`
      : 'http://127.0.0.1:5002/api/v1/common-kb/config';
    try {
      const resp = await fetch(url);
      const result = await resp.json();
      if (result.success && result.data) {
        const d = result.data;
        setCommonKbConfig(prev => ({
          ...prev,
          host: d.host || prev.host,
          port: d.port || prev.port,
          username: d.username || prev.username,
          remotePath: d.remote_path || prev.remotePath,
          localPath: d.local_path || prev.localPath,
        }));
      }
    } catch (e) {
      console.error('Failed to load common KB config:', e);
    }
  };

  // 保存公共知识库配置
  const saveCommonKbConfig = async () => {
    writeMemoryFile({ commonKbConfig: commonKbConfig });
    try {
      await fetch('http://127.0.0.1:5002/api/v1/common-kb/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: commonKbActiveServer || undefined,
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
          remote_path: commonKbConfig.remotePath,
          local_path: commonKbConfig.localPath,
        }),
      });
      // 刷新服务器列表
      await fetchCommonKbServerList();
    } catch (e) {
      console.error('Failed to save common KB config to server:', e);
    }
  };

  // 新增公共知识库服务器
  const addCommonKbServer = async () => {
    if (!newServerName.trim()) {
      setCommonKbStatus({ type: 'error', message: '请输入服务器名称' });
      return;
    }
    try {
      await fetch('http://127.0.0.1:5002/api/v1/common-kb/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newServerName.trim(),
          host: newServerConfig.host,
          port: newServerConfig.port,
          username: newServerConfig.username,
          password: newServerConfig.password,
          remote_path: newServerConfig.remotePath,
          local_path: newServerConfig.localPath,
        }),
      });
      // 刷新服务器列表并切换到新服务器
      await fetchCommonKbServerList();
      setCommonKbActiveServer(newServerName.trim());
      setCommonKbStatus({ type: 'success', message: `已添加服务器: ${newServerName.trim()}` });
      // 重置表单
      setShowAddServerForm(false);
      setNewServerName('');
      setNewServerConfig({
        host: '',
        port: 22,
        username: 'root',
        password: '',
        remotePath: '/home/Knowledge_Management/common',
        localPath: 'D:\\Knowledge_Management\\common',
      });
    } catch (e) {
      console.error('Failed to add server:', e);
      setCommonKbStatus({ type: 'error', message: `添加失败: ${e.message}` });
    }
  };

  // 删除公共知识库服务器
  const deleteCommonKbServer = async (serverName) => {
    if (!serverName) return;
    if (!window.confirm(`确定要删除服务器 "${serverName}" 的配置吗？此操作不可撤销。`)) return;
    try {
      const resp = await fetch(`http://127.0.0.1:5002/api/v1/common-kb/config?name=${encodeURIComponent(serverName)}`, {
        method: 'DELETE',
      });
      const result = await resp.json();
      if (result.success) {
        setCommonKbStatus({ type: 'info', message: `已删除服务器: ${serverName}` });
        // 刷新服务器列表
        const listResp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/servers');
        const listResult = await listResp.json();
        if (listResult.success && listResult.data) {
          setCommonKbServerList(listResult.data);
          // 如果删除的是当前活跃服务器，切换到第一个
          if (serverName === commonKbActiveServer) {
            const newActive = listResult.data.length > 0 ? listResult.data[0].name : '';
            setCommonKbActiveServer(newActive);
            if (newActive) {
              await switchCommonKbServer(newActive);
            }
          }
        }
      } else {
        setCommonKbStatus({ type: 'error', message: result.message || '删除失败' });
      }
    } catch (e) {
      console.error('Failed to delete server:', e);
      setCommonKbStatus({ type: 'error', message: `删除失败: ${e.message}` });
    }
  };

  // 检测本地公共知识库
  const checkCommonKbLocal = async () => {
    setCommonKbCheckingLocal(true);
    setCommonKbStatus(null);
    try {
      const name = commonKbActiveServer;
      // 先从服务端加载当前活跃服务器的配置，确保 localPath 是最新的
      if (name) {
        try {
          const cfgResp = await fetch(`http://127.0.0.1:5002/api/v1/common-kb/config?name=${encodeURIComponent(name)}`);
          const cfgResult = await cfgResp.json();
          if (cfgResult.success && cfgResult.data) {
            const d = cfgResult.data;
            setCommonKbConfig(prev => ({
              ...prev,
              host: d.host || prev.host,
              port: d.port || prev.port,
              username: d.username || prev.username,
              remotePath: d.remote_path || prev.remotePath,
              localPath: d.local_path || prev.localPath,
            }));
          }
        } catch { /* ignore */ }
      }

      const url = name
        ? `http://127.0.0.1:5002/api/v1/common-kb/check-local?name=${encodeURIComponent(name)}`
        : 'http://127.0.0.1:5002/api/v1/common-kb/check-local';
      const resp = await fetch(url);
      const result = await resp.json();
      if (result.success && result.data) {
        setCommonKbLocalExists(result.data.exists);
        if (result.data.exists) {
          const subdirCount = result.data.total_items || 0;
          // 优先使用 API 返回的路径
          const localPath = result.data.path || commonKbConfig.localPath;
          setCommonKbStatus({ type: 'success', message: `公共知识库已存在 (${subdirCount} 个子项目)` });
          if (localPath) {
            try {
              await registerCommonKbSubdirs(localPath);
              await fetchKnowledgeBaseList();
              // 重新获取项目列表并统计各公共知识库的源文件总数
              const updatedResp = await fetch('http://127.0.0.1:5002/api/v1/projects');
              const updatedData = await updatedResp.json();
              const projects = (updatedData.data && updatedData.data.projects) ? updatedData.data.projects : [];
              const pp = localPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
              const publicProjects = projects.filter(kb => {
                const kp = (kb.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                return pp && kp.startsWith(pp) && kp !== pp;
              });
              let totalSourceFiles = 0;
              for (const kb of publicProjects) {
                if (kb.path) {
                  try {
                    const srcRes = await fetch(`http://127.0.0.1:5002/api/v1/projects/sources?project_path=${encodeURIComponent(kb.path)}&recursive=true`);
                    if (srcRes.ok) {
                      const srcData = await srcRes.json();
                      if (srcData.success && srcData.data?.sources) {
                        totalSourceFiles += srcData.data.sources.filter(s => !s.is_dir).length;
                      }
                    }
                  } catch { /* skip failed KB */ }
                }
              }
              setCommonKbStatus({ type: 'success', message: `公共知识库已存在: ${subdirCount} 个子项目, ${totalSourceFiles} 个源文件` });
            } catch (e) {
              console.error('Failed to register common KB:', e);
            }
          }
        } else {
          setCommonKbStatus({ type: 'info', message: '本地公共知识库不存在' });
        }
      } else {
        setCommonKbStatus({ type: 'error', message: result.message || '检测失败' });
      }
    } catch (e) {
      setCommonKbStatus({ type: 'error', message: `检测失败: ${e.message}` });
    } finally {
      setCommonKbCheckingLocal(false);
    }
  };

  // 检测服务器可达性
  const checkCommonKbServer = async () => {
    if (!commonKbConfig.host) {
      setCommonKbStatus({ type: 'error', message: '请先配置服务器 IP' });
      return;
    }
    setCommonKbCheckingServer(true);
    setCommonKbStatus(null);
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/check-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
        }),
      });
      const result = await resp.json();
      if (result.success && result.data) {
        const d = result.data;
        setCommonKbServerReachable(d.server_reachable && d.ssh_authenticated);
        if (d.server_reachable && d.ssh_authenticated) {
          setCommonKbStatus({ type: 'success', message: '服务器可达，SSH 认证通过' });
        } else if (d.server_reachable) {
          setCommonKbStatus({ type: 'error', message: d.error || 'SSH 认证失败' });
          setCommonKbServerReachable(false);
        } else {
          setCommonKbStatus({ type: 'error', message: d.error || '服务器不可达' });
          setCommonKbServerReachable(false);
        }
      } else {
        setCommonKbStatus({ type: 'error', message: result.message || '检测失败' });
      }
    } catch (e) {
      setCommonKbStatus({ type: 'error', message: `检测失败: ${e.message}` });
    } finally {
      setCommonKbCheckingServer(false);
    }
  };

  // 同步公共知识库：先弹窗展示远端目录树，用户勾选后下载
  const syncCommonKb = async () => {
    if (!commonKbConfig.host) {
      setCommonKbStatus({ type: 'error', message: '请先配置服务器 IP' });
      return;
    }
    setRemoteTreeLoading(true);
    setRemoteTreeError(null);
    setRemoteTreeChecked(new Set());
    setCommonKbStatus({ type: 'info', message: '正在获取远程目录结构...' });
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/remote-tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
          remote_path: commonKbConfig.remotePath,
        }),
      });
      const result = await resp.json();
      if (result.success && result.data) {
        setRemoteTreeData(result.data);
        setRemoteTreeExpanded(new Set([result.data.path]));
        setShowRemoteTreeModal(true);
        setCommonKbStatus(null);
      } else {
        setRemoteTreeError(result.error || result.message || '获取目录结构失败');
        setCommonKbStatus({ type: 'error', message: result.error || result.message || '获取远程目录结构失败' });
      }
    } catch (e) {
      setRemoteTreeError(`获取失败: ${e.message}`);
      setCommonKbStatus({ type: 'error', message: `获取远程目录结构失败: ${e.message}` });
    } finally {
      setRemoteTreeLoading(false);
    }
  };

  // 执行实际同步（弹窗中确认后调用）
  const doSyncCommonKb = async () => {
    setShowRemoteTreeModal(false);
    const selectedPaths = [...remoteTreeChecked];
    if (selectedPaths.length === 0) {
      setCommonKbStatus({ type: 'error', message: '未选择任何项目' });
      return;
    }
    setCommonKbSyncing(true);
    setCommonKbStatus({ type: 'info', message: '正在使用 SFTP 下载公共知识库...' });
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
          remote_path: commonKbConfig.remotePath,
          local_path: commonKbConfig.localPath,
          selected_paths: selectedPaths,
        }),
      });
      const result = await resp.json();

      if (!result.success) {
        setCommonKbSyncing(false);
        setCommonKbStatus({ type: 'error', message: result.data?.message || result.message || '同步启动失败' });
        return;
      }

      const taskId = result.data?.task_id;
      if (!taskId) {
        setCommonKbSyncing(false);
        setCommonKbStatus({ type: 'error', message: '未获取到任务 ID' });
        return;
      }

      // 轮询进度
      const pollProgress = async () => {
        try {
          const progResp = await fetch(`http://127.0.0.1:5002/api/v1/common-kb/sync-progress?task_id=${encodeURIComponent(taskId)}`);
          const progResult = await progResp.json();
          const prog = progResult.data || {};

          if (prog.status === 'downloading') {
            // 显示下载进度
            const downloaded = prog.downloaded_files || 0;
            const total = prog.total_files || 0;
            const progressMsg = total > 0
              ? `正在使用 SFTP 下载公共知识库... (${downloaded}/${total})`
              : prog.message || '正在下载中...';
            setCommonKbStatus({ type: 'info', message: progressMsg });
            return true; // 继续轮询
          } else if (prog.status === 'running') {
            setCommonKbStatus({ type: 'info', message: prog.message || '准备中...' });
            return true; // 继续轮询
          } else if (prog.status === 'done') {
            setCommonKbSyncing(false);
            setCommonKbLocalExists(true);
            setCommonKbStatus({ type: 'success', message: prog.message || '同步完成' });
            // 注册知识库子目录
            const localPath = commonKbConfig.localPath;
            if (localPath) {
              registerCommonKbSubdirs(localPath)
                .then(() => fetchKnowledgeBaseList())
                .then(() => {
                  setTimeout(() => checkCommonKbLocal(), 500);
                })
                .catch(e => console.error('Failed to register common KB after sync:', e));
            }
            return false; // 停止轮询
          } else if (prog.status === 'error') {
            setCommonKbSyncing(false);
            setCommonKbStatus({ type: 'error', message: prog.message || '同步失败' });
            return false; // 停止轮询
          } else {
            // not_found 或其他未知状态
            setCommonKbStatus({ type: 'info', message: '准备同步...' });
            return true;
          }
        } catch (e) {
          // 轮询出错，继续尝试
          return true;
        }
      };

      // 立即开始轮询
      const intervalId = setInterval(async () => {
        const shouldContinue = await pollProgress();
        if (!shouldContinue) {
          clearInterval(intervalId);
        }
      }, 500);
    } catch (e) {
      setCommonKbSyncing(false);
      setCommonKbStatus({ type: 'error', message: `同步失败: ${e.message}` });
    }
  };

  useEffect(() => {
    loadMemory();
    fetchWebSearchConfig();
    // 启动时检查海问思答登录状态（后端会自动加载缓存的 cookie）
    checkHaiwenStatus();
  }, []);

  // 检查海问思答登录状态
  const checkHaiwenStatus = async () => {
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/haiwen/status');
      const data = await resp.json();
      if (data.success && data.authenticated) {
        setHaiwenAuthenticated(true);
      } else {
        setHaiwenAuthenticated(false);
      }
    } catch (e) {
      // 后端未启动时忽略
      console.log('[Haiwen] Status check skipped (backend not running)');
    }
  };

  // 图片相关状态
  const [images, setImages] = useState([]);
  const [showImageModal, setShowImageModal] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const fileInputRef = useRef(null);
  
  // Toast 通知
  const [toast, setToast] = useState({ show: false, message: '' });
  
  // 通用辅助：延迟恢复聊天输入框焦点
  // Electron 原生对话框/alert 会夺走窗口焦点，需要多重策略恢复
  const refocusInput = (delay = 200) => {
    setTimeout(() => {
      const el = chatInputRef.current;
      if (!el) return;
      // 先尝试恢复窗口焦点（Electron 下关键步骤）
      window.focus();
      el.focus();
      // RAF 确保 DOM 布局完成后再试一次
      requestAnimationFrame(() => {
        el.focus();
        // click 比 focus 更可靠地激活 input
        try { el.click(); } catch (_) {}
      });
    }, delay);
  };
  const toastTimerRef = useRef(null);
  const toastRef = useRef({
    show: (msg) => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast({ show: true, message: msg });
      toastTimerRef.current = setTimeout(() => {
        setToast({ show: false, message: '' });
      }, 2500);
    }
  });
  
  // 可拖动分隔条状态
  const [leftWidth, setLeftWidth] = useState(25);
  const [rightWidth, setRightWidth] = useState(18);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  
  // 平台状态（这些是UI状态，不需要持久化）
  const [platforms, setPlatforms] = useState({
    hiDesk: false,
    haiwen: false,
    local: false,
    webSearch: false
  });
  // 平台翻页 tab：当两个平台都启用时，切换显示 HiDesk 或 本地知识
  const [platformTab, setPlatformTab] = useState('local');

  // HiDesk 服务器配置
  const [hiDeskServer, setHiDeskServer] = useState({ ip: '127.0.0.1', port: 5858 });
  const [hiDeskConfigured, setHiDeskConfigured] = useState(false);
  const [hiDeskTesting, setHiDeskTesting] = useState(false);
  const [hiDeskTestResult, setHiDeskTestResult] = useState(null);

  // HiDesk 远端数据
  const [hiDeskDomains, setHiDeskDomains] = useState([]);

  // 海问思答状态
  const [haiwenAuthenticated, setHaiwenAuthenticated] = useState(false);
  const [showHaiwenLogin, setShowHaiwenLogin] = useState(false);
  const [haiwenUsername, setHaiwenUsername] = useState('');
  const [haiwenPassword, setHaiwenPassword] = useState('');
  const [haiwenLoggingIn, setHaiwenLoggingIn] = useState(false);
  const [haiwenLoginError, setHaiwenLoginError] = useState('');

  const [hiDeskDatasets, setHiDeskDatasets] = useState([]);
  const [hiDeskViews, setHiDeskViews] = useState([]);
  const [hiDeskRawConfig, setHiDeskRawConfig] = useState(null);
  const [hiDeskFetchingConfig, setHiDeskFetchingConfig] = useState(false);
  const [hiDeskRefreshing, setHiDeskRefreshing] = useState(false);
  const [hiDeskSelectedDomain, setHiDeskSelectedDomain] = useState('');
  const [hiDeskSelectedDataset, setHiDeskSelectedDataset] = useState('');
  const [hiDeskSelectedView, setHiDeskSelectedView] = useState('');
  const [hiDeskSelectedKbSn, setHiDeskSelectedKbSn] = useState(''); // 选中视图对应的 kb_sn
  const [hiDeskChatMode, setHiDeskChatMode] = useState('stream'); // 'stream' or 'sync'

  // HiDesk 远端下载配置（持久化，用户可直接修改 JSON）
  const [hiDeskRemoteConfig, setHiDeskRemoteConfig] = useState({
    ip: '7.212.122.246',
    remotePath: '/home/Knowledge_Management/HiDesk_Knowledge_API.exe',
  });

  const [hiDeskConfig, setHiDeskConfig] = useState('');
  const [localConfig, setLocalConfig] = useState('');
  const [webSearchAvailable, setWebSearchAvailable] = useState(null);
  const [webSearchChecking, setWebSearchChecking] = useState(false);

  // 公共知识库同步状态
  const [commonKbConfig, setCommonKbConfig] = useState({
    host: '7.212.122.246',
    port: 22,
    username: 'root',
    password: 'Huawei12#$',
    remotePath: '/home/Knowledge_Management/common',
    localPath: 'D:\\Knowledge_Management\\common',
  });
  const [commonKbCheckingLocal, setCommonKbCheckingLocal] = useState(false);
  const [commonKbCheckingServer, setCommonKbCheckingServer] = useState(false);
  const [commonKbSyncing, setCommonKbSyncing] = useState(false);
  const [commonKbStatus, setCommonKbStatus] = useState(null); // { type: 'info'|'success'|'error', message: '' }
  const [commonKbLocalExists, setCommonKbLocalExists] = useState(null); // null/true/false
  const [commonKbServerReachable, setCommonKbServerReachable] = useState(null);
  const [showCommonKbConfig, setShowCommonKbConfig] = useState(false);
  const [commonKbServerList, setCommonKbServerList] = useState([]);
  const [commonKbActiveServer, setCommonKbActiveServer] = useState('');

  // 新增服务器表单状态
  const [showAddServerForm, setShowAddServerForm] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerConfig, setNewServerConfig] = useState({
    host: '',
    port: 22,
    username: 'root',
    password: '',
    remotePath: '/home/Knowledge_Management/common',
    localPath: 'D:\\Knowledge_Management\\common',
  });

  // 远程目录树弹窗状态
  const [showRemoteTreeModal, setShowRemoteTreeModal] = useState(false);
  const [remoteTreeData, setRemoteTreeData] = useState(null);
  const [remoteTreeLoading, setRemoteTreeLoading] = useState(false);
  const [remoteTreeError, setRemoteTreeError] = useState(null);
  const [remoteTreeChecked, setRemoteTreeChecked] = useState(new Set());
  const [remoteTreeExpanded, setRemoteTreeExpanded] = useState(new Set());

  const { collectAllPaths, collectChildPaths, toggleTreeNode, getNodeCheckState } = useRemoteTree({
    remoteTreeChecked, setRemoteTreeChecked,
  });

  // 当平台勾选状态变化时，自动切换 tab
  useEffect(() => {
    const enabled = [
      platforms.haiwen && 'haiwen',
      platforms.hiDesk && 'hiDesk',
      platforms.local && 'local',
    ].filter(Boolean);

    if (enabled.length === 1) {
      setPlatformTab(enabled[0]);
    }
    // 多平台启用或全部关闭时，保持当前 tab
  }, [platforms.hiDesk, platforms.local, platforms.haiwen]);

  // 将知识库列表分为公共和个人
  // 判断知识库是否属于公共知识库路径
  const isCommonKb = (kb) => {
    const publicPath = commonKbConfig.localPath ? commonKbConfig.localPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
    if (!publicPath) return false;
    const kbPath = (kb.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return kbPath.startsWith(publicPath) && kbPath !== publicPath;
  };

  // 判断知识库是否为公共知识库的父目录（父目录本身不是知识库，不应在任何列表中显示）
  const isCommonKbParentDir = (kb) => {
    const publicPath = commonKbConfig.localPath ? commonKbConfig.localPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
    if (!publicPath) return false;
    const kbPath = (kb.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return kbPath === publicPath;
  };

  const [mcpRunning, setMcpRunning] = useState(false);
  const [mcpMode, setMcpMode] = useState(null);
  const [wikiRunning, setWikiRunning] = useState(false);
  const [kmaRunning, setKmaRunning] = useState(false);

  // 当前正在进行预处理的 KB id 集合（用于卡片状态显示"预处理中"）
  const [preprocessingKbIds, setPreprocessingKbIds] = useState(new Set());

  // rescan 进度轮询
  // { [kbId]: { status: 'running'|'done'|'error', pct: number, done: number, total: number, timer: NodeJS.Timeout } }
  const [kbRescanProgress, setKbRescanProgress] = useState({});
  const kbRescanTimersRef = useRef({});

  // 导入/预处理实时进度（导入是串行的，全局只保留一个活动任务）
  // { active, taskId, status, stage, message, currentFile, plantumlTotal, plantumlDone, elapsedSeconds }
  const [importProgress, setImportProgress] = useState({ active: false });
  const importProgressTimerRef = useRef(null);

  // 保存的模型配置列表
  const [savedModels, setSavedModels] = useState([]);
  const [selectedModelConfigId, setSelectedModelConfigId] = useState(DEFAULT_MODEL_ID);
  const [chrysSessionId, setChrysSessionId] = useState(null); // 当前 PPT 多轮对话的 session ID
  const [chrysCodeSessionId, setChrysCodeSessionId] = useState(null); // 当前代码多轮对话的 session ID
  const [showModelList, setShowModelList] = useState(false);
  const [newModelName, setNewModelName] = useState('');

  // LLM 配置状态
  const [showLlmConfig, setShowLlmConfig] = useState(false);
  const [llmUrl, setLlmUrl] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmEmbeddingModel, setLlmEmbeddingModel] = useState('');
  const [llmConfigLoading, setLlmConfigLoading] = useState(false);
  const [llmConfigSaving, setLlmConfigSaving] = useState(false);
  const [llmConfigStatus, setLlmConfigStatus] = useState(null);

  const { saveModelConfig, deleteModelConfig, syncModelsToChrys, syncModelsToConfigFile, selectModelConfig } = useModelConfig({
    savedModels, setSavedModels,
    selectedModelConfigId, setSelectedModelConfigId,
    newModelName, setNewModelName,
    showModelList, setShowModelList,
    llmConfigStatus, setLlmConfigStatus,
    llmUrl, setLlmUrl, llmApiKey, setLlmApiKey,
    llmModel, setLlmModel, llmEmbeddingModel, setLlmEmbeddingModel,
    getFsRef, writeMemoryFile, DEFAULT_MODEL_ID,
  });

  // PPT 设置（精简后，统一在设置面板和意图确认弹窗中管理）
  const DEFAULT_PPT_PROMPT = '在当前目录下的ppt文件夹下生成一份ppt，无需确认方案直接生成；你可以使用llm-wiki MCP尝试获取需要的知识；ppt生成要求如下：';
  const [outputDir, setOutputDir] = useState('');  // 统一的文档保存目录
  const [pptPromptTemplate, setPptPromptTemplate] = useState(DEFAULT_PPT_PROMPT);
  const [pptTemplate, setPptTemplate] = useState('default');
  const [referencePptx, setReferencePptx] = useState('');  // 参考PPTX文件路径
  // 意图确认弹窗中选择的工作模式，默认 auto
  const [pptWorkflowMode, setPptWorkflowMode] = useState('auto');  // 'auto' | 'manual'
  // 沟通模式 & 视觉风格（取代旧 pptStyle）
  const [pptMode, setPptMode] = useState('briefing');
  const [pptVisualStyle, setPptVisualStyle] = useState('dark-tech');
  const [pptSvgMaxWorkers, setPptSvgMaxWorkers] = useState(8);
  // PPT 内容形式
  const [pptContentFormat, setPptContentFormat] = useState('detailed');  // 'detailed' | 'concise' | 'bullet'
  const [showPptSettings, setShowPptSettings] = useState(false);
  const [pptAgent, setPptAgent] = useState(DEFAULT_PPT_AGENT);
  const [pptAgentList, setPptAgentList] = useState([]);

  // PPT 沟通模式 & 视觉风格选项（label 内联说明）
  const PPT_MODES = [
    { value: 'pyramid', label: '结论先行：结论优先·MECE论证·适合决策汇报' },
    { value: 'narrative', label: '故事叙述：情境→冲突→解决·适合路演/案例/品牌' },
    { value: 'briefing', label: '中性简报：信息完整·等权铺陈·适合周报/参考' },
  ];
  const PPT_STYLES = [
    { value: 'dark-tech', label: '暗色科技：深色背景·发光点缀·适合 AI/技术/数据' },
    { value: 'swiss-minimal', label: '瑞士极简：白底黑字·网格对齐·无渐变·适合咨询/架构' },
    { value: 'soft-rounded', label: '柔和圆角：浅色背景·圆角卡片·适合产品/培训' },
    { value: 'editorial', label: '编辑出版：浅色背景·衬线体·适合金融/报告' },
    { value: 'glassmorphism', label: '毛玻璃：深色背景·磨砂面板·渐变光效·适合 SaaS/发布/AI 演示' },
    { value: 'blueprint', label: '工程蓝图：深色图纸·等轴测线条·适合架构/工程/系统设计' },
    { value: 'sketch-notes', label: '手绘笔记：暖纸底·涂鸦线·适合教育/培训/知识' },
    { value: 'ink-notes', label: '墨水白板：浅底墨线·极简强调·适合方法论/宣言' },
    { value: 'chalkboard', label: '黑板粉笔：深色板面·粉笔线条·适合教学/课堂' },
    { value: 'ink-wash', label: '水墨国风：宣纸留白·毛笔印记·适合文化/哲学/新中式' },
  ];

  // 代码生成设置
  const DEFAULT_CODE_PROMPT = '在当前目录下的code文件夹下生成代码，无需确认方案直接生成；你可以使用llm-wiki MCP尝试获取需要的知识；代码生成要求如下：';
  const DEFAULT_CODE_AGENT = 'Code';
  const [codeOutputDir, setCodeOutputDir] = useState('');
  const [codePromptTemplate, setCodePromptTemplate] = useState(DEFAULT_CODE_PROMPT);
  const [codeAgent, setCodeAgent] = useState(DEFAULT_CODE_AGENT);
  const [codeAgentList, setCodeAgentList] = useState([]);
  const [showCodeSettings, setShowCodeSettings] = useState(false);
  
  // 设置面板状态
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  // 耗时打点统计可视化弹窗状态
  const [showPerfStats, setShowPerfStats] = useState(false);
  // 进程树状态
  const [processTree, setProcessTree] = useState([]);
  const [processTreeLoading, setProcessTreeLoading] = useState(false);
  const [processTreeError, setProcessTreeError] = useState('');
  const [killPid, setKillPid] = useState(null); // 二次确认：点击一次瞄准，再点确认杀
  
  // 依赖工具版本检查（设置面板用）
  const [toolCheckLoading, setToolCheckLoading] = useState(false);
  const [toolCheckResult, setToolCheckResult] = useState(null);
  const [toolCheckError, setToolCheckError] = useState('');
  const [updatingTools, setUpdatingTools] = useState({});
  
  // 预处理服务配置
  const [preprocessorConfig, setPreprocessorConfig] = useState({
    enabled: false,
    port: 5900,
    timeout_seconds: 300,
    username: "",
    password: "",
    processors: {
      cloudmodeling_plantuml: { name: "CloudModeling PlantUML 转换", description: "将 Markdown 中的 CloudModeling diagram URL 转换为 PlantUML 代码块", enabled: true },
      cloudmodeling_svg: { name: "CloudModeling SVG 导出", description: "PlantUML 转换失败时，回退导出为 SVG 图片引用", enabled: true },
      image_to_desc: { name: "图片结构化分析 (image_to_desc)", description: "用 Vision LLM 将文档中图片转为结构化图表描述（Mermaid/表格/代码）", enabled: false },
    },
  });
  // 预处理服务自动管理
  const [preprocessorAutoManage, setPreprocessorAutoManage] = useState(false);
  const [preprocessorServiceStatus, setPreprocessorServiceStatus] = useState({});
  // 在线搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchDiagnostics, setSearchDiagnostics] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchEngine, setSearchEngine] = useState('bing');
  const [searxngUrl, setSearxngUrl] = useState('');
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [selectedSearchResults, setSelectedSearchResults] = useState([]);
  const [fetchingPageUrl, setFetchingPageUrl] = useState(null);
  const [proxyUrl, setProxyUrl] = useState('');

  // PPT 六步流水线状态（SSE）
  const [pipelineState, setPipelineState] = useState(null); // null | {running, steps, logs, stepDetails, result, error}
  const [pipelineDetailsOpen, setPipelineDetailsOpen] = useState(false);
  const pipelineAbortRef = useRef(null);
  const pipelineIdRef = useRef(null);
  const [pptStructureDialog, setPptStructureDialog] = useState(null); // manual 模式结构确认弹窗
  const [showPptTaskModal, setShowPptTaskModal] = useState(false);
  const [pptTasks, setPptTasks] = useState([]);
  const [pptTasksLoading, setPptTasksLoading] = useState(false);
  const [pptPreviewModal, setPptPreviewModal] = useState(null); // {previews, index}
  // 本地知识配置状态
  const [llmWikiLoading, setLlmWikiLoading] = useState(false);

  // 后台任务管理器
  const { tasks, runTask, cancelTask, clearCompleted, updateProgress, addTask, updateTask } = useTaskManager();

  // 处理取消任务（chrys 任务需要额外杀死进程）
  const handleCancelTask = useCallback((taskId) => {
    const task = tasks.find(t => t.id === taskId);
    if (task?.metadata?.type === 'chrys' && task.metadata.sessionId) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('cancel-chrys-session', task.metadata.sessionId).catch(() => {});
    }
    cancelTask(taskId);
  }, [tasks, cancelTask]);

  useEffect(() => {
    if (!pptPreviewModal) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setPptPreviewModal(null);
      } else if (e.key === 'ArrowLeft') {
        movePptPreviewModal(-1);
      } else if (e.key === 'ArrowRight') {
        movePptPreviewModal(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pptPreviewModal]);

  // 是否有 chrys 任务正在运行（多轮对话需等上一轮完成）
  const isChrysBusy = (chrysSessionId || chrysCodeSessionId) && tasks.some(t => t.status === 'running' && t.metadata?.type === 'chrys');
  const [showWikiWindow, setShowWikiWindow] = useState(false);
  const [showBrowseModal, setShowBrowseModal] = useState(false);
  const [showPathTypeModal, setShowPathTypeModal] = useState(false);
  const [browseMode, setBrowseMode] = useState('file');
  const [fileSystemItems, setFileSystemItems] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  
  // 从props获取状态
  const messages = useMemo(() => tabStates[activeTab]?.messages || [], [tabStates, activeTab]);
  const selectedDomains = useMemo(() => tabStates[activeTab]?.selectedDomain || [], [tabStates, activeTab]);
  const selectedPlatform = useMemo(() => tabStates[activeTab]?.selectedPlatform || [], [tabStates, activeTab]);
  const databasePath = useMemo(() => tabStates[activeTab]?.databasePath || '', [tabStates, activeTab]);
  const knowledgePath = useMemo(() => tabStates[activeTab]?.knowledgePath || '', [tabStates, activeTab]);
  const wikiUrl = useMemo(() => tabStates[activeTab]?.wikiUrl || '', [tabStates, activeTab]);
  
  // 状态更新函数
  const setMessages = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: {
        ...prev[activeTab],
        messages: typeof value === 'function'
          ? value(prev[activeTab]?.messages || [])
          : value
      }
    }));
  };
  
  const setSelectedDomains = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedDomain: value }
    }));
  };
  
  const setSelectedPlatform = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], selectedPlatform: value }
    }));
  };
  
  const setDatabasePath = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], databasePath: value }
    }));
  };
  
  const setKnowledgePath = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], knowledgePath: value }
    }));
  };
  
  const setWikiUrl = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], wikiUrl: value }
    }));
  };

  const {
    handleSelectFile, handleSelectDirectory, handleBrowseClick,
    handleNavigateTo, handleNavigateUp, handleConfirmSelection,
  } = useBrowsing({
    showPathTypeModal, setShowPathTypeModal,
    browseTarget, browseMode,
    setFileSystemItems, currentPath, setCurrentPath,
    parentPath, setParentPath,
    showBrowseModal, setShowBrowseModal,
    setImportPath, setNewKBPath, setKnowledgePath,
  });

  const addTab = () => {
    const newId = Math.max(...tabs.map(t => t.id), 0) + 1;
    setTabs([...tabs, { id: newId, name: `知识库 ${newId}` }]);
    setActiveTab(newId);
    setTabStates(prev => ({
      ...prev,
      [newId]: {
        messages: [{ type: 'assistant', content: '您好！我是您的AI助手，请问有什么可以帮助您的？' }],
        selectedDomain: [],
        selectedPlatform: [],
        databasePath: '',
        knowledgePath: '',
      },
    }));
  };

  const closeTab = (id) => {
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTab === id) {
      setActiveTab(newTabs[0]?.id || 1);
    }
  };
  
  const [chatInput, setChatInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [workMode, setWorkMode] = useState('normal'); // 'speed' | 'normal' | 'professional'
  const [renderMode, setRenderMode] = useState('markdown');
  const [searchMode, setSearchMode] = useState('graph');
  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);
  const questionHistoryRef = useRef([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInputRef = useRef('');

  // 处理输入框上下箭头键翻动历史记录
  const handleChatKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
      return;
    }

    const history = questionHistoryRef.current;
    if (history.length === 0) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex === -1) {
        // 开始导航历史，保存当前输入
        savedInputRef.current = chatInput;
        setHistoryIndex(0);
        setChatInput(history[0]);
      } else if (historyIndex < history.length - 1) {
        setHistoryIndex(historyIndex + 1);
        setChatInput(history[historyIndex + 1]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        setChatInput(history[historyIndex - 1]);
      } else if (historyIndex === 0) {
        // 回到用户原本输入的内容
        setHistoryIndex(-1);
        setChatInput(savedInputRef.current);
      }
    }
  };

  // 目标文件选择与回答模式
  const [targetFileType, setTargetFileType] = useState(null); // 'slides' | 'document' | 'image' | null
  // workMode is defined above as unified state for both Q&A style and search depth

  useEffect(() => {
    if (targetFileType !== 'slides' && pipelineState) {
      pipelineAbortRef.current?.abort?.();
      setPipelineState(null);
      setPipelineDetailsOpen(false);
    }
  }, [targetFileType, pipelineState]);

  // 将当前选中的模型配置推送到 KMA Server，覆盖可能存在的过期缓存
  const syncCurrentModelToKmaServer = async () => {
    try {
      // 发送空 body，后端从 models.json 读取当前活跃模型的配置，
      // 避免 React state 中的过时 config 值写入 app-state.json
      console.log('[syncCurrentModelToKmaServer] triggering backend to sync current active model');
      await fetch('http://127.0.0.1:5002/api/v1/server/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      console.log('[syncCurrentModelToKmaServer] succeeded');
    } catch (e) {
      console.error('[syncCurrentModelToKmaServer] failed:', e);
    }
  };

  // 确保 KMA 和 KMA Server 已启动（用于问答前自动检测与启动）
  const ensureKmaReady = async () => {
    // 1. 快速检测 KMA Server (5002) 是否健康
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/server/health', {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        await syncCurrentModelToKmaServer();
        return true;
      }
    } catch {}

    // 2. KMA Server 未运行，检查 llm-wiki 主进程
    const { ipcRenderer } = window.require('electron');
    try {
      const processCheck = await ipcRenderer.invoke('check-llm-wiki-process');
      if (!processCheck.running) {
        // llm-wiki 主进程未运行，尝试启动
        const binaryCheck = await ipcRenderer.invoke('check-llm-wiki-binary');
        if (!binaryCheck.exists) return false; // 未安装，无法启动

        const startResult = await ipcRenderer.invoke('start-llm-wiki-headless');
        if (!startResult.success) return false;

        const ready = await ipcRenderer.invoke('wait-llm-wiki-ready', 15000);
        if (!ready) return false;
      }

      // 3. 启动 KMA Server (5002)
      const wikiResult = await ipcRenderer.invoke('start-wiki-server');
      if (!wikiResult.success) return false;

      // 4. 等待 KMA Server 健康就绪
      for (let i = 0; i < 10; i++) {
        try {
          const resp = await fetch('http://127.0.0.1:5002/api/v1/server/health', {
            signal: AbortSignal.timeout(2000),
          });
          if (resp.ok) {
            await syncCurrentModelToKmaServer();
            return true;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
      return false;
    } catch {
      return false;
    }
  };

  const {
    performWebSearch, searchWeb, formatSearchDiagnostics,
    fetchWebSearchConfig, checkWebSearchConnectivity, fetchPageContent,
    toggleSearchResultSelection, collectSearchResultContent, collectSelectedSearchResults,
  } = useWebSearch({
    WIKI_BASE,
    searchEngine, setSearchEngine,
    searxngUrl, setSearxngUrl,
    proxyUrl,
    webSearchAvailable, setWebSearchAvailable,
    webSearchChecking, setWebSearchChecking,
    searchLoading, setSearchLoading,
    searchResults, setSearchResults,
    searchDiagnostics, setSearchDiagnostics,
    selectedSearchResults, setSelectedSearchResults,
    fetchingPageUrl, setFetchingPageUrl,
    platforms, setPlatforms,
    setMessages,
    writeMemoryFile,
  });
  const {
    runPptPipeline, resumePptPipeline, fetchPptTasks, resumePersistedPptTask,
    buildPptReviewMessage, updatePptReviewMessage, submitPptReviewMessage,
    buildIntentOptionsPayload, svgToPreviewSrc, openPptPreviewModal, movePptPreviewModal,
    renderPptReviewCard,
  } = usePptPipeline({
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
  });

  const getChatBubbleClass = (msg) => {
    if (msg.kind === 'ppt_review') {
      return 'w-full p-0 bg-transparent shadow-none';
    }
    if (msg.type === 'user') {
      return `px-4 py-3 rounded-xl rounded-br-none text-white ${
        theme === 'light' ? 'bg-indigo-500' : 'bg-indigo-600'
      }`;
    }
    if (msg.isStep) {
      return `px-4 py-3 rounded-xl rounded-bl-none border ${
        theme === 'dark'
          ? 'bg-gray-900/70 border-gray-700'
          : theme === 'light'
            ? 'bg-indigo-50 border-indigo-100'
            : 'bg-gray-600 border-gray-500'
      }`;
    }
    return `px-4 py-3 rounded-xl rounded-bl-none ${
      theme === 'dark'
        ? 'bg-gray-700'
        : theme === 'light'
          ? 'bg-white border border-gray-200 shadow-sm'
          : 'bg-gray-600'
    }`;
  };

  // AI对话发送消息
  const sendChatMessage = async () => {
    if (!chatInput.trim()) return;

    // chrys 正在运行时不允许发送 PPT/代码消息（HiDesk 聊天和知识库问答不受限制）
    const isChrysMode = targetFileType === 'slides' || targetFileType === 'code';
    if (isChrysBusy && isChrysMode && !platforms.hiDesk) {
      return;
    }
    
    const userContent = chatInput;
    const currentImages = [...images];
    setImages([]);

    // 保存到问题历史（最多100条，最新的在前面，去重后持久化）
    questionHistoryRef.current = [userContent, ...questionHistoryRef.current.filter(h => h !== userContent)].slice(0, 100);
    setHistoryIndex(-1);
    writeMemoryFile({ questionHistory: questionHistoryRef.current });

    const userMessage = { type: 'user', content: userContent };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setChatInput('');
    setIsTyping(true);

    if (targetFileType === 'slides') {
      try {
        const { ipcRenderer } = window.require('electron');
        let currentMessages = [...newMessages];

        const addMsg = (content) => {
          currentMessages = [...currentMessages, { type: 'assistant', content }];
          setMessages(currentMessages);
        };

        // ── 已有 Chrys 会话：继续调整 ──
        if (chrysSessionId) {
          addMsg('🔄 正在调整 PPT...');
          const result = await ipcRenderer.invoke('continue-chrys-session', userContent, chrysSessionId, selectedModelConfigId);
          if (!result.success) { addMsg(`❌ 调整失败: ${result.message}`); setIsTyping(false); return; }
          const sid = result.sessionId;
          const chrysOk = await runTask(`Chrys PPT 调整 (${chrysSessionId})`, async (updateMsg) => {
            updateMsg('正在调整...');
            return new Promise((resolve) => {
              const handler = (_event, data) => {
                if (data.sessionId === sid) {
                  ipcRenderer.removeListener('chrys-task-complete', handler);
                  resolve(data.success ? { success: true, message: '调整完成' } : { success: false, message: data.message });
                }
              };
              ipcRenderer.on('chrys-task-complete', handler);
              setTimeout(() => { ipcRenderer.removeListener('chrys-task-complete', handler); resolve({ success: false, message: '超时' }); }, 1800000);
            });
          }, 1800000, { type: 'chrys', sessionId: sid });
          if (chrysOk) addMsg('✅ PPT 调整完成！文件已更新。可继续提出修改要求。');
          else addMsg('❌ 调整失败，请查看后台任务。');
          setIsTyping(false);
          return;
        }

        // ── 新会话：SSE 流水线(步骤 1-6，后端自动衔接 Executor) ──
        addMsg('🚀 正在启动 PPT 六步流水线：意图分析 → 信息收集 → 结构规划 → 内容审核 → 渲染导出...');
        const renderData = await runPptPipeline(userContent);

        if (!renderData) {
          addMsg('❌ 流水线未能产出结果，请查看流水线日志。');
          setIsTyping(false);
          return;
        }

        // Check if executor completed successfully
        if (renderData._executor_done) {
          const savePath = renderData.pptx_path || renderData.project_path || '';
          setPipelineState(prev => {
            if (!prev) return prev;
            const steps = prev.steps.map(s => (
              s.status === 'error' ? s : { ...s, status: 'done' }
            ));
            return { ...prev, steps, running: false, result: renderData };
          });
          addMsg(`✅ PPT 生成完成！${savePath ? `文件：${savePath}` : '查看流水线项目目录'}`);
          setIsTyping(false);
          return;
        }

        if (renderData._executor_failed) {
          addMsg(`❌ PPT 生成失败: ${renderData._error || '未知错误'}`);
          setIsTyping(false);
          return;
        }

        // Executor failed or returned unrecognized data
        addMsg('❌ PPT 生成失败，流水线未能产出有效结果。请查看流水线日志。');
      } catch (err) {
        console.error('[PPT] pipeline error:', err);
        setMessages([...newMessages, { type: 'assistant', content: `❌ PPT 生成过程出错: ${err.message}` }]);
      } finally {
        setIsTyping(false);
      }
      return;
    }

    if (targetFileType === 'code') {
      try {
        const { ipcRenderer } = window.require('electron');
        let currentMessages = [...newMessages];

        const addMsg = (content) => {
          currentMessages = [...currentMessages, { type: 'assistant', content }];
          setMessages(currentMessages);
        };

        const isNewSession = !chrysCodeSessionId;

        // 仅新会话需要前置检查
        if (isNewSession) {
          addMsg('🔍 正在检查代码生成环境 (chrys)...');

          const chrysCheck = await ipcRenderer.invoke('check-chrys-exists');
          if (!chrysCheck.exists) {
            addMsg('⬇️ chrys 未安装，正在后台下载安装...');
            const chrysOk = await runTask('下载安装 Chrys', async (updateMsg) => {
              updateMsg('【1/4】检测网络环境...');
              const downloadResult = await ipcRenderer.invoke('download-chrys');
              if (!downloadResult.success) {
                return { success: false, message: 'chrys 下载失败: ' + downloadResult.message };
              }
              if (downloadResult.scpUsed) {
                updateMsg('【2/4】SFTP 加速下载完成');
              } else if (downloadResult.scpFailed) {
                updateMsg('【2/4】SFTP 不可用，已回退 GitHub 下载完成');
              } else {
                updateMsg('【2/4】GitHub 下载完成');
              }
              updateMsg('【3/4】正在解压安装 Chrys...');
              const installResult = await ipcRenderer.invoke('install-chrys', downloadResult.path);
              if (!installResult.success) {
                return { success: false, message: 'chrys 安装失败: ' + installResult.message };
              }
              updateMsg('【4/4】Chrys 安装完成，正在验证...');
              return { success: true, message: 'chrys 安装完成' };
            }, 420000);
            if (!chrysOk) {
              addMsg('❌ chrys 安装失败，请查看后台任务详情');
              setIsTyping(false);
              return;
            }
            addMsg('✅ chrys 安装完成');
          }

          addMsg('🔍 正在同步 Chrys 模型配置...');
          try {
            const chrysModelsResult = await ipcRenderer.invoke('sync-chrys-models');
            if (chrysModelsResult.success) {
              addMsg(`✅ Chrys 模型配置: ${chrysModelsResult.message}`);
            } else {
              addMsg(`⚠️ Chrys 模型同步失败: ${chrysModelsResult.message}`);
            }
          } catch (e) {
            addMsg(`⚠️ Chrys 模型同步异常: ${e.message}`);
          }

          addMsg('📝 正在使用 chrys 生成代码，请稍候...');
        }

        // 启动或继续 Chrys 代码会话
        const result = isNewSession
          ? await ipcRenderer.invoke('start-chrys-code', userContent, selectedModelConfigId, {
              outputDir: codeOutputDir || undefined,
              promptTemplate: codePromptTemplate || undefined,
              agent: codeAgent || undefined,
            })
          : await ipcRenderer.invoke('continue-chrys-code-session', userContent, chrysCodeSessionId, selectedModelConfigId, {
              agent: codeAgent || undefined,
            });

        if (!result.success) {
          addMsg(`❌ ${isNewSession ? '启动' : '继续'} 代码生成失败: ${result.message}`);
          setIsTyping(false);
          return;
        }

        const sid = result.sessionId;
        if (isNewSession) {
          setChrysCodeSessionId(sid);
        }

        const taskLabel = isNewSession ? 'Chrys 代码生成' : `Chrys 代码调整 (${chrysCodeSessionId || sid})`;
        const codeOk = await runTask(taskLabel, async (updateMsg) => {
          updateMsg(isNewSession ? '正在生成代码...可点击查看日志' : '正在调整代码...可点击查看日志');

          return new Promise((resolve) => {
            const handler = (_event, data) => {
              if (data.sessionId === sid) {
                ipcRenderer.removeListener('chrys-task-complete', handler);
                if (data.success) {
                  resolve({ success: true, message: isNewSession ? '代码生成完成' : '调整完成' });
                } else {
                  resolve({ success: false, message: data.message || 'Chrys 执行失败' });
                }
              }
            };
            ipcRenderer.on('chrys-task-complete', handler);

            setTimeout(() => {
              ipcRenderer.removeListener('chrys-task-complete', handler);
              resolve({ success: false, message: 'Chrys 执行超时' });
            }, 3600000);
          });
        }, 3600000, { type: 'chrys', sessionId: sid });

        if (!codeOk) {
          addMsg('❌ 代码生成失败，请查看后台任务详情');
        } else if (isNewSession) {
          addMsg('✅ 代码生成完成！文件已保存到当前目录下的 code 文件夹中。');
        } else {
          addMsg('✅ 代码调整完成！可继续提出修改要求。');
        }
      } catch (err) {
        console.error('[Code] chrys pipeline error:', err);
        setMessages([...newMessages, { type: 'assistant', content: `❌ 代码生成过程出错: ${err.message}` }]);
      } finally {
        setIsTyping(false);
      }
      return;
    }

    if (platforms.haiwen) {
      // 海问思答问答（使用统一搜索，可同时搜索多个平台）
      if (!haiwenAuthenticated) {
        const loginOk = await autologinHaiwen();
        if (!loginOk) {
          setMessages([...newMessages, { type: 'assistant', content: '请先登录海问思答平台。' }]);
        setIsTyping(false);
        return;
        }
      }
      // 如果本地知识也勾选了，确保 KMA 已就绪
      if (platforms.local) {
        const kmaReady = await ensureKmaReady();
        if (!kmaReady) {
          setMessages([...newMessages, {
            type: 'assistant',
            content: '无法启动本地知识服务，请检查 KMA 是否已安装并重试。'
          }]);
          setIsTyping(false);
          return;
        }
      }
      try {
        const response = await fetch('http://127.0.0.1:5002/api/v1/unified-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: userContent,
            mode: 'normal',
            platforms: { haiwen: true, local: platforms.local },
            project_ids: platforms.local && selectedKBIds.length > 0
              ? [...new Set(selectedKBIds.map(k => k.split('::')[0]))]
              : [],
          }),
        });
        const data = await response.json();
        if (!data.success) {
          // 检查是否是认证过期
          if (data.message && data.message.includes('过期')) {
            setHaiwenAuthenticated(false);
            const reloginOk = await autologinHaiwen();
            setMessages([...newMessages, { type: 'assistant', content: reloginOk ? '海问思答已重新登录，请重新提问' : '海问思答认证已过期，请重新登录。' }]);
          } else {
            setMessages([...newMessages, { type: 'assistant', content: `海问思答搜索失败: ${data.message || '未知错误'}` }]);
          }
        } else {
          const respData = data.data || {};
          const platformsUsed = respData.platforms_used || [];
          const rawSources = respData.sources || [];
          const answer = respData.answer || '未在海问思答中找到相关文档。';

          // 检查是否认证过期
          if (respData.expired || (answer && (answer.includes('认证已过期') || answer.includes('重新登录')))) {
            setHaiwenAuthenticated(false);
            setShowHaiwenLogin(true);
          }

          // 为本地来源预计算完整路径：用 source 自身的 project_id 查找正确 KB 路径
          const getKbPathById = (projectId) => {
            if (!projectId) return '';
            const kb = knowledgeBaseList.find(kb => (kb.id || kb.knowledge_base_id || '') === projectId);
            return kb?.path || '';
          };
          // 默认回退路径（单 KB 或无 project_id 时）
          const activeKb = knowledgeBaseList.find(kb => {
            const kbId = kb.id || kb.knowledge_base_id || '';
            return selectedKBIds.some(sid => sid.split('::')[0] === kbId);
          });
          const kbPathFromIds = selectedKBIds.length > 0
            ? selectedKBIds[selectedKBIds.length - 1].split('::').slice(1).join('::') || ''
            : '';
          const defaultKbPath = activeKb?.path || projectPath || kbPathFromIds;
          const pathMod = window.require('path');
          const sources = rawSources.map(src => {
            if (typeof src === 'string') {
              return { _fullPath: defaultKbPath ? pathMod.join(defaultKbPath, src) : src, title: src, platform: 'local', index: 0, url: '' };
            }
            const isLocal = src.platform === 'local';
            const hasUrl = src.url && src.url.startsWith('http');
            if (isLocal || !hasUrl) {
              const srcKbPath = getKbPathById(src.project_id) || defaultKbPath;
              const relPath = src.url || src.title || '';
              return { ...src, _fullPath: srcKbPath && relPath ? pathMod.join(srcKbPath, relPath) : (relPath || '') };
            }
            return src;
          });

          setMessages([...newMessages, {
            type: 'assistant',
            content: answer,
            platformsUsed: platformsUsed,
            sources: sources,
          }]);
        }
      } catch (error) {
        setMessages([...newMessages, { type: 'assistant', content: `海问思答请求失败: ${error.message || '未知错误'}` }]);
      } finally {
        setIsTyping(false);
      }
    } else if (platforms.local) {
      // 确保 KMA 和 KMA Server 已启动
      const kmaReady = await ensureKmaReady();
      if (!kmaReady) {
        setMessages([...newMessages, {
          type: 'assistant',
          content: '无法启动本地知识服务，请检查 KMA 是否已安装并重试。'
        }]);
        setIsTyping(false);
        return;
      }
      try {
        // Step 0: 如果有图片，先用 Vision LLM 将图片描述为文字，拼入检索 query
        let searchQuery = userContent;
        if (currentImages.length > 0) {
          console.log('[KnowledgeManagement] Step 0: describing images for search, count:', currentImages.length);
          // 从 savedModels 取当前选中模型的实际配置，避免 React state 滞后
          const currentModelConfig = savedModels.find(m => m.id === selectedModelConfigId);
          const effectiveConfig = {
            llmUrl: currentModelConfig?.url || llmUrl,
            llmApiKey: currentModelConfig?.apiKey || llmApiKey,
            llmModel: currentModelConfig?.model || llmModel,
          };
          console.log('[KnowledgeManagement] Step 0: using model config:', effectiveConfig.llmModel, '(selectedModelConfigId:', selectedModelConfigId + ')');
          const imageDesc = await describeImagesToText(currentImages, effectiveConfig, savedModels, messages);
          if (imageDesc) {
            searchQuery = `${userContent}\n\n[图片描述]\n${imageDesc}`;
            console.log('[KnowledgeManagement] Step 0: image description appended with label, searchQuery length:', searchQuery.length, 'preview:', searchQuery.substring(0, 200));
          } else {
            console.log('[KnowledgeManagement] Step 0: image description empty, using original query only');
          }
        }

        // Step 1: 用检索 query 调用知识库 Q&A
        const systemPrompt = buildSystemPrompt(targetFileType, workMode);
        const payload = { query: searchQuery, mode: searchMode };
        if (systemPrompt) {
          payload.system_prompt = systemPrompt;
        }
        if (selectedKBIds.length > 0) {
          payload.project_ids = [...new Set(selectedKBIds.map(k => k.split('::')[0]))];
        }
        if (targetFileType) {
          payload.target_type = targetFileType;
        }
        payload.answer_mode = workMode;

        const response = await fetch('http://127.0.0.1:5002/api/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!data.success) {
          setMessages([...newMessages, {
            type: 'assistant',
            content: `问答服务返回错误: ${data.message || '未知错误'}`
          }]);
          setIsTyping(false);
          return;
        }

        let finalAnswer = data.data.answer;

        // Step 2: 如果有图片，调用 LLM 将知识库回复与图片结合
        if (currentImages.length > 0) {
          const combined = await refineAnswerWithImages(finalAnswer, userContent, currentImages, { llmUrl, llmApiKey, llmModel }, savedModels);
          if (combined) {
            finalAnswer = combined;
          }
        }

        // 解析 <!-- cited: ... --> 注释，仅保留实际引用的参考文献
        let citedPages = data.data.cited_pages || [];
        let displayAnswer = finalAnswer;
        const citedMatch = finalAnswer.match(/<!--\s*cited:\s*([\d,\s]+)\s*-->/);
        if (citedMatch) {
          const citedIndices = new Set(
            citedMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
          );
          citedPages = citedPages.filter(cp => citedIndices.has(cp.index));
          displayAnswer = finalAnswer.slice(0, citedMatch.index) + finalAnswer.slice(citedMatch.index + citedMatch[0].length);
          displayAnswer = displayAnswer.trim();
        }

        // 为每个 citedPage 预计算完整文件路径（用 project_id 匹配正确 KB）
        const getKbPathById = (projectId) => {
          if (!projectId) return '';
          const kb = knowledgeBaseList.find(kb => (kb.id || kb.knowledge_base_id || '') === projectId);
          return kb?.path || '';
        };
        const pathMod = window.require('path');
        citedPages = citedPages.map(cp => ({
          ...cp,
          _fullPath: cp.path ? pathMod.join(getKbPathById(cp.project_id) || projectPath, cp.path) : '',
        }));

        setMessages([...newMessages, {
          type: 'assistant',
          content: displayAnswer,
          citedPages,
        }]);
      } catch (error) {
        console.error('KMA Q&A request failed:', error);
        setMessages([...newMessages, {
          type: 'assistant',
          content: `无法连接到本地知识服务 (端口 5002): ${error.message}。请确保 KMA Server 已启动。`
        }]);
      } finally {
        setIsTyping(false);
      }
    } else if (platforms.hiDesk) {
      // HiDesk 问答
      if (!hiDeskSelectedKbSn) {
        setMessages([...newMessages, { type: 'assistant', content: '请先在左侧选择一个视图（知识库）。' }]);
        setIsTyping(false);
        return;
      }
      const base = `http://${hiDeskServer.ip}:${hiDeskServer.port}`;
      const payload = {
        message: userContent,
        kb_sn: hiDeskSelectedKbSn,
        user_id: userInfo?.name || 'anonymous',
      };

      // 每次发送前重新读取配置，确保用户手动修改 JSON 后即时生效
      const memory = readMemoryFile();
      const currentChatMode = memory.hiDeskChatMode || 'stream';
      if (currentChatMode !== hiDeskChatMode) {
        setHiDeskChatMode(currentChatMode);
      }

      console.log(`[HiDesk] Starting chat (mode: ${currentChatMode})`, payload);
      const assistantIdx = newMessages.length;
      setMessages([...newMessages, { type: 'assistant', content: '' }]);

      try {
        if (currentChatMode === 'stream') {
          // SSE 流式问答
          const streamUrl = `${base}/api/knowledge/chat/stream`;
          console.log(`[HiDesk] Request: POST ${streamUrl}`);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 120000); // 2分钟超时
          const response = await fetch(streamUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          console.log(`[HiDesk] Stream response status: ${response.status}, contentType: ${response.headers.get('content-type')}, body: ${!!response.body}`);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText || '服务异常'}`);
          }

          // 如果 response.body 不可用（某些 Electron 环境），直接报错
          if (!response.body) {
            console.error('[HiDesk] response.body is null, stream not supported');
            setMessages(prev => {
              const updated = [...prev];
              if (updated[assistantIdx]) {
                updated[assistantIdx] = { type: 'assistant', content: '流式问答失败: 当前环境不支持流式读取，请将问答模式改为同步问答。' };
              }
              return updated;
            });
            setIsTyping(false);
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = '';
          let chunkCount = 0;
          let lastUpdateTime = 0;
          const UPDATE_INTERVAL = 50; // 最多每50ms更新一次UI

          // 处理单个 SSE chunk：解码字节，提取 data: 字段，解析 JSON
          const processSSEChunk = (bytes) => {
            const text = decoder.decode(bytes, { stream: true });
            // 先按 \n 或 \r 分行，再按 "data:" 进一步拆分，处理多个事件粘连的情况
            const lines = text.split(/[\r\n]+/);
            const payloads = [];
            for (const line of lines) {
              if (!line.trim()) continue;
              // 按 "data:" 拆分，处理同一行内多个事件粘连（如 JSON1 + "data: " + JSON2）
              const parts = line.split(/data:\s*/);
              for (const part of parts) {
                const trimmed = part.trim();
                if (trimmed) payloads.push(trimmed);
              }
            }
            for (const payloadStr of payloads) {
              if (!payloadStr || payloadStr === '[DONE]') continue;
              try {
                const json = JSON.parse(payloadStr);
                if (json && typeof json === 'object' && json.content) {
                  fullContent += String(json.content);
                  chunkCount++;
                }
              } catch (parseErr) {
                console.warn('[HiDesk] SSE JSON parse error, raw:', payloadStr.substring(0, 100), parseErr.message);
              }
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) processSSEChunk(value);

            // 节流更新消息
            const now = Date.now();
            if (chunkCount > 0 && fullContent && now - lastUpdateTime >= UPDATE_INTERVAL) {
              lastUpdateTime = now;
              setMessages(prev => {
                const updated = [...prev];
                if (updated[assistantIdx]) {
                  updated[assistantIdx] = { ...updated[assistantIdx], content: fullContent };
                }
                return updated;
              });
            }
          }

          // 最终更新
          if (chunkCount === 0) {
            // 流式未收到任何内容，直接报错
            console.error('[HiDesk] Stream returned no content');
            setMessages(prev => {
              const updated = [...prev];
              if (updated[assistantIdx]) {
                updated[assistantIdx] = { type: 'assistant', content: '流式问答失败: 服务端未返回任何内容，请检查 kb_sn 或网络连接。' };
              }
              return updated;
            });
          } else {
            setMessages(prev => {
              const updated = [...prev];
              if (updated[assistantIdx]) {
                updated[assistantIdx] = { ...updated[assistantIdx], content: fullContent };
              }
              return updated;
            });
          }
        } else {
          // 同步问答
          const syncUrl = `${base}/api/knowledge/chat/sync`;
          console.log(`[HiDesk] Request: POST ${syncUrl}`);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
          const response = await fetch(syncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          console.log(`[HiDesk] Sync response status: ${response.status}`);

          const data = await response.json();
          console.log(`[HiDesk] Sync response data: ${JSON.stringify(data).substring(0, 300)}`);
          const answer = data.answer || data.data?.answer || data.message || JSON.stringify(data);

          setMessages(prev => {
            const updated = [...prev];
            if (updated[assistantIdx]) {
              updated[assistantIdx] = { type: 'assistant', content: answer };
            }
            return updated;
          });
        }
      } catch (error) {
        console.error('HiDesk chat request failed:', error);
        const isTimeout = error.name === 'AbortError';
        setMessages(prev => {
          const updated = [...prev];
          if (updated[assistantIdx]) {
            updated[assistantIdx] = { type: 'assistant', content: isTimeout ? `HiDesk 问答服务请求超时，请检查网络或服务状态。` : `HiDesk 问答服务请求失败: ${error.message || '未知错误'}。请确认 HiDesk 服务 (${base}) 已启动。` };
          }
          return updated;
        });
      } finally {
        setIsTyping(false);
      }
    } else {
      setTimeout(() => {
        const responses = [
          '好的，我来帮您分析一下这个问题...',
          '根据您的需求，我建议采取以下方案：',
          '这个问题很有意思，让我深入分析一下...',
          '我来为您提供详细的解答：',
          '基于您提供的信息，以下是我的分析：',
        ];
        const randomResponse = responses[Math.floor(Math.random() * responses.length)];
        setMessages([...newMessages, { type: 'assistant', content: randomResponse }]);
        setIsTyping(false);
      }, 1500);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 处理左分隔条拖动
  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e) => {
      const rect = document.querySelector('.knowledge-container').getBoundingClientRect();
      const newWidth = ((e.clientX - rect.left) / rect.width) * 100;
      const clampedWidth = Math.max(20, Math.min(100 - rightWidth - 12, newWidth));
      setLeftWidth(clampedWidth);
    };
    const handleMouseUp = () => setIsDragging(false);
    const container = document.querySelector('.knowledge-container');
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mouseleave', handleMouseUp);
    return () => {
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mouseleave', handleMouseUp);
    };
  }, [isDragging, rightWidth]);

  // 处理右分隔条拖动
  useEffect(() => {
    if (!isDraggingRight) return;
    const handleMouseMove = (e) => {
      const rect = document.querySelector('.knowledge-container').getBoundingClientRect();
      const rightEdge = ((rect.right - e.clientX) / rect.width) * 100;
      const clampedWidth = Math.max(12, Math.min(25, rightEdge));
      setRightWidth(clampedWidth);
    };
    const handleMouseUp = () => setIsDraggingRight(false);
    const container = document.querySelector('.knowledge-container');
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mouseleave', handleMouseUp);
    return () => {
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mouseleave', handleMouseUp);
    };
  }, [isDraggingRight]);

  const refreshWikiStatus = async () => {
    const { ipcRenderer } = window.require('electron');
    const status = await ipcRenderer.invoke('get-wiki-status');
    setWikiRunning(status.running);
    if (status.running) {
      await fetchKnowledgeBaseList();
      await autoDetectCommonKb();
    }
    setKbListLoading(false);
  };

  const doInstallLlmWiki = async (updateMsg) => {
    const { ipcRenderer } = window.require('electron');

    // 第一步：尝试 SFTP 加速
    updateMsg && updateMsg('【1/7】检测网络环境...');
    const scpResult = await ipcRenderer.invoke('scp-llm-wiki-msi');

    let downloadResult;
    if (scpResult.success) {
      downloadResult = scpResult;
      updateMsg && updateMsg('【2/7】SFTP 加速下载完成');
    } else {
      updateMsg && updateMsg('【2/7】SFTP 不可用，正在从 GitHub 下载 KMA 安装包...');
      downloadResult = await ipcRenderer.invoke('download-llm-wiki-msi');
    }

    if (!downloadResult.success) {
      const errMsg = '下载 KMA 安装包失败: ' + (downloadResult.message || '未知错误');
      updateMsg && updateMsg(errMsg);
      return { success: false, message: errMsg };
    }
    updateMsg && updateMsg('【3/7】安装包下载完成，正在启动安装向导...');
    await ipcRenderer.invoke('install-llm-wiki-msi', downloadResult.path);

    updateMsg && updateMsg('【4/7】等待安装向导完成...');
    const installed = await ipcRenderer.invoke('wait-llm-wiki-installed', 60000);
    if (installed) {
      updateMsg && updateMsg('【5/7】安装程序已完成，正在清理...');
      ipcRenderer.invoke('cleanup-llm-wiki-msi', downloadResult.path);
    } else {
      return { success: false, message: '安装检测超时（1分钟），请确认 llm-wiki 是否已正确安装。安装完成后请重新勾选本地知识。' };
    }

    updateMsg && updateMsg('【6/7】正在启动 KMA 服务...');
    const startResult = await ipcRenderer.invoke('start-llm-wiki-headless');
    if (!startResult.success) {
      return { success: false, message: 'KMA 启动失败: ' + (startResult.message || '未知错误') };
    }

    updateMsg && updateMsg('【7/7】等待 KMA 服务就绪...');
    const ready = await ipcRenderer.invoke('wait-llm-wiki-ready', 30000);
    if (ready) {
      setPlatforms(prev => {
        const newPlatforms = { ...prev, local: true };
        writeMemoryFile({ platforms: newPlatforms });
        return newPlatforms;
      });
      refreshWikiStatus();
      // KMA 已就绪，触发之前因未安装而待定的自动任务
      ipcRenderer.invoke('run-pending-auto-tasks');
      return { success: true, message: 'KMA 安装并启动成功' };
    }

    return { success: false, message: 'KMA 启动超时（30s），请检查 llm-wiki 是否正常。' };
  };

  const handleStartupLlmWiki = async () => {
    const { ipcRenderer } = window.require('electron');
    try {
      const processCheck = await ipcRenderer.invoke('check-llm-wiki-process');
      if (processCheck.running) {
        refreshWikiStatus();
        return;
      }

      const binaryCheck = await ipcRenderer.invoke('check-llm-wiki-binary');
      if (binaryCheck.exists) {
        // 检查主进程是否已在自动启动 KMA，避免重复创建后台任务
        const { tasks: autoTasks } = await ipcRenderer.invoke('get-auto-start-status');
        if (autoTasks && autoTasks.kma && autoTasks.kma.status === 'running') {
          console.log('[StartupLlmWiki] KMA auto-start already in progress, skip duplicate task');
          return;
        }
        // 后台启动
        runTask('启动 KMA', async (updateMsg) => {
          updateMsg('【1/3】正在启动 KMA 进程...');
          const startResult = await ipcRenderer.invoke('start-llm-wiki-headless');
          if (!startResult.success) {
            setPlatforms(prev => {
              const newPlatforms = { ...prev, local: false };
              writeMemoryFile({ platforms: newPlatforms });
              return newPlatforms;
            });
            return { success: false, message: 'KMA 启动失败: ' + (startResult.message || '未知错误') };
          }
          updateMsg('【2/3】进程已启动，等待服务就绪...');
          const ready = await ipcRenderer.invoke('wait-llm-wiki-ready', 30000);
          if (ready) {
            updateMsg('【3/3】KMA 服务已就绪');
            refreshWikiStatus();
            ipcRenderer.invoke('run-pending-auto-tasks');
            return { success: true, message: 'KMA 已启动' };
          }
          setPlatforms(prev => {
            const newPlatforms = { ...prev, local: false };
            writeMemoryFile({ platforms: newPlatforms });
            return newPlatforms;
          });
          return { success: false, message: 'KMA 启动超时' };
        }, 35000);
        return;
      }

      // 未安装，直接后台下载安装
      runTask('安装 KMA', async (updateMsg) => {
        const result = await doInstallLlmWiki(updateMsg);
        if (!result || result.success === false) {
          setPlatforms(prev => {
            const newPlatforms = { ...prev, local: false };
            writeMemoryFile({ platforms: newPlatforms });
            return newPlatforms;
          });
        }
        return result;
      }, 3700000);
    } catch (err) {
      console.error('Startup llm-wiki check error:', err);
      setPlatforms(prev => {
        const newPlatforms = { ...prev, local: false };
        writeMemoryFile({ platforms: newPlatforms });
        return newPlatforms;
      });
    }
  };

  const initialStartupDone = useRef(false);
  const hiDeskInitialCheckDone = useRef(false);
  const [kbListLoading, setKbListLoading] = useState(false);

  const waitForWikiAndFetchList = async () => {
    setKbListLoading(true);
    const maxRetries = 15;
    const retryInterval = 2000;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch('http://127.0.0.1:5002/api/v1/server/health', { signal: AbortSignal.timeout(3000) });
        const data = await response.json();
        if (data.llm_wiki_status && data.llm_wiki_status.ok) {
          // 加载 LLM 配置和公共知识库配置（先于其他操作，避免异常导致跳过）
          fetchLlmConfig();
          loadCommonKbConfig();
          // 服务器就绪，先将当前模型配置推送到服务端，防止读取到过期缓存
          await syncCurrentModelToKmaServer();
          // 执行所有需要服务端支持的初始化
          await fetchKnowledgeBaseList();
          // 自动检测并注册本地公共知识库
          await autoDetectCommonKb();
          setKbListLoading(false);
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, retryInterval));
    }
    setKbListLoading(false);
  };

  // 递归遍历本地公共知识库目录树，将知识库根目录（含 schema.md）注册到 LLM Wiki 后端
  // 注意：不能用"叶子节点（无子目录）"判断——知识库根目录本身含 wiki/、raw/ 等子目录，
  // 会被判为非叶子而跳过，导致真正的知识库从未注册、前端列表看不到卡片。
  const registerCommonKbSubdirs = async (parentPath) => {
    if (!parentPath) return;
    try {
      const browseResp = await fetch(`http://127.0.0.1:5003/api/v1/browse?path=${encodeURIComponent(parentPath)}`);
      const browseData = await browseResp.json();
      if (!browseData.success || !browseData.data?.entries) return;
      const entries = browseData.data.entries;
      const subDirs = entries.filter(e => e.is_dir);
      if (subDirs.length === 0) return;

      const listResp = await fetch('http://127.0.0.1:5002/api/v1/projects');
      const listData = await listResp.json();
      const projects = (listData.data && listData.data.projects) ? listData.data.projects : (listData.projects || []);

      for (const dir of subDirs) {
        const dirPath = dir.path;
        if (!dirPath) continue; // 跳过没有路径的条目
        // 检查这个子目录是否是知识库根目录（含 schema.md）
        const childResp = await fetch(`http://127.0.0.1:5003/api/v1/browse?path=${encodeURIComponent(dirPath)}`);
        const childData = await childResp.json();
        const isKbRoot = childData.data?.entries?.some(e => e.name === 'schema.md');
        if (isKbRoot) {
          // 知识库根目录 → 注册
          await _registerSingleKb(dirPath, dir, projects);
        } else {
          // 非知识库目录 → 递归继续查找
          await registerCommonKbSubdirs(dirPath);
        }
      }
    } catch (e) {
      console.error('registerCommonKbSubdirs failed:', e);
    }
  };

  // 注册单个目录为知识库（必须是有效的知识库根目录：包含 schema.md）
  const _registerSingleKb = async (dirPath, dir, projects) => {
    // 检查是否是有效的知识库根目录（必须有 schema.md）
    const schemaResp = await fetch(`http://127.0.0.1:5003/api/v1/browse?path=${encodeURIComponent(dirPath)}`);
    const schemaData = await schemaResp.json();
    const hasSchemaMd = schemaData.data?.entries?.some(e => e.name === 'schema.md');
    if (!hasSchemaMd) {
      // 不是有效知识库，跳过
      return;
    }
    const normalizedPath = dirPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const existingProject = projects.find(p => {
      const pPath = (p.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return pPath === normalizedPath;
    });
    let projectId = (existingProject && (existingProject.id || existingProject.knowledge_base_id)) || null;
    if (!existingProject) {
      const openResp = await fetch('http://127.0.0.1:5002/api/v1/projects/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      });
      const openData = await openResp.json();
      if (openData.success && openData.data) {
        projectId = openData.data.project_id || null;
      }
    }
    if (projectId) {
      fetch(`http://127.0.0.1:5002/api/v1/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
        method: 'POST',
      }).catch(e => console.error(`Rescan sub-kb ${dir.name} failed:`, e));
    }
  };

  // 自动检测本地公共知识库是否已在列表中，未在则注册
  const autoDetectCommonKb = async () => {
    const localPath = commonKbConfig.localPath;
    if (!localPath) return;
    try {
      const checkResp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/check-local');
      const checkData = await checkResp.json();
      if (!checkData.success || !checkData.data?.exists) return;
      await registerCommonKbSubdirs(localPath);
      await fetchKnowledgeBaseList();
    } catch (e) {
      console.error('Auto-detect common KB failed:', e);
    }
  };

  // 当勾选本地知识时，获取知识库列表
  useEffect(() => {
    if (initialStartupDone.current) return;
    if (!platforms.local) return;
    initialStartupDone.current = true;
    handleStartupLlmWiki();
    waitForWikiAndFetchList();
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('get-wiki-status').then(status => {
      setWikiRunning(status.running);
    });
  }, [platforms.local]);

  // 页面打开时，若 HiDesk 已勾选，自动测试连接
  useEffect(() => {
    if (hiDeskInitialCheckDone.current) return;
    if (!platforms.hiDesk) return;
    hiDeskInitialCheckDone.current = true;
    handleHiDeskAutoStart();
  }, [platforms.hiDesk]);

  useEffect(() => {
    const { ipcRenderer } = window.require('electron');

    ipcRenderer.invoke('get-mcp-status').then((status) => {
      setMcpRunning(status.running);
      setMcpMode(status.mode);
    });

    ipcRenderer.invoke('get-wiki-status').then((status) => {
      setWikiRunning(status.running);
    });

    // 页面首次加载时，从主进程拉取当前自动启动任务状态，
    // 防止渲染进程挂载前事件丢失的竞态问题。
    // 延迟重试：主进程 auto-start 可能尚未开始，需等待片刻后再拉取。
    if (!autoStartTasksShown) {
      autoStartTasksShown = true;
      const TASK_LABELS = {
        'kma': '启动 KMA',
        'wiki-server': '启动 KMA Server',
        'mcp-server': '启动 KMA MCP',
        'preprocessor': '启动 预处理服务',
      };

      const fetchWithRetry = async (delayMs, retries) => {
        // 首次等待，给主进程留出启动时间
        await new Promise(r => setTimeout(r, delayMs));
        for (let i = 0; i < retries; i++) {
          const { tasks: statusMap } = await ipcRenderer.invoke('get-auto-start-status');
          const entries = Object.entries(statusMap || {});
          if (entries.length > 0) {
            entries.forEach(([taskKey, info]) => {
              const name = TASK_LABELS[taskKey] || taskKey;
              // 原子地登记 taskKey，避免与 handleAutoStartTaskStatus 竞态导致重复创建
              const existingId = autoStartTaskRef.current[taskKey];
              if (existingId != null && existingId !== 0) {
                updateTask(existingId, {
                  status: info.status === 'completed' ? 'completed'
                        : info.status === 'failed' ? 'failed'
                        : 'running',
                  message: info.message || '',
                });
              } else {
                // 用 0 占位，标记此 taskKey 已被 fetchWithRetry 认领
                autoStartTaskRef.current[taskKey] = 0;
                const taskId = addTask(name);
                autoStartTaskRef.current[taskKey] = taskId;
                updateTask(taskId, {
                  status: info.status === 'completed' ? 'completed'
                        : info.status === 'failed' ? 'failed'
                        : 'running',
                  message: info.message || '',
                });
              }
            });
            return;
          }
          if (i < retries - 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        }
      };

      fetchWithRetry(300, 6);
    }

    const handleMcpStatusChange = (event, status) => {
      setMcpRunning(status.running);
      setMcpMode(status.mode);
    };

    const handleWikiStatusChange = (event, status) => {
      setWikiRunning(status.running);
    };

    const handleKmaStatusChange = (event, status) => {
      setKmaRunning(status.running);
    };

    ipcRenderer.on('mcp-status-changed', handleMcpStatusChange);
    ipcRenderer.on('wiki-status-changed', handleWikiStatusChange);
    ipcRenderer.on('kma-status-changed', handleKmaStatusChange);

    return () => {
      ipcRenderer.removeListener('mcp-status-changed', handleMcpStatusChange);
      ipcRenderer.removeListener('wiki-status-changed', handleWikiStatusChange);
      ipcRenderer.removeListener('kma-status-changed', handleKmaStatusChange);
    };
  }, [addTask, updateTask]);

  useEffect(() => {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('get-wiki-status').then(status => {
      if (!status.running) {
        ipcRenderer.invoke('start-wiki-server').then(result => {
          if (result.success) setWikiRunning(true);
        });
      }
    });
    // 初始化 KMA 运行状态
    ipcRenderer.invoke('get-llm-wiki-status').then(status => {
      setKmaRunning(status.running);
    });
  }, []);

  // 监听主进程发送的自动启动任务状态，同步到后台任务面板
  useEffect(() => {
    const { ipcRenderer } = window.require('electron');

    const handleAutoStartTaskStatus = (event, { taskKey, status, message }) => {
      const ref = autoStartTaskRef.current;
      const TASK_LABELS = {
        'kma': '启动 KMA',
        'wiki-server': '启动 KMA Server',
        'mcp-server': '启动 KMA MCP',
        'preprocessor': '启动 预处理服务',
      };
      const name = TASK_LABELS[taskKey] || taskKey;

      if (status === 'running') {
        // 若已有同名任务（含 fetchWithRetry 设置的 0 占位），直接更新
        const existingId = ref[taskKey];
        if (existingId != null && existingId !== 0) {
          updateTask(existingId, { status: 'running', message: message || '' });
        } else if (existingId !== 0) {
          // 用 0 占位，防止与 fetchWithRetry 竞态
          ref[taskKey] = 0;
          const taskId = addTask(name);
          ref[taskKey] = taskId;
          if (message) updateTask(taskId, { message });
        }
        // existingId === 0 时：fetchWithRetry 已占位，忽略，等它创建后更新
      } else if (ref[taskKey] != null && ref[taskKey] !== 0) {
        updateTask(ref[taskKey], {
          status: status === 'completed' ? 'completed' : 'failed',
          message: message || (status === 'completed' ? '已就绪' : '已就绪'),
        });
      } else if (ref[taskKey] === 0) {
        // fetchWithRetry 已占位但尚未创建任务，暂存最终状态以便后续应用
        // 不做操作，fetchWithRetry 创建任务后会从 get-auto-start-status 拿到最新状态
      }
    };

    ipcRenderer.on('auto-start-task-status', handleAutoStartTaskStatus);
    return () => {
      ipcRenderer.removeListener('auto-start-task-status', handleAutoStartTaskStatus);
    };
  }, [addTask, updateTask]);

  const handleStartWiki = async () => {
    const { ipcRenderer } = window.require('electron');
    runTask('启动 KMA Server', async (updateMsg) => {
      updateMsg('正在启动 KMA Server...');
      const result = await ipcRenderer.invoke('start-wiki-server');
      if (result.success) {
        setWikiRunning(true);
        return { success: true, message: 'KMA Server 已就绪' };
      }
      return { success: false, message: 'KMA 或 KMA Server 可能未就绪，请就绪后手动启动' };
    }, 180000);
  };

  const handleStopWiki = async () => {
    const { ipcRenderer } = window.require('electron');

    const mcpStatus = await ipcRenderer.invoke('get-mcp-status');
    if (mcpStatus.running) {
      await ipcRenderer.invoke('stop-mcp-server');
    }

    const result = await ipcRenderer.invoke('stop-wiki-server');
    if (result.success) {
      setWikiRunning(false);
    }
  };

  const handleStartMcp = async () => {
    const { ipcRenderer } = window.require('electron');
    runTask('启动 KMA MCP', async (updateMsg) => {
      // 先检查 Wiki Server 是否运行
      const wikiStatus = await ipcRenderer.invoke('get-wiki-status');
      if (!wikiStatus.running) {
        updateMsg('请先启动 KMA Server，正在自动启动...');
        const wikiResult = await ipcRenderer.invoke('start-wiki-server');
        if (!wikiResult.success) {
          return { success: false, message: 'KMA 或 KMA Server 可能未就绪，请就绪后手动启动' };
        }
        setWikiRunning(true);
        updateMsg('KMA Server 已就绪，正在启动 MCP...');
      } else {
        updateMsg('正在启动 KMA MCP...');
      }
      const result = await ipcRenderer.invoke('start-mcp-server', 'http');
      if (result.success) {
        setMcpRunning(true);
        setMcpMode('http');
        return { success: true, message: 'KMA MCP 已就绪 (端口 9011)' };
      }
      return { success: false, message: 'KMA 或 KMA Server 可能未就绪，请就绪后手动启动' };
    }, 35000);
  };

  const handleStopMcp = async () => {
    const { ipcRenderer } = window.require('electron');
    const result = await ipcRenderer.invoke('stop-mcp-server');
    if (result.success) {
      setMcpRunning(false);
      setMcpMode(null);
    }
  };

  const handleStartKma = async () => {
    const { ipcRenderer } = window.require('electron');
    runTask('启动 KMA', async (updateMsg) => {
      updateMsg('正在启动 KMA...');
      const result = await ipcRenderer.invoke('start-llm-wiki-headless');
      if (result.success) {
        // 等待端口就绪
        const ready = await ipcRenderer.invoke('wait-llm-wiki-ready', 30000);
        if (ready) {
          setKmaRunning(true);
          return { success: true, message: 'KMA 已就绪 (端口 19828)' };
        }
        return { success: false, message: 'KMA 启动超时' };
      }
      if (result.message === '未找到 llm-wiki.exe') {
        return { success: false, message: '未找到 llm-wiki.exe，请先安装 KMA' };
      }
      return { success: false, message: result.message || 'KMA 启动失败' };
    }, 35000);
  };

  const handleStopKma = async () => {
    const { ipcRenderer } = window.require('electron');
    const result = await ipcRenderer.invoke('stop-llm-wiki');
    if (result.success) {
      setKmaRunning(false);
    }
  };

  // 标记 KB 开始预处理 / 结束预处理
  const markKbPreprocessing = (kbId) => {
    setPreprocessingKbIds(prev => new Set(prev).add(kbId));
  };
  const unmarkKbPreprocessing = (kbId) => {
    setPreprocessingKbIds(prev => {
      const next = new Set(prev);
      next.delete(kbId);
      return next;
    });
  };

  // ===== 导入/预处理实时进度轮询 =====
  // 后端在预处理各阶段（Mermaid 分析 / CloudModeling 转换 / PlantUML LLM 总结）写入进度，
  // 前端每 800ms 拉取一次并展示，避免长任务期间用户误以为卡住。
  const stopImportProgressPolling = () => {
    if (importProgressTimerRef.current) {
      clearInterval(importProgressTimerRef.current);
      importProgressTimerRef.current = null;
    }
  };

  const startImportProgressPolling = (taskId) => {
    if (!taskId) return;
    stopImportProgressPolling();
    const startTime = Date.now();
    setImportProgress({ active: true, taskId, status: 'running', stage: 'init', message: '准备中…', currentFile: '', plantumlTotal: 0, plantumlDone: 0, elapsedSeconds: 0, startTime });

    const tick = async () => {
      try {
        const resp = await fetch(`http://127.0.0.1:5002/api/v1/projects/import-progress?task_id=${encodeURIComponent(taskId)}`);
        const result = await resp.json();
        const prog = (result.success && result.data) ? result.data : null;
        if (!prog) return; // 后端尚无记录或已清除，保留上次状态
        const finished = prog.status === 'done' || prog.status === 'error';
        setImportProgress(prev => ({
          ...prev,
          status: prog.status,
          stage: prog.stage || prev.stage,
          message: prog.message || prev.message,
          currentFile: prog.current_file ?? prev.currentFile,
          plantumlTotal: prog.plantuml_total ?? prev.plantumlTotal,
          plantumlDone: prog.plantuml_done ?? prev.plantumlDone,
          elapsedSeconds: prog.elapsed_seconds ?? Math.round((Date.now() - startTime) / 1000),
        }));
        if (finished) {
          stopImportProgressPolling();
          // 成功后短暂保留完成态再隐藏
          if (prog.status === 'done') {
            setTimeout(() => setImportProgress({ active: false }), 1500);
          }
        }
      } catch (_) {
        // 网络抖动忽略，下个 tick 继续
      }
    };
    tick();
    importProgressTimerRef.current = setInterval(tick, 800);
  };

  // 组件卸载时清理轮询定时器
  useEffect(() => () => { stopImportProgressPolling(); }, []);
  // ===== 导入进度轮询结束 =====

  // 获取进程树
  const fetchProcessTree = async () => {
    setProcessTreeLoading(true);
    setProcessTreeError('');
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('get-process-tree');
      if (result.success) {
        setProcessTree(result.tree || []);
      } else {
        setProcessTreeError(result.message || '获取失败');
      }
    } catch (e) {
      setProcessTreeError(e.message);
    } finally {
      setProcessTreeLoading(false);
    }
  };

  // 杀死进程树（二次确认）
  const handleKillProcess = async (pid) => {
    if (killPid !== pid) {
      setKillPid(pid);
      return;
    }
    setKillPid(null);
    try {
      const { ipcRenderer } = window.require('electron');
      await ipcRenderer.invoke('kill-process-tree', pid);
      // 刷新进程树
      fetchProcessTree();
    } catch (e) {
      console.error('kill-process-tree error:', e);
    }
  };

  const domains = [
    { value: 'software', label: '软件' },
    { value: 'test', label: '测试' },
    { value: 'validation', label: '验证' },
    { value: 'maintenance', label: '维护' },
    { value: 'setup', label: '架设' },
    { value: 'anka', label: '安卡' },
    { value: 'chip', label: '芯片' }
  ];

  const hiDeskConfigs = [
    { value: 'config1', label: '配置1' },
    { value: 'config2', label: '配置2' },
    { value: 'config3', label: '配置3' }
  ];

  const {
    getHiDeskBaseUrl,
    doHiDeskAutoStart, testHiDeskConnection, saveHiDeskDebugData, fetchHiDeskConfig,
    refreshHiDeskConnection,
    handleHiDeskDomainChange, handleHiDeskViewChange, handleHiDeskChatModeChange,
    handleHiDeskAutoStart,
  } = useHiDesk({
    hiDeskServer,
    hiDeskConfigured, setHiDeskConfigured,
    hiDeskTesting, setHiDeskTesting,
    hiDeskTestResult, setHiDeskTestResult,
    hiDeskFetchingConfig, setHiDeskFetchingConfig,
    hiDeskRefreshing, setHiDeskRefreshing,
    hiDeskDomains, setHiDeskDomains,
    hiDeskDatasets, setHiDeskDatasets,
    hiDeskViews, setHiDeskViews,
    hiDeskSelectedDomain, setHiDeskSelectedDomain,
    hiDeskSelectedView, setHiDeskSelectedView,
    hiDeskSelectedKbSn, setHiDeskSelectedKbSn,
    hiDeskChatMode, setHiDeskChatMode,
    hiDeskRawConfig, setHiDeskRawConfig,
    readMemoryFile, writeMemoryFile, getFsRef, runTask,
  });

  const autologinHaiwen = async () => {
    const username = userInfo?.name || '';
    const password = userInfo?.password || '';
    if (!username || !password) {
      setHaiwenAuthenticated(false);
      setShowHaiwenLogin(true);
      setHaiwenLoginError(!username ? '请先登录应用账号' : '请先在应用登录时勾选“记住密码”，或手动输入海问思答账号密码');
      return false;
    }
    setHaiwenLoggingIn(true);
    setHaiwenLoginError('');
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/haiwen/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({username, password }),
      });
      const data = await resp.json();
      if (data.success) {
        setHaiwenAuthenticated(true);
        setShowHaiwenLogin(false);
        return true;
      } else {
        setHaiwenAuthenticated(false);
        setShowHaiwenLogin(true);
        setHaiwenLoginError(data.message || '自动登录失败，请手动输入');
        return false;
      }
    } catch (e) {
      setHaiwenAuthenticated(false);
      setShowHaiwenLogin(true);
      setHaiwenLoginError('后端服务未启动，无法自动登录');
      return false;
    } finally {
      setHaiwenLoggingIn(false);
    }
  };
  // 海问思答平台切换处理
  const handleHaiwenToggle = async () => {
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/haiwen/status');
      const data = await resp.json();
      if (data.success && data.authenticated) {
        setHaiwenAuthenticated(true);
      } else {
        await autologinHaiwen();
      }
    } catch (e) {
      console.error('[Haiwen] Failed to check status:', e);
      await autologinHaiwen();
    }
  };

  // 海问思答登录
  const handleHaiwenLogin = async () => {
    if (!haiwenUsername.trim() || !haiwenPassword.trim()) {
      setHaiwenLoginError('请输入账号和密码');
      return;
    }
    setHaiwenLoggingIn(true);
    setHaiwenLoginError('');
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/haiwen/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: haiwenUsername.trim(),
          password: haiwenPassword,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setHaiwenAuthenticated(true);
        setShowHaiwenLogin(false);
        setHaiwenUsername('');
        setHaiwenPassword('');
      } else {
        setHaiwenLoginError(data.message || '登录失败');
      }
    } catch (e) {
      setHaiwenLoginError('登录请求失败，请检查后端服务是否运行');
    } finally {
      setHaiwenLoggingIn(false);
    }
  };

  // 海问思答退出登录
  const handleHaiwenLogout = async () => {
    try {
      await fetch('http://127.0.0.1:5002/api/v1/haiwen/logout', { method: 'POST' });
    } catch (_) {}
    setHaiwenAuthenticated(false);
    setPlatforms(prev => ({ ...prev, haiwen: false }));
    writeMemoryFile({ platforms: { ...platforms, haiwen: false } });
  };

  const handleDatabaseMonitor = () => {
    console.log('Database monitoring');
  };

  const handleDatabaseManage = () => {
    console.log('Database management');
  };

  const handleLocalKnowledgeToggle = async () => {
    const { ipcRenderer } = window.require('electron');
    const isCurrentlyChecked = platforms.local;

    if (isCurrentlyChecked) {
      setPlatforms(prev => {
        const newPlatforms = { ...prev, local: false };
        writeMemoryFile({ platforms: newPlatforms });
        return newPlatforms;
      });
      setShowWikiWindow(false);
      return;
    }

    // 立即更新 UI 状态，避免用户等待时看不到任何变化
    initialStartupDone.current = true; // 阻止 useEffect 重复触发启动流程
    setKbListLoading(true); // 防止在服务就绪前误显示"暂无知识库"
    setPlatforms(prev => {
      const newPlatforms = { ...prev, local: true };
      writeMemoryFile({ platforms: newPlatforms });
      return newPlatforms;
    });

    // 先快速检查进程是否已在运行
    const processCheck = await ipcRenderer.invoke('check-llm-wiki-process');
    if (processCheck.running) {
      refreshWikiStatus();
      return;
    }

    // 检查二进制是否存在
    const binaryCheck = await ipcRenderer.invoke('check-llm-wiki-binary');
    if (binaryCheck.exists) {
      // 检查主进程是否已在自动启动 KMA，避免重复创建后台任务
      const { tasks: autoTasks2 } = await ipcRenderer.invoke('get-auto-start-status');
      if (autoTasks2 && autoTasks2.kma && autoTasks2.kma.status === 'running') {
        console.log('[LocalKnowledgeToggle] KMA auto-start already in progress, skip duplicate task');
        return;
      }
      // 快速启动（非阻塞）
      runTask('启动 KMA', async (updateMsg) => {
        updateMsg('【1/3】正在启动 KMA 进程...');
        const startResult = await ipcRenderer.invoke('start-llm-wiki-headless');
        if (!startResult.success) {
          setPlatforms(prev => {
            const newPlatforms = { ...prev, local: false };
            writeMemoryFile({ platforms: newPlatforms });
            return newPlatforms;
          });
          return { success: false, message: 'KMA 启动失败: ' + (startResult.message || '未知错误') };
        }
        updateMsg('【2/3】进程已启动，等待服务就绪...');
        const ready = await ipcRenderer.invoke('wait-llm-wiki-ready', 30000);
        if (ready) {
          updateMsg('【3/3】KMA 服务已就绪');
          refreshWikiStatus();
          // KMA 已就绪，触发待定自动任务
          ipcRenderer.invoke('run-pending-auto-tasks');
          return { success: true, message: 'KMA 已启动' };
        }
        setPlatforms(prev => {
          const newPlatforms = { ...prev, local: false };
          writeMemoryFile({ platforms: newPlatforms });
          return newPlatforms;
        });
        return { success: false, message: 'KMA 启动超时（30s），请检查 llm-wiki 是否正常。' };
      }, 35000);
      return;
    }

    // 未安装，直接后台下载安装
    runTask('安装 KMA', async (updateMsg) => {
      const result = await doInstallLlmWiki(updateMsg);
      if (!result || result.success === false) {
        setPlatforms(prev => {
          const newPlatforms = { ...prev, local: false };
          writeMemoryFile({ platforms: newPlatforms });
          return newPlatforms;
        });
      }
      return result;
    }, 3700000);
  };

  const handlePlatformChange = (platform) => {
    if (platform === 'webSearch') {
      if (!platforms.webSearch) {
        if (webSearchAvailable === false) {
          checkWebSearchConnectivity();
          return;
        }
        setPlatforms(prev => {
          const newPlatforms = { ...prev, webSearch: true };
          writeMemoryFile({ platforms: newPlatforms });
          return newPlatforms;
        });
        if (webSearchAvailable === null) checkWebSearchConnectivity();
      } else {
        setPlatforms(prev => {
          const newPlatforms = { ...prev, webSearch: false };
          writeMemoryFile({ platforms: newPlatforms });
          return newPlatforms;
        });
      }
      return;
    }
    if (platform === 'local') {
      handleLocalKnowledgeToggle();
      return;
    }
    setPlatforms(prev => {
      const newPlatforms = { ...prev, [platform]: !prev[platform] };
      writeMemoryFile({ platforms: newPlatforms });
      return newPlatforms;
    });

    if (platform === 'hiDesk' && !platforms.hiDesk) {
      hiDeskInitialCheckDone.current = true; // 防止 useEffect 重复触发
      handleHiDeskAutoStart();
    }

    // 海问思答开启时检查登录状态
    if (platform === 'haiwen' && !platforms.haiwen) {
      handleHaiwenToggle();
    }
  };

  const handleToggleWikiWindow = async () => {
    const { exec } = window.require('child_process');
    const action = showWikiWindow ? 'hide' : 'show';
    const command = `curl.exe -X POST http://127.0.0.1:19828/api/v1/window/${action}`;
    exec(command, (err) => {
      if (err) {
        console.error(`KMA window ${action} error:`, err.message);
        alert(`无法${action === 'show' ? '显示' : '隐藏'}管理页面: ` + err.message);
        return;
      }
      setShowWikiWindow(!showWikiWindow);
    });
  };

  const handleClearHistory = () => {
    setMessages([]);
    setChrysSessionId(null);
    refocusInput();
  };

  const handleSaveHistory = async () => {
    if (messages.length === 0) {
      toastRef.current?.show('当前没有对话内容可保存');
      return;
    }

    try {
      // 构建导出内容：根据扩展名准备两种格式
      const jsonContent = JSON.stringify(messages, null, 2);
      const mdLines = messages.map((msg) => {
        const role = msg.type === 'user' ? '**用户**' : '**AI助手**';
        return `${role}:\n\n${msg.content}\n\n---\n`;
      });
      const mdContent = `# 对话记录\n\n> 导出时间: ${new Date().toLocaleString()}\n\n---\n\n${mdLines.join('\n')}`;

      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('save-chat-history', {
        title: '保存对话历史',
        defaultPath: `对话记录_${new Date().toISOString().slice(0, 10)}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'JSON', extensions: ['json'] },
          { name: '文本文件', extensions: ['txt'] },
          { name: '所有文件', extensions: ['*'] }
        ],
        content: mdContent,
      });

      // 恢复输入框焦点（原生对话框会夺走焦点）
      refocusInput();

      if (result.canceled) return;

      // JSON 格式覆盖写入
      if (result.filePath.toLowerCase().endsWith('.json')) {
        const fs = getFsRef();
        fs.writeFileSync(result.filePath, jsonContent, 'utf-8');
      }

      if (result.error) {
        toastRef.current?.show('保存失败: ' + result.error);
      } else {
        toastRef.current?.show('对话已保存');
      }
    } catch (err) {
      console.error('Failed to save conversation:', err);
      toastRef.current?.show('保存对话失败');
      refocusInput();
    }
  };

  const handleSend = () => {
    if (!inputValue.trim()) return;
    
    const newMessages = [...messages, { type: 'user', content: inputValue }];
    setMessages(newMessages);
    setInputValue('');
    setIsSearching(true);

    setTimeout(() => {
      const response = '根据您的问题，我从知识库中为您找到了相关信息...';
      const updatedMessages = [...newMessages, { type: 'assistant', content: response }];
      setMessages(updatedMessages);
      setIsSearching(false);
    }, 1500);
  };

  // 获取知识库列表
  const fetchKnowledgeBaseList = async (signal, silent = false) => {
    if (signal && signal.aborted) return;
    try {
      const response = await fetch('http://127.0.0.1:5002/api/v1/projects', { signal });
      const data = await response.json();
      if (data.success) {
        setKnowledgeBaseList((data.data && data.data.projects) ? data.data.projects : (data.projects || []));
      } else {
        // 请求失败时保留旧数据，仅静默重试场景下不打印警告
        if (!silent) {
          setKnowledgeBaseList([]);
          setSelectedKBIds([]);
          setProjectPath('');
          console.warn('Failed to fetch project list:', data.message);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Failed to fetch knowledge base list:', error);
      }
      // AbortError 时静默保留旧数据；其他错误仅在无旧数据时清空
      if (error.name !== 'AbortError') {
        setKnowledgeBaseList(prev => prev.length > 0 ? prev : []);
      }
    }
  };

  const refreshProjectDropdown = () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    fetch('http://127.0.0.1:5002/api/v1/server/health', { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        const wikiOk = data.llm_wiki_status && data.llm_wiki_status.ok;
        if (!wikiOk) {
          setKnowledgeBaseList([]);
          setSelectedKBIds([]);
          setProjectPath('');
          return;
        }
        return fetchKnowledgeBaseList(controller.signal, true);
      })
      .catch(() => {
        // 仅在之前没有数据时才清空，避免列表一闪而过
        setKnowledgeBaseList(prev => prev.length > 0 ? prev : []);
      })
      .finally(() => clearTimeout(timeout));
  };

  // 加载 LLM 配置
  const fetchLlmConfig = async (silent = true) => {
    setLlmConfigLoading(true);
    try {
      const response = await fetch('http://127.0.0.1:5002/api/v1/server/llm-config');
      const data = await response.json();
      if (data.success && data.data) {
        const cfg = data.data;
        // 只在服务端返回非空值时更新本地状态，避免空值覆盖已有有效配置
        if (cfg.llm_url) setLlmUrl(cfg.llm_url);
        if (cfg.llm_api_key) setLlmApiKey(cfg.llm_api_key);
        if (cfg.llm_model) setLlmModel(cfg.llm_model);
        if (cfg.llm_embedding_model) setLlmEmbeddingModel(cfg.llm_embedding_model);
      }
    } catch (error) {
      if (!silent) {
        console.error('Failed to load LLM config:', error);
      }
    } finally {
      setLlmConfigLoading(false);
    }
  };

  const fetchVectorVisualization = async () => {
    if (selectedKBIds.length === 0) return;
    const kbId = selectedKBIds[selectedKBIds.length - 1].split('::')[0];
    setVectorLoading(true);
    setVectorError('');
    setVectorData(null);
    try {
      const resp = await fetch(
        `http://127.0.0.1:5002/api/v1/projects/${kbId}/vectors/visualize`,
        { signal: AbortSignal.timeout(30000) }
      );
      const data = await resp.json();
      if (data.success && data.data && data.data.points) {
        setVectorData(data.data);
      } else {
        setVectorError(data.message || '获取向量数据失败');
      }
    } catch (error) {
      setVectorError('获取向量失败: ' + (error.message || '网络错误'));
    } finally {
      setVectorLoading(false);
    }
  };

  const drawVectorCanvas = () => {
    const canvas = vectorCanvasRef.current;
    const data = vectorData;
    if (!canvas || !data || !data.points || data.points.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width || 600;
    const h = 400;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);

    const margin = { top: 30, right: 30, bottom: 40, left: 50 };
    const pw = w - margin.left - margin.right;
    const ph = h - margin.top - margin.bottom;

    const xs = data.points.map(p => p.x);
    const ys = data.points.map(p => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    const scaleX = v => margin.left + (v - xMin) / xRange * pw;
    const scaleY = v => margin.top + ph - (v - yMin) / yRange * ph;

    const pageColors = {};
    const colorPalette = ['#6366f1','#f43f5e','#10b981','#f59e0b','#3b82f6','#ec4899','#8b5cf6','#14b8a6','#f97316','#06b6d4'];
    let ci = 0;
    data.points.forEach(p => {
      if (!pageColors[p.page_id]) {
        pageColors[p.page_id] = colorPalette[ci % colorPalette.length];
        ci++;
      }
    });

    ctx.fillStyle = theme === 'dark' ? '#1f2937' : '#f9fafb';
    ctx.fillRect(margin.left, margin.top, pw, ph);

    ctx.strokeStyle = theme === 'dark' ? '#374151' : '#e5e7eb';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + ph * i / 4;
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + pw, y); ctx.stroke();
      const x = margin.left + pw * i / 4;
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + ph); ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = theme === 'dark' ? '#9ca3af' : '#6b7280';
    ctx.font = '11px system-ui';
    ctx.fillText(`PC1 + PC2 解释方差: ${(data.explained_variance_2d * 100).toFixed(1)}%`, w / 2, margin.top - 10);

    canvas._points = data.points;
    canvas._scaleX = scaleX;
    canvas._scaleY = scaleY;
    canvas._pageColors = pageColors;

    data.points.forEach(p => {
      const cx = scaleX(p.x);
      const cy = scaleY(p.y);
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = pageColors[p.page_id];
      ctx.fill();
      ctx.strokeStyle = theme === 'dark' ? '#1f2937' : '#fff';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    });
  };

  useEffect(() => {
    if (showVectorModal && selectedKBIds.length > 0) {
      fetchVectorVisualization();
    }
  }, [showVectorModal, selectedKBIds]);

  useEffect(() => {
    if (showVectorModal && vectorData) {
      const timer = setTimeout(drawVectorCanvas, 50);
      window.addEventListener('resize', drawVectorCanvas);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('resize', drawVectorCanvas);
      };
    }
  }, [vectorData, showVectorModal]);

  // 保存 LLM 配置
  const saveLlmConfig = async () => {
    setLlmConfigSaving(true);
    setLlmConfigStatus(null);
    try {
      // 保存配置模式（mode 2）：selected_model_id + config 值 → 更新 models.json 条目
      const configPayload = {
        selected_model_id: selectedModelConfigId,
        llm_url: llmUrl,
        llm_api_key: llmApiKey,
        llm_model: llmModel,
        llm_embedding_model: llmEmbeddingModel,
      };
      console.log('[saveLlmConfig] payload:', { ...configPayload, llm_api_key: configPayload.llm_api_key ? '***' : '' });
      const response = await fetch('http://127.0.0.1:5002/api/v1/server/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configPayload),
      });
      // 更新当前选中模型配置到 models.json
      const modelIndex = savedModels.findIndex(m => m.id === selectedModelConfigId);
      if (modelIndex >= 0) {
        const updatedModels = [...savedModels];
        updatedModels[modelIndex] = {
          ...updatedModels[modelIndex],
          url: llmUrl,
          apiKey: llmApiKey,
          model: llmModel,
          embeddingModel: llmEmbeddingModel,
        };
        setSavedModels(updatedModels);
        syncModelsToConfigFile(updatedModels);
      }
      const data = await response.json();
      if (data.success) {
        setLlmConfigStatus({ type: 'success', message: 'LLM 配置已保存' });
      } else {
        setLlmConfigStatus({ type: 'error', message: data.message || '保存失败' });
      }
    } catch (error) {
      console.error('Failed to save LLM config:', error);
      setLlmConfigStatus({ type: 'error', message: `保存失败: ${error.message}` });
    } finally {
      setLlmConfigSaving(false);
    }
  };

  // 创建知识库 - 通过弹窗
  const handleCreateKnowledgeBase = async () => {
    const kbName = (newKBName || '').trim();
    const kbPath = (newKBPath || '').trim();
    if (!kbName) {
      alert('请输入知识库名称');
      return;
    }
    if (!kbPath) {
      alert('请输入知识库存放路径');
      return;
    }
    
    try {
      const response = await fetch('http://127.0.0.1:5002/api/v1/projects/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: kbName, path: kbPath }),
      });
      
      const result = await response.json();
      
      if (response.ok && result.success) {
        const pid = result.data.project_id;
        const ppath = result.data.path;
        setSelectedKBIds([pid]);
        setProjectPath(ppath);
        writeMemoryFile({ activeKnowledgeBase: { id: pid, path: ppath } });
        alert(`知识库创建成功！路径: ${ppath}`);
        setShowCreateKBModal(false);
        setNewKBName('');
        setNewKBPath('');

        fetch('http://127.0.0.1:5002/api/v1/projects/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: ppath }),
        }).catch(e => console.error('Failed to register knowledge base with backend:', e));

        fetchKnowledgeBaseList();
      } else {
        alert(`知识库创建失败: ${result.message || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to create knowledge base:', error);
      alert('创建知识库失败，请检查 KMA Server (5002) 是否已启动');
    }
  };

  // 注册已有知识库（选择已存在的项目目录）
  const handleRegisterExistingKB = async () => {
    const { ipcRenderer } = window.require('electron');
    const selectedPath = await ipcRenderer.invoke('open-file-dialog', {
      properties: ['openDirectory'],
    });
    if (!selectedPath) { refocusInput(); return; }

    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/projects/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath }),
      });
      const result = await resp.json();
      if (result.success) {
        const name = result.data?.name || selectedPath.split('\\').pop();
        alert(`知识库 "${name}" 注册成功`);
        fetchKnowledgeBaseList();
      } else {
        alert(`注册失败: ${result.message || '所选目录不是有效的知识库项目'}`);
      }
    } catch (e) {
      console.error('Failed to register existing KB:', e);
      alert('注册知识库失败，请检查 KMA Server (5002) 是否已启动');
    }
  };

  // 刷新个人知识库：重新拉取列表并对每个个人知识库触发 rescan
  const handleRefreshPersonalKB = async () => {
    const taskId = addTask('刷新个人知识库');
    try {
      updateTask(taskId, { message: '正在获取项目列表...' });

      const resp = await fetch('http://127.0.0.1:5002/api/v1/projects');
      const data = await resp.json();
      const projects = (data.data && data.data.projects) ? data.data.projects : (data.projects || []);

      const personalList = projects.filter(kb => !isCommonKb(kb) && !isCommonKbParentDir(kb) && kb.path);
      if (personalList.length === 0) {
        updateTask(taskId, { status: 'completed', message: '没有需要刷新的个人知识库' });
        return;
      }

      const total = personalList.length;
      let done = 0;
      const results = [];

      for (const kb of personalList) {
        updateTask(taskId, { message: `正在重新索引 (${done + 1}/${total}): ${kb.name || kb.id}...` });
        try {
          const res = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/rescan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: kb.path }),
          });
          const r = await res.json();
          const triggered = r.data?.triggered;
          const reason = r.data?.reason;
          results.push({
            name: kb.name || kb.id,
            ok: r.success && triggered,
            triggered,
            reason: !triggered ? (reason || 'unknown') : undefined,
            error: r.data?.error,
          });
        } catch (e) {
          results.push({ name: kb.name || kb.id, ok: false, error: e.message });
        }
        done++;
        updateProgress(taskId, Math.round((done / total) * 70));
      }

      console.log('Personal KB rescan results:', JSON.stringify(results));

      const succeeded = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok).length;

      // KMA 内部计数不一定追踪所有文件，无需等待；直接刷新列表和统计
      updateTask(taskId, { message: '正在更新知识库列表...' });
      updateProgress(taskId, 90);
      await fetchKnowledgeBaseList();
      await fetchAllKBStats(personalList);

      updateProgress(taskId, 100);

      let message = `已刷新 ${succeeded}/${total} 个知识库`;
      if (failed > 0) {
        const failedNames = results.filter(r => !r.ok).map(r => `${r.name}(${r.reason || r.error || '未知错误'})`).join(', ');
        message += `，${failed} 个失败: ${failedNames}`;
        updateTask(taskId, { status: 'completed', message });
      } else {
        updateTask(taskId, { status: 'completed', message });
      }
    } catch (e) {
      console.error('Failed to refresh personal KB:', e);
      updateTask(taskId, { status: 'failed', message: e.message || '刷新失败' });
    }
  };

  // 单个知识库触发 rescan（同步触发 + 后台轮询进度）
  const handleKbRescan = async (kb) => {
    const kbId = kb.id || kb.knowledge_base_id;
    const kbName = kb.name || kbId;
    const kbPath = kb.path;
    const taskId = addTask(`重新扫描: ${kbName}`);
    try {
      updateTask(taskId, { message: '正在触发重新扫描...' });
      const res = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_path: kbPath }),
      });
      const r = await res.json();
      if (r.success && r.data?.triggered) {
        updateTask(taskId, { status: 'completed', message: `${kbName} 重新扫描已触发，KMA 后端正在处理...` });
        // 启动轮询
        startKbRescanPoll(kbId, kbPath);
      } else {
        const reason = r.data?.reason || 'unknown';
        updateTask(taskId, { status: 'failed', message: `${kbName} 扫描失败: ${reason}` });
      }
    } catch (e) {
      console.error('Kb rescan failed:', e);
      updateTask(taskId, { status: 'failed', message: e.message || '扫描失败' });
    }
  };

  // 启动单个 KB 的 rescan 进度轮询
  const startKbRescanPoll = (kbId, kbPath) => {
    // 清除已有轮询
    if (kbRescanTimersRef.current[kbId]) {
      clearInterval(kbRescanTimersRef.current[kbId]);
    }

    setKbRescanProgress(prev => ({
      ...prev,
      [kbId]: { status: 'running', pct: 0, done: 0, total: 0 }
    }));

    const poll = async () => {
      try {
        const resp = await fetch(`http://127.0.0.1:5002/api/v1/projects/rescan-progress?project_path=${encodeURIComponent(kbPath)}`);
        const data = await resp.json();
        if (!data.success) return;

        const d = data.data || {};
        const bg = d.background;
        const q = d.queue_summary || {};
        const done = q.done || 0;
        const total = q.total || 0;
        const processing = q.processing || 0;
        const pending = q.pending || 0;
        const completed = done + (q.failed || 0);
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

        if (bg && bg.status === 'running') {
          setKbRescanProgress(prev => ({
            ...prev,
            [kbId]: { status: 'running', pct, done: completed, total, processing, pending }
          }));
        } else if (bg && bg.status === 'done') {
          setKbRescanProgress(prev => ({
            ...prev,
            [kbId]: { status: 'done', pct: 100, done: completed, total: total || completed }
          }));
          // 完成后停止轮询
          clearInterval(kbRescanTimersRef.current[kbId]);
          delete kbRescanTimersRef.current[kbId];
          // 刷新统计
          await fetchAllKBStats();
          // 2 秒后清除进度显示
          setTimeout(() => {
            setKbRescanProgress(prev => {
              const next = { ...prev };
              delete next[kbId];
              return next;
            });
          }, 3000);
        } else if (bg && bg.status === 'error') {
          setKbRescanProgress(prev => ({
            ...prev,
            [kbId]: { status: 'error', pct, done: completed, total: total || 0, error: bg.error }
          }));
          clearInterval(kbRescanTimersRef.current[kbId]);
          delete kbRescanTimersRef.current[kbId];
          setTimeout(() => {
            setKbRescanProgress(prev => {
              const next = { ...prev };
              delete next[kbId];
              return next;
            });
          }, 5000);
        } else {
          // 后台状态为 null 但队列有数据
          if (total > 0 && d.queue_exists) {
            setKbRescanProgress(prev => ({
              ...prev,
              [kbId]: { status: 'running', pct, done: completed, total, processing, pending }
            }));
          }
        }
      } catch (_) {
        // 网络错误，忽略本次轮询
      }
    };

    poll(); // 立即执行一次
    kbRescanTimersRef.current[kbId] = setInterval(poll, 2000);
  };

  // 支持导入的文件扩展名
  const SUPPORTED_EXTENSIONS = ['.md', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];

  // 导入单个文件
  const handleImportFile = async () => {
    if (selectedKBIds.length === 0) {
      alert('请先选择或创建知识库');
      return;
    }

    const { ipcRenderer } = window.require('electron');
    const selectedPath = await ipcRenderer.invoke('open-file-dialog', {
      properties: ['openFile'],
      filters: [
        { name: '支持的文件', extensions: SUPPORTED_EXTENSIONS.map(e => e.replace('.', '')) },
      ],
    });

    if (!selectedPath) { refocusInput(); return; }

    const ext = '.' + selectedPath.split('.').pop().toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      toastRef.current?.show(`不支持的文件类型: ${ext}`);
      refocusInput();
      return;
    }

    try {
      const kbId = selectedKBIds[selectedKBIds.length - 1].split('::')[0];
      markKbPreprocessing(kbId);
      await doImportFile(selectedPath);
      unmarkKbPreprocessing(kbId);
    } catch (error) {
      const kbId = selectedKBIds[selectedKBIds.length - 1].split('::')[0];
      unmarkKbPreprocessing(kbId);
      toastRef.current?.show(`导入文件失败：${error.message}`);
    }
  };

  // 导入文件夹（调用 5002 批量导入 API）
  const handleImportFolder = async () => {
    if (selectedKBIds.length === 0) {
      alert('请先选择或创建知识库');
      return;
    }

    const { ipcRenderer } = window.require('electron');
    const selectedPath = await ipcRenderer.invoke('open-file-dialog', {
      properties: ['openDirectory'],
    });

    if (!selectedPath) { refocusInput(); return; }

    const kbId = selectedKBIds[selectedKBIds.length - 1].split('::')[0];
    markKbPreprocessing(kbId);
    try {
      const response = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/import-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_path: projectPath,
          source_folder_path: selectedPath,
          enable_image_to_desc: preprocessorConfig?.processors?.image_to_desc?.enabled || false,
        }),
      });

      const data = await response.json();

      if (data.success) {
        const result = data.data;
        const count = result.file_count || (result.files ? result.files.length : 0);
        const folderName = result.folder_name || '';
        const preprocessedCount = (result.preprocessed_files && result.preprocessed_files.length) || 0;
        let msg = `导入完成：成功 ${count} 个文件${folderName ? ` （${folderName}）` : ''}`;
        if (preprocessedCount > 0) {
          msg += ` (${preprocessedCount} 个 Markdown 已预处理转换)`;
        }
        toastRef.current?.show(msg);
        // 后端已自动处理文件夹中的 markdown 图片转结构化信息，显示结果
        if (result.md_mermaid && result.md_mermaid.length > 0) {
          const totalInserted = result.md_mermaid.reduce((sum, m) => sum + (m.inserted || 0), 0);
          if (totalInserted > 0) {
            toastRef.current?.show(`结构化信息已插入：${totalInserted} 个图表`);
          }
        }
      } else {
        toastRef.current?.show(`导入失败: ${data.message || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to import folder:', error);
      toastRef.current?.show('导入文件夹失败，请检查 KMA Server (5002) 是否已启动');
    } finally {
      unmarkKbPreprocessing(kbId);
    }
  };

  // 触发 Markdown 文件内图片转结构化信息
  // 解析 md 中的图片引用 → Vision LLM 检测图表 → 在原位插入结构化信息（mermaid/table/code/list）
  // 返回 Promise，便于导入前等待处理完成
  const triggerMarkdownImageProcessing = async (mdFilePath) => {
    console.log(`[MdMermaid] triggerMarkdownImageProcessing: start, md=${mdFilePath}`);
    try {
      const res = await fetch('http://127.0.0.1:5002/api/v1/projects/process-markdown-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md_file_path: mdFilePath }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        const d = data.data;
        console.log(`[MdMermaid] done: total=${d.total_images}, inserted=${d.inserted}, errors=${d.errors}, details=`, d.details);
        if (d.inserted > 0) {
          toastRef.current?.show(`结构化信息已插入：${d.inserted} 个图表（共 ${d.total_images} 张图片）`);
        }
      }
    } catch (e) {
      console.log(`[MdMermaid] fetch error:`, e.message);
    }
  };

  // 执行单个文件的导入API调用
  const doImportFile = async (filePath) => {
    const sourceFileName = filePath.split(/[/\\]/).pop();
    const isMarkdown = /\\.(?:md|markdown)$/i.test(sourceFileName);

    // 生成 taskId 供后端写入预处理实时进度，前端同步轮询展示
    const importTaskId = (crypto?.randomUUID?.() || `imp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    startImportProgressPolling(importTaskId);

    try {
      const response = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/import-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_path: projectPath,
          source_file_path: filePath,
          import_task_id: importTaskId,
          enable_image_to_desc: preprocessorConfig?.processors?.image_to_desc?.enabled || false,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || '导入失败');
      }

      const result = data.data;
      const fileName = result.filename || result.destination;

      // 构建导入成功提示信息
      let message = `文件导入成功：${fileName}`;
      if (result.preprocessed) {
        const parts = ['已预处理转换'];
        if (result.plantuml_files && result.plantuml_files > 0) {
          parts.push(`${result.plantuml_files} 个 PlantUML 图表已提取并总结`);
        }
        message += ` (${parts.join('，')})`;
      }
      toastRef.current?.show(message);

      // 后端已自动处理 markdown 图片转结构化信息，显示结果
      if (result.md_mermaid && result.md_mermaid.inserted > 0) {
        toastRef.current?.show(`结构化信息已插入：${result.md_mermaid.inserted} 个图表`);
      }
    } catch (err) {
      // 网络异常或后端未正常写入完成态时，兜底停止轮询
      stopImportProgressPolling();
      setImportProgress({ active: false });
      throw err;
    }
  };

  // 查看知识库文件列表
  const handleViewFileList = async () => {
    if (selectedKBIds.length === 0) {
      alert('请先选择或创建知识库');
      return;
    }
    
    try {
      const kbId = selectedKBIds[selectedKBIds.length - 1].split('::')[0];
      const response = await fetch(`http://127.0.0.1:5002/api/v1/projects/${encodeURIComponent(kbId)}/files?root=sources&recursive=true`);
      
      const data = await response.json();
      
      if (data.success) {
        const files = data.files || data.data?.files || [];
        setFileList(files);
        setFileTree(buildFileTree(files));
        setShowFileListModal(true);
      } else {
        alert(`获取文件列表失败: ${data.message || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to fetch file list:', error);
      alert('获取文件列表失败，请检查 KMA Server (5002) 是否已启动');
    }
  };

  // 打开知识库设置弹窗
  const openKBSettings = async (kb) => {
    setEditingKB(kb);
    setEditingKBName(kb.name || kb.knowledge_base_id || '');
    setEditingKBDesc(kb.description || '');
    setShowKBSettingsModal(true);
    await fetchKBKnowledgeList(kb);
  };

  // 保存预处理设置
  const savePreprocessorSettings = () => {
    const cfg = {
      ...preprocessorConfig,
      username: userInfo?.name || '',
      password: userInfo?.password || '',
    };
    writeMemoryFile({ preprocessor: cfg });
    setPreprocessorConfig(cfg);
    setShowPreprocessorSettingsModal(false);
  };

  // 切换预处理自动管理
  const togglePreprocessorAutoManage = () => {
    const newVal = !preprocessorAutoManage;
    setPreprocessorAutoManage(newVal);
    writeMemoryFile({ preprocessorAutoManage: newVal });
    if (!newVal) {
      setPreprocessorServiceStatus({});
    }
  };

  // 启动预处理服务（从远端下载并启动）
  const setupPreprocessorService = async () => {
    setPreprocessorServiceStatus({ status: 'starting', logs: ['[启动] 开始部署预处理服务...'] });
    try {
      const { ipcRenderer } = window.require('electron');
      const port = preprocessorConfig.port || 5900;
      const result = await ipcRenderer.invoke('setup-preprocessor-service', {
        port,
        remoteConfig: { ip: '7.212.122.246', remotePath: '/home/Knowledge_Management/cloudmodeling-processor.exe' },
      });
      if (result.success) {
        setPreprocessorServiceStatus({
          status: 'running',
          message: result.wasRunning ? '服务已在运行中' : '服务启动成功',
          logs: result.logs || [],
        });
      } else {
        setPreprocessorServiceStatus({
          status: 'error',
          message: result.message || '启动失败',
          logs: result.logs || [],
        });
      }
    } catch (err) {
      setPreprocessorServiceStatus({
        status: 'error',
        message: err.message || '启动异常',
        logs: [`[错误] ${err.message || '启动异常'}`],
      });
    }
  };

  // 停止预处理服务
  const stopPreprocessorService = async () => {
    setPreprocessorServiceStatus(prev => ({ ...prev, status: 'stopping', logs: [...(prev.logs || []), '[停止] 正在停止预处理服务...'] }));
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('stop-preprocessor-service');
      setPreprocessorServiceStatus({
        status: 'stopped',
        message: '服务已停止',
        logs: [...(result.logs || []), '[完成] 服务已停止'],
      });
    } catch (err) {
      setPreprocessorServiceStatus({
        status: 'error',
        message: err.message || '停止异常',
        logs: [`[错误] ${err.message || '停止异常'}`],
      });
    }
  };

  // 获取知识库内部知识列表
  const fetchKBKnowledgeList = async (kb) => {
    if (!kb) return;
    const kbKey = getKbKey(kb);
    const genSnapshot = kbGenerationRef.current;

    // 创建新的 AbortController 并保存
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    fetchAbortRef.current = new AbortController();
    const signal = fetchAbortRef.current.signal;

    setKbKnowledgeLoading(true);
    try {
      const kbPath = kb.path;
      const kbId = kb.id || kb.knowledge_base_id;
      if (!kbPath) {
        setKbKnowledgeList([]);
        return;
      }
      const response = await fetch(`http://127.0.0.1:5002/api/v1/projects/sources?project_path=${encodeURIComponent(kbPath)}&recursive=true`, { signal });
      if (signal.aborted) return;
      const data = await response.json();

      // 代际守卫：如果 KB 已切换，丢弃过期结果
      if (kbGenerationRef.current !== genSnapshot) {
        console.log(`[KnowledgeManagement] fetchKBKnowledgeList: generation mismatch, discarding stale data for ${kbKey}`);
        return;
      }

      if (data.success && data.data) {
        const sources = data.data.sources || [];
        const enrichedSources = sources
          .filter(s => !s.is_dir)
          .map(s => {
            return {
              ...s,
              name: s.filename || s.relative_path || '',
            };
          });
        setKbKnowledgeList(enrichedSources);
      } else {
        setKbKnowledgeList([]);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`[KnowledgeManagement] fetchKBKnowledgeList aborted for ${kbKey}`);
        return;
      }
      console.error('Failed to fetch knowledge list:', error);
      setKbKnowledgeList([]);
    } finally {
      // 只有 generation 仍匹配时才重置 loading 状态
      if (kbGenerationRef.current === genSnapshot) {
        setKbKnowledgeLoading(false);
      }
    }
  };

  // 保存知识库设置
  const saveKBSettings = async () => {
    if (!editingKB) return;
    if (!editingKBName.trim()) {
      alert('请输入知识库名称');
      return;
    }
    try {
      const kbPath = editingKB.path;
      const response = await fetch('http://127.0.0.1:5002/api/v1/projects/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_path: kbPath,
          name: editingKBName.trim(),
          description: editingKBDesc.trim()
        })
      });
      const data = await response.json();
      const kbId = editingKB.id || editingKB.knowledge_base_id;
      if (data.success) {
        const updatedList = knowledgeBaseList.map(kb => {
          if ((kb.id || kb.knowledge_base_id) === kbId) {
            return { ...kb, name: editingKBName.trim(), description: editingKBDesc.trim() };
          }
          return kb;
        });
        setKnowledgeBaseList(updatedList);
        updateKbMetadata(kbId, { name: editingKBName.trim(), description: editingKBDesc.trim() });
        setShowKBSettingsModal(false);
        setEditingKB(null);
        alert('知识库设置已保存');
      } else {
        alert(`保存失败: ${data.message || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to save KB settings:', error);
      updateKbMetadata(editingKB.id || editingKB.knowledge_base_id, { name: editingKBName.trim(), description: editingKBDesc.trim() });
      const updatedList = knowledgeBaseList.map(kb => {
        if ((kb.id || kb.knowledge_base_id) === (editingKB.id || editingKB.knowledge_base_id)) {
          return { ...kb, name: editingKBName.trim(), description: editingKBDesc.trim() };
        }
        return kb;
      });
      setKnowledgeBaseList(updatedList);
      setShowKBSettingsModal(false);
      setEditingKB(null);
      alert('知识库设置已保存到本地');
    }
  };

  // 删除知识库
  const deleteKB = async () => {
    if (!editingKB) return;
    const kbName = editingKB.name || editingKB.knowledge_base_id;
    const confirmed = window.confirm(`确定要删除知识库 "${kbName}" 吗？`);
    if (!confirmed) return;

    const deep = window.confirm(
      `是否同时删除磁盘上的知识库文件？\n\n` +
      `"确定" = 深度删除（从列表移除 + 删除 ${kbName} 目录下所有文件，不可恢复）\n` +
      `"取消" = 仅从列表中移除（磁盘文件保留，可重新注册）`
    );

    await _doDeleteKB(deep);
  };

  const _doDeleteKB = async (deep = false) => {
    if (!editingKB) return;
    const kbName = editingKB.name || editingKB.knowledge_base_id;
    try {
      const kbPath = editingKB.path;
      const response = await fetch('http://127.0.0.1:5002/api/v1/projects/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_path: kbPath, deep }),
      });
      const data = await response.json();
      if (data.success) {
        const kbId = editingKB.id || editingKB.knowledge_base_id;
        const kbKey = getKbKey(editingKB);
        const updatedList = knowledgeBaseList.filter(kb => (kb.id || kb.knowledge_base_id) !== kbId);
        setKnowledgeBaseList(updatedList);
        if (selectedKBIds.includes(kbKey)) {
          setSelectedKBIds(prev => prev.filter(i => i !== kbKey));
          setProjectPath('');
          writeMemoryFile({ activeKnowledgeBase: { id: '', path: '' } });
        }
        removeKbMetadata(kbId);
        setShowKBSettingsModal(false);
        setEditingKB(null);
        setEditingKBName('');
        setEditingKBDesc('');
        const msg = data.data?.disk_deleted
          ? `知识库 "${kbName}" 已删除（含磁盘文件）`
          : `知识库 "${kbName}" 已从列表移除（文件保留）`;
        alert(msg);
      } else {
        alert(`删除失败: ${data.message || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to delete KB:', error);
      alert('删除知识库失败，请检查 KMA Server (5002) 是否已启动');
    }
  };

  // 删除知识（支持文件和目录）
  const deleteKnowledge = async (relPath, isDir = false) => {
    if (!editingKB) return;
    const label = isDir ? '目录' : '文件';
    const confirmed = window.confirm(`确定要删除此${label}吗？${isDir ? '\n所有子文件将被一并删除。' : ''}`);
    if (!confirmed) return;
    try {
      const kbPath = editingKB.path;
      const typeParam = isDir ? '&type=folder' : '';
      const response = await fetch(`http://127.0.0.1:5002/api/v1/projects/sources?project_path=${encodeURIComponent(kbPath)}&rel_path=${encodeURIComponent(relPath)}${typeParam}`, {
        method: 'DELETE'
      });
      const data = await response.json();
      if (data.success) {
        if (isDir) {
          // 目录删除：移除所有以该目录路径开头的条目
          const prefix = relPath.endsWith('/') ? relPath : relPath + '/';
          setKbKnowledgeList(prev => prev.filter(k => !(k.relative_path || k.name || '').startsWith(prefix) && (k.relative_path || k.name) !== relPath));
        } else {
          setKbKnowledgeList(prev => prev.filter(k => (k.relative_path || k.name) !== relPath));
        }
        await fetchKBStats(editingKB);
      } else {
        alert(`删除失败: ${data.message || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to delete knowledge:', error);
      alert('删除知识失败');
    }
  };

  // 导入文件到当前编辑的知识库
  const importFilesToKB = async () => {
    if (!editingKB) return;
    const { ipcRenderer } = window.require('electron');
    const selectedPaths = await ipcRenderer.invoke('open-file-dialog', {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文件', extensions: ['md', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'] }
      ]
    });
    if (!selectedPaths || selectedPaths.length === 0) { refocusInput(); return; }
    const kbId = editingKB.id || editingKB.knowledge_base_id;
    markKbPreprocessing(kbId);
    const paths = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
    let successCount = 0;
    let failCount = 0;
    let preprocessedCount = 0;
    let plantumlTotal = 0;
    for (let idx = 0; idx < paths.length; idx++) {
      const filePath = paths[idx];
      const fName = filePath.split(/[/\\]/).pop();
      const isMd = /\.(?:md|markdown)$/i.test(fName);
      // 生成 taskId 供后端写入预处理实时进度，前端轮询展示
      const importTaskId = (crypto?.randomUUID?.() || `imp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      if (isMd) {
        startImportProgressPolling(importTaskId);
      }
      try {
        const response = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/import-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_path: editingKB.path,
            source_file_path: filePath,
            import_task_id: importTaskId,
            enable_image_to_desc: preprocessorConfig?.processors?.image_to_desc?.enabled || false,
          })
        });
        const data = await response.json();
        if (data.success) {
          successCount++;
          if (data.data?.preprocessed) {
            preprocessedCount++;
            plantumlTotal += (data.data.plantuml_files || 0);
          }
          // 后端已自动处理 markdown 图片转结构化信息
          if (data.data?.md_mermaid?.inserted > 0) {
            toastRef.current?.show(`结构化信息已插入：${data.data.md_mermaid.inserted} 个图表`);
          }
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      } finally {
        if (isMd) {
          stopImportProgressPolling();
        }
      }
    }
    stopImportProgressPolling();
    setImportProgress({ active: false });
    let msg = `导入完成：成功 ${successCount} 个，失败 ${failCount} 个`;
    if (preprocessedCount > 0) {
      const parts = [`${preprocessedCount} 个 Markdown 已预处理转换`];
      if (plantumlTotal > 0) parts.push(`${plantumlTotal} 个 PlantUML 图表已提取`);
      msg += ` (${parts.join('，')})`;
    }
    toastRef.current?.show(msg);
    unmarkKbPreprocessing(kbId);
    await fetchKBKnowledgeList(editingKB);
    await fetchKBStats(editingKB);
    refocusInput();
  };

  const importFoldersToKB = async () => {
    if (!editingKB) return;
    const { ipcRenderer } = window.require('electron');
    const selectedPaths = await ipcRenderer.invoke('open-file-dialog', {
      properties: ['openDirectory', 'multiSelections']
    });
    if (!selectedPaths || selectedPaths.length === 0) { refocusInput(); return; }
    const kbId = editingKB.id || editingKB.knowledge_base_id;
    markKbPreprocessing(kbId);
    const paths = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
    let successCount = 0;
    let failCount = 0;
    let preprocessedCount = 0;
    for (let fi = 0; fi < paths.length; fi++) {
      const folderPath = paths[fi];
      // 生成 taskId 供后端写入预处理实时进度，前端轮询展示
      const importTaskId = (crypto?.randomUUID?.() || `imp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      startImportProgressPolling(importTaskId);
      try {
        const response = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/import-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_path: editingKB.path,
            source_folder_path: folderPath,
            import_task_id: importTaskId,
            enable_image_to_desc: preprocessorConfig?.processors?.image_to_desc?.enabled || false,
          })
        });
        const data = await response.json();
        if (data.success) {
          successCount++;
          if (data.data?.preprocessed_files?.length > 0) {
            preprocessedCount += data.data.preprocessed_files.length;
          }
          // 后端已自动处理文件夹中的 markdown 图片转结构化信息
          if (data.data?.md_mermaid?.length > 0) {
            const totalInserted = data.data.md_mermaid.reduce((sum, m) => sum + (m.inserted || 0), 0);
            if (totalInserted > 0) {
              toastRef.current?.show(`结构化信息已插入：${totalInserted} 个图表`);
            }
          }
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      } finally {
        stopImportProgressPolling();
      }
    }
    stopImportProgressPolling();
    setImportProgress({ active: false });
    let msg = `导入完成：成功 ${successCount} 个文件夹，失败 ${failCount} 个`;
    if (preprocessedCount > 0) {
      msg += ` (${preprocessedCount} 个 Markdown 已预处理转换)`;
    }
    toastRef.current?.show(msg);
    unmarkKbPreprocessing(kbId);
    await fetchKBKnowledgeList(editingKB);
    await fetchKBStats(editingKB);
    refocusInput();
  };

  const importUrlToKB = async () => {
    if (!editingKB) return;
    setShowUrlInput(true);
    setUrlInputValue('');
  };

  const confirmImportUrl = async () => {
    if (!urlInputValue || !urlInputValue.trim()) {
      setShowUrlInput(false);
      return;
    }
    const urls = urlInputValue.trim().split(/[\n\r]+/).map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length === 0) {
      setShowUrlInput(false);
      return;
    }
    setShowUrlInput(false);
    let successCount = 0;
    let failCount = 0;
    for (const url of urls) {
      try {
        const response = await fetch('http://127.0.0.1:5002/api/v1/projects/sources/import-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_path: editingKB.path,
            source_file_path: url,
            source_type: 'url',
            enable_image_to_desc: preprocessorConfig?.processors?.image_to_desc?.enabled || false,
          })
        });
        const data = await response.json();
        if (data.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }
    toastRef.current?.show(`导入完成：成功 ${successCount} 个，失败 ${failCount} 个`);
    await fetchKBKnowledgeList(editingKB);
    await fetchKBStats(editingKB);
    refocusInput();
  };
  // ===== 搜索导入功能 =====
  const openSearchImport = () => {
    if (!editingKB) return;
    setSearchImportTargetKB(editingKB);
    setShowKBSettingsModal(false);
    setShowSearchImport(true);
    setSearchImportQuery('');
    setSearchImportResults([]);
    setSearchImportSelected(new Set());
  };

  // ===== 依赖工具版本检查 =====
  const checkToolVersionUpdates = async () => {
    setToolCheckLoading(true);
    setToolCheckResult(null);
    setToolCheckError('');
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('compare-tools-version-with-server');
      if (result.success) {
        setToolCheckResult(result.data);
      } else {
        setToolCheckError(result.message || '检查失败');
      }
    } catch (err) {
      setToolCheckError(`检查异常: ${err.message}`);
    } finally {
      setToolCheckLoading(false);
    }
  };

  // ===== 工具更新处理 =====
  const handleUpdateTool = async (tool) => {
    setUpdatingTools(prev => ({ ...prev, [tool.toolId]: true }));
    try {
      const { ipcRenderer } = window.require('electron');
      if (tool.toolId === 'llm-wiki') {
        const scpResult = await ipcRenderer.invoke('scp-llm-wiki-msi');
        if (!scpResult.success) {
          const dlResult = await ipcRenderer.invoke('download-llm-wiki-msi');
          if (dlResult.success) {
            await ipcRenderer.invoke('install-llm-wiki-msi', dlResult.path);
            alert('LLM Wiki 安装程序已启动，请按向导完成安装');
          } else {
            alert(`LLM Wiki 下载失败: ${dlResult.message}`);
          }
        } else {
          await ipcRenderer.invoke('install-llm-wiki-msi', scpResult.path);
          alert('LLM Wiki 安装程序已启动，请按向导完成安装');
        }
      } else if (tool.toolId === 'chrys') {
        const dlResult = await ipcRenderer.invoke('download-chrys');
        if (dlResult.success) {
          await ipcRenderer.invoke('install-chrys', dlResult.path);
          alert('Chrys 更新完成');
        } else {
          alert(`Chrys 下载失败: ${dlResult.message}`);
        }
      }
      await checkToolVersionUpdates();
    } catch (err) {
      alert(`更新失败: ${err.message}`);
    } finally {
      setUpdatingTools(prev => ({ ...prev, [tool.toolId]: false }));
    }
  };

  const doSearchImport = async () => {
    if (!searchImportQuery.trim()) return;
    setSearchImportLoading(true);
    setSearchImportResults([]);
    setSearchImportSelected(new Set());
    try {
      const data = await searchWeb(searchImportQuery.trim(), 20, true);
      if (data?.results) {
        setSearchImportResults(data.results);
      } else {
        setSearchImportResults([]);
      }
    } catch {
      setSearchImportResults([]);
    }
    setSearchImportLoading(false);
  };

  const toggleSearchImportItem = (idx) => {
    setSearchImportSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const toggleSearchImportAll = () => {
    if (searchImportSelected.size === searchImportResults.length) {
      setSearchImportSelected(new Set());
    } else {
      setSearchImportSelected(new Set(searchImportResults.map((_, i) => i)));
    }
  };

  const confirmSearchImport = async () => {
    if (searchImportSelected.size === 0) return;
    setSearchImportImporting(true);
    const selectedUrls = [...searchImportSelected].map(i => searchImportResults[i]).filter(r => r && r.url);
    let successCount = 0;
    let failCount = 0;
    const failDetails = [];
    for (const item of selectedUrls) {
      try {
        const response = await fetch(`${WIKI_BASE}/projects/sources/import-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_path: searchImportTargetKB?.path || editingKB?.path,
            source_file_path: item.url,
            source_type: 'url',
            fallback_title: item.title || '',
            fallback_content: item.snippet || '',
            enable_image_to_desc: preprocessorConfig?.processors?.image_to_desc?.enabled || false,
          })
        });
        const data = await response.json();
        if (data.success) {
          successCount++;
        } else {
          failCount++;
          failDetails.push(`${item.url}: ${data.message || '导入失败'}`);
        }
      } catch (error) {
        failCount++;
        failDetails.push(`${item.url}: ${error.message || '请求失败'}`);
      }
    }
    setSearchImportImporting(false);
    setShowSearchImport(false);
    const alertMsg = '搜索导入完成：成功 ' + successCount + ' 个，失败 ' + failCount + ' 个' + (failDetails.length ? '\n\n失败详情：\n' + failDetails.slice(0, 5).join('\n') : '');
    alert(alertMsg);
    const kbToRefresh = searchImportTargetKB || editingKB;
    if (kbToRefresh) {
      await fetchKBKnowledgeList(kbToRefresh);
      await fetchKBStats(kbToRefresh);
    }
  };
  // ===== 搜索导入功能结束 =====

  // 知识库复合键辅助函数：id::path，确保公共和个人知识库有唯一标识
  const getKbKey = (kb) => {
    const id = kb.id || kb.knowledge_base_id || '';
    const path = (kb.path || '').replace(/\\/g, '/').toLowerCase();
    return `${id}::${path}`;
  };

  // 获取已选知识库的显示名称
  const getSelectedKBNames = () => {
    return selectedKBIds.map(kbKey => {
      const kb = knowledgeBaseList.find(k => getKbKey(k) === kbKey);
      if (kb) {
        const kbId = kb.id || kb.knowledge_base_id;
        const meta = (kbMetadata || {})[kbId] || {};
        return meta.name || kb.name || kbId;
      }
      return kbKey.split('::')[0];
    }).join(', ');
  };

  // 检查当前活跃 KB 是否有进行中的任务
  const hasActiveKbTasks = () => {
    const activeKey = selectedKBIds.length > 0 ? selectedKBIds[selectedKBIds.length - 1] : '';
    if (!activeKey) return false;
    const activeKb = knowledgeBaseList.find(k => getKbKey(k) === activeKey);
    if (!activeKb) return false;
    const kbId = activeKb.id || activeKb.knowledge_base_id;
    const ingest = kbIngestStatus[kbId] || {};
    const rescanProg = kbRescanProgress[kbId] || {};
    return ingest.ingestProcessing || ingest.ingestPending ||
           ingest.deleteProcessing || ingest.deletePending ||
           rescanProg.status === 'running';
  };

  // 执行实际的知识库切换逻辑
  const doSelectKnowledgeBase = (kb, isDeselect) => {
    const key = getKbKey(kb);

    // 1. 中止所有进行中的 fetch 请求
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      console.log('[KnowledgeManagement] Aborted pending fetch requests for old KB');
    }

    // 2. 递增代际计数器，使旧 KB 的异步回调失效
    kbGenerationRef.current += 1;
    const currentGen = kbGenerationRef.current;
    console.log(`[KnowledgeManagement] KB generation incremented to ${currentGen}`);

    // 3. 暂停旧 KB 的后端队列（通知 Rust 后端中止 ingest/delete）
    const oldActiveKey = selectedKBIds.length > 0 ? selectedKBIds[selectedKBIds.length - 1] : '';
    if (oldActiveKey && oldActiveKey !== key) {
      const oldKb = knowledgeBaseList.find(k => getKbKey(k) === oldActiveKey);
      if (oldKb && oldKb.path) {
        fetch('http://127.0.0.1:5002/api/v1/projects/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: oldKb.path }),
        }).then(() => {
          console.log(`[KnowledgeManagement] Paused ingest queue for old KB: ${oldKb.path}`);
        }).catch(() => {});
      }
    }

    setSelectedKBIds(prev => {
      const newIds = prev.includes(key) ? prev.filter(i => i !== key) : [...prev, key];
      if (newIds.length > 0) {
        const activeKey = isDeselect ? newIds[newIds.length - 1] : key;
        const activeKb = isDeselect
          ? knowledgeBaseList.find(k => getKbKey(k) === activeKey)
          : kb;
        if (activeKb) {
          setProjectPath(activeKb.path || '');
        }
        writeMemoryFile({ 
          activeKnowledgeBase: { id: activeKey, path: (activeKb && activeKb.path) || '' },
          activeKnowledgeBases: newIds 
        });
        if (activeKb && activeKb.path) {
          const activeKbId = activeKb.id || activeKb.knowledge_base_id || '';
          console.log(`[KnowledgeManagement] Active KB switched: id=${activeKbId}, name=${activeKb.name || activeKbId}, path=${activeKb.path}`);
          fetch('http://127.0.0.1:5002/api/v1/projects/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: activeKb.path }),
          }).then(() => {
            console.log(`[KnowledgeManagement] Rust backend notified of active KB switch: ${activeKb.path}`);
          }).catch(e => {
            console.error(`[KnowledgeManagement] Failed to notify Rust backend of active KB switch: ${e.message}`);
          });
        }
      } else {
        setProjectPath('');
        writeMemoryFile({ activeKnowledgeBase: { id: '', path: '' }, activeKnowledgeBases: [] });
        // 清空活跃 KB 的树展示
        setActiveKbForTree(null);
        setKbKnowledgeList([]);
      }
      return newIds;
    });
  };

  // 选择知识库（带任务确认弹窗）
  const selectKnowledgeBase = (kb) => {
    const key = getKbKey(kb);
    const isDeselect = selectedKBIds.includes(key);

    // 切换活跃 KB 且当前有进行中任务时，弹出确认框
    if (!isDeselect && hasActiveKbTasks()) {
      setPendingSwitchKb({ kb, isDeselect: false });
      setShowSwitchConfirm(true);
      return;
    }

    // 取消选中不需要确认
    if (isDeselect && hasActiveKbTasks()) {
      setPendingSwitchKb({ kb, isDeselect: true });
      setShowSwitchConfirm(true);
      return;
    }

    doSelectKnowledgeBase(kb, isDeselect);
  };

  // 确认切换（用户点击确认弹窗"继续切换"）
  const handleConfirmSwitch = () => {
    setShowSwitchConfirm(false);
    if (pendingSwitchKb) {
      doSelectKnowledgeBase(pendingSwitchKb.kb, pendingSwitchKb.isDeselect);
      setPendingSwitchKb(null);
    }
  };

  // 取消切换
  const handleCancelSwitch = () => {
    setShowSwitchConfirm(false);
    setPendingSwitchKb(null);
  };

  // 递归收集某知识库的所有子代 kbKey
  const collectDescendantKeys = useCallback((kbKey) => {
    const result = [];
    const stack = [kbKey];
    while (stack.length > 0) {
      const current = stack.pop();
      const children = kbHierarchyRef.current[current] || [];
      for (const child of children) {
        result.push(child);
        stack.push(child);
      }
    }
    return result;
  }, []);

  // 批量选择/取消知识库及其所有子代（树状目录勾选时使用）
  const selectKBGroup = useCallback((kb, isDeselect) => {
    const parentKey = getKbKey(kb);
    const descendantKeys = collectDescendantKeys(parentKey);
    const allKeys = [parentKey, ...descendantKeys];

    // 如果是选中操作，需要所有后代对应的 kb 对象
    const descendantKbs = [];
    for (const dk of descendantKeys) {
      const dKb = knowledgeBaseList.find(k => getKbKey(k) === dk);
      if (dKb) descendantKbs.push(dKb);
    }

    setSelectedKBIds(prev => {
      let newIds = [...prev];
      if (isDeselect) {
        // 取消选中：移除所有
        newIds = newIds.filter(id => !allKeys.includes(id));
      } else {
        // 选中：添加所有尚未选中的
        for (const k of allKeys) {
          if (!newIds.includes(k)) newIds.push(k);
        }
      }

      // 找到新的活跃 KB
      if (newIds.length > 0) {
        const activeKey = newIds[newIds.length - 1];
        const activeKb = knowledgeBaseList.find(k => getKbKey(k) === activeKey);
        if (activeKb) setProjectPath(activeKb.path || '');
        writeMemoryFile({
          activeKnowledgeBase: { id: activeKey, path: (activeKb && activeKb.path) || '' },
          activeKnowledgeBases: newIds
        });
        if (activeKb && activeKb.path) {
          fetch('http://127.0.0.1:5002/api/v1/projects/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: activeKb.path }),
          }).catch(() => {});
        }
      } else {
        setProjectPath('');
        writeMemoryFile({ activeKnowledgeBase: { id: '', path: '' }, activeKnowledgeBases: [] });
        setActiveKbForTree(null);
        setKbKnowledgeList([]);
      }
      return newIds;
    });
  }, [knowledgeBaseList, getKbKey, collectDescendantKeys]);

  // 当 selectedKBIds 变化时，同步 activeKbForTree 并获取文件列表
  React.useEffect(() => {
    if (selectedKBIds.length === 0) {
      setActiveKbForTree(null);
      return;
    }
    const activeKey = selectedKBIds[selectedKBIds.length - 1];
    const activeKb = knowledgeBaseList.find(k => getKbKey(k) === activeKey);
    if (activeKb && activeKb.path) {
      setActiveKbForTree(activeKb);
      fetchKBKnowledgeList(activeKb);
    }
  }, [selectedKBIds, knowledgeBaseList]);

  React.useEffect(() => {
    if (!showImageModal) {
      refocusInput(50);
    }
  }, [showImageModal]);

  React.useEffect(() => {
    const handleClickOutside = (e) => {
      if (showDomainDropdown && !e.target.closest('.domain-dropdown-container')) {
        setShowDomainDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showDomainDropdown]);

  // 处理本地图片选择
  const handleLocalImage = (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImages([...images, { id: Date.now(), url: event.target.result, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
    setShowImageModal(false);
    e.target.value = '';
    refocusInput();
  };

  // 处理URL图片
  const handleUrlImage = () => {
    if (imageUrl.trim()) {
      setImages([...images, { id: Date.now(), url: imageUrl.trim(), name: 'URL图片' }]);
      setImageUrl('');
    }
    setShowImageModal(false);
    refocusInput();
  };

  // 删除图片
  const removeImage = (id) => {
    setImages(images.filter(img => img.id !== id));
  };

  return (
    <div className="h-full flex knowledge-container">
      {/* Toast 通知 */}
      {toast.show && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] px-5 py-2.5 rounded-lg text-sm font-medium text-white bg-gray-800 shadow-lg transition-all duration-300 animate-pulse">
          {toast.message}
        </div>
      )}
      {/* 导入/预处理实时进度卡片（长任务期间持续展示，避免误以为卡住） */}
      {importProgress.active && (() => {
        const STAGE_LABEL = {
          init: '初始化',
          mermaid_processing: '图片转为结构化信息',
          preprocess_starting: '准备预处理',
          preprocessing: '预处理转换',
          preprocess_done: '预处理完成',
          preprocess_skipped: '预处理跳过',
          plantuml_summarizing: '图表 LLM 总结',
          copying: '复制文件',
          folder_copying: '复制文件夹',
          finished: '导入完成',
          failed: '导入失败',
        };
        const p = importProgress;
        const isRunning = p.status === 'running';
        const isError = p.status === 'error';
        const mins = Math.floor((p.elapsedSeconds || 0) / 60);
        const secs = (p.elapsedSeconds || 0) % 60;
        const elapsedStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
        return (
          <div className={`fixed bottom-4 left-4 z-[9998] w-80 rounded-xl shadow-2xl border p-3.5 ${theme === 'dark' ? 'bg-gray-800 border-gray-600' : theme === 'light' ? 'bg-white border-gray-200' : 'bg-gray-700 border-gray-500'}`}>
            <div className="flex items-start gap-2.5">
              {isError ? (
                <X className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              ) : isRunning ? (
                <Loader2 className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5 animate-spin" />
              ) : (
                <Check className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-semibold ${theme === 'dark' ? 'text-gray-100' : theme === 'light' ? 'text-gray-800' : 'text-gray-100'}`}>
                    {STAGE_LABEL[p.stage] || p.stage || '处理中'}
                  </span>
                  <span className={`text-xs flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}`}>
                    已用 {elapsedStr}
                  </span>
                </div>
                {p.message && (
                  <p className={`text-xs mt-1 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-600' : 'text-gray-200'} ${isRunning ? 'animate-pulse' : ''}`}>
                    {p.message}
                  </p>
                )}
                {p.currentFile && (
                  <div className="flex items-center gap-1 mt-1.5">
                    <FileText className={`w-3 h-3 flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-400'}`} />
                    <span className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}`}>{p.currentFile}</span>
                  </div>
                )}
                {p.plantumlTotal > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className={theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}>图表总结进度</span>
                      <span className={theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-600' : 'text-gray-200'}>{p.plantumlDone}/{p.plantumlTotal}</span>
                    </div>
                    <div className={`w-full h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-gray-200' : 'bg-gray-600'}`}>
                      <div className="h-full bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${Math.max(2, (p.plantumlDone / p.plantumlTotal) * 100)}%` }} />
                    </div>
                  </div>
                )}
              </div>
              {isError && (
                <button
                  onClick={() => setImportProgress({ active: false })}
                  className={`p-0.5 rounded flex-shrink-0 ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400' : 'hover:bg-gray-600 text-gray-300'}`}
                  title="关闭"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        );
      })()}
      {/* PPT 浠诲姟鎭㈠寮圭獥 */}
      {showPptTaskModal && (
        <PptTaskRecoveryModal
          theme={theme}
          pptTasks={pptTasks}
          pptTasksLoading={pptTasksLoading}
          pipelineRunning={pipelineState?.running}
          onResume={resumePersistedPptTask}
          onClose={() => setShowPptTaskModal(false)}
        />
      )}
      {pptPreviewModal?.previews?.length > 0 && (
        <PptPreviewModal
          theme={theme}
          pptPreviewModal={pptPreviewModal}
          setPptPreviewModal={setPptPreviewModal}
          movePptPreviewModal={movePptPreviewModal}
          svgToPreviewSrc={svgToPreviewSrc}
        />
      )}
      {/* 图片选择弹窗 */}
      {showImageModal && (
        <ImagePickerModal
          theme={theme}
          imageUrl={imageUrl} setImageUrl={setImageUrl}
          fileInputRef={fileInputRef}
          onFileClick={() => fileInputRef.current?.click()}
          onUrlAdd={handleUrlImage}
          onClose={() => setShowImageModal(false)}
        />
      )}

      {/* 左侧：知识管理配置 */}
      {!collapsed && (
      <div className={`h-full flex flex-col border-r border-gray-700 transition-all duration-100`} style={{ width: `${leftWidth}%` }}>
        {/* Tabs */}
        <div className={`flex items-center gap-1 px-2 py-2 ${theme === 'dark' ? 'bg-gray-800 border-b border-gray-700' : theme === 'light' ? 'bg-white border-b border-gray-200' : 'bg-gray-600 border-b border-gray-500'}`}>
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`flex items-center gap-2 px-4 py-2 rounded-t-lg cursor-pointer transition-all ${
                activeTab === tab.id
                  ? `${theme === 'dark' ? 'bg-gray-700 text-white' : theme === 'light' ? 'bg-gray-100 text-gray-900' : 'bg-gray-500 text-white'}`
                  : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-300 hover:text-white'}`
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="text-sm">{tab.name}</span>
              <button onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} className="hover:text-red-400">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button onClick={addTab} className={`ml-auto p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-500 hover:text-white'}`}>
            <Plus className="w-5 h-5" />
          </button>
          
          {/* 设置按钮 */}
          <button 
            onClick={() => { setShowSettingsPanel(true); fetchProcessTree(); }}
            className={`ml-2 p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-500 hover:text-white'}`}
            title="设置"
          >
            <Settings className="w-5 h-5" />
          </button>
          {/* 耗时打点统计按钮 */}
          <button
            onClick={() => setShowPerfStats(true)}
            className={`ml-1 p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-500 hover:text-white'}`}
            title="系统诊断与监控"
          >
            <BarChart3 className="w-5 h-5" />
          </button>
        </div>

        <div className={`flex-1 overflow-auto p-4 ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-600'}`}>
          <div className={`space-y-5 ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
            {/* 平台卡片 */}
            <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
              <div className="flex flex-wrap gap-2">
                <label className={`flex-shrink-0 text-sm ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>知识源：</label>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={platforms.local}
                      onChange={() => handlePlatformChange('local')}
                      className="w-4 h-4 rounded accent-indigo-500"
                    />
                    <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>本地知识</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={platforms.hiDesk}
                      onChange={() => handlePlatformChange('hiDesk')}
                      className="w-4 h-4 rounded accent-indigo-500"
                    />
                    <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>HiDesk</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={platforms.haiwen}
                      onChange={() => handlePlatformChange('haiwen')}
                      className="w-4 h-4 rounded accent-indigo-500"
                    />
                    <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>海问思答</span>
                    {platforms.haiwen && haiwenAuthenticated && (
                      <span className={`text-xs ${theme === 'dark' ? 'text-green-400' : 'text-green-500'}`}>已登录</span>
                    )}
                    {platforms.haiwen && !haiwenAuthenticated && (
                      <button
                        onClick={(e) => { e.stopPropagation(); autologinHaiwen(); }}
                        className={`text-xs px-1.5 py-0.5 rounded ${theme === 'dark' ? 'bg-yellow-600/30 text-yellow-300 hover:bg-yellow-600/50' : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'}`}
                      >
                        登录
                      </button>
                    )}
                  </label>
                  <label className={`flex items-center gap-2 ${webSearchChecking ? 'cursor-wait opacity-70' : webSearchAvailable === false ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={platforms.webSearch}
                      onChange={() => handlePlatformChange('webSearch')}
                      disabled={webSearchAvailable === false || webSearchChecking}
                      className="w-4 h-4 rounded accent-green-500"
                    />
                    <Globe className={`w-4 h-4 ${platforms.webSearch ? (theme === 'dark' ? 'text-green-400' : 'text-green-500') : (theme === 'dark' ? 'text-gray-400' : 'text-gray-500')}`} />
                    <span className={`text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>联网搜索</span>
                    {webSearchChecking && <span className={`text-xs ${theme === 'dark' ? 'text-yellow-400' : 'text-yellow-600'}`}>检测中...</span>}
                    {platforms.webSearch && !webSearchChecking && (
                      <span className={`text-xs ${theme === 'dark' ? 'text-green-400' : 'text-green-500'}`}>
                        {searchEngine === 'bing' ? 'Bing' : searchEngine === 'searxng' ? 'SearXNG' : 'DuckDuckGo'}
                      </span>
                    )}
                    {webSearchAvailable === false && !webSearchChecking && <span className={`text-xs ${theme === 'dark' ? 'text-red-400' : 'text-red-500'}`}>不可用</span>}
                  </label>
                </div>
              </div>
            </div>

            {(platforms.hiDesk || platforms.local || platforms.haiwen) && (
            <>
              {/* Tab 翻页按钮：多个平台都启用时显示 */}
              {[platforms.local, platforms.hiDesk, platforms.haiwen].filter(Boolean).length >= 2 && (
                <div className={`flex rounded-lg p-1 mb-3 ${theme === 'dark' ? 'bg-gray-600/50' : theme === 'light' ? 'bg-gray-200' : 'bg-gray-500/50'}`}>
                  {platforms.local && (
                    <button
                      onClick={() => setPlatformTab('local')}
                      className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-all ${
                        platformTab === 'local'
                          ? (theme === 'dark' ? 'bg-indigo-600 text-white shadow-sm' : theme === 'light' ? 'bg-indigo-500 text-white shadow-sm' : 'bg-indigo-600 text-white shadow-sm')
                          : (theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-500 hover:text-gray-900' : 'text-gray-400 hover:text-white')
                      }`}
                    >
                      本地知识
                    </button>
                  )}
                  {platforms.hiDesk && (
                    <button
                      onClick={() => setPlatformTab('hiDesk')}
                      className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-all ${
                        platformTab === 'hiDesk'
                          ? (theme === 'dark' ? 'bg-indigo-600 text-white shadow-sm' : theme === 'light' ? 'bg-indigo-500 text-white shadow-sm' : 'bg-indigo-600 text-white shadow-sm')
                          : (theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-500 hover:text-gray-900' : 'text-gray-400 hover:text-white')
                      }`}
                    >
                      HiDesk
                    </button>
                  )}
                  {platforms.haiwen && (
                    <button
                      onClick={() => setPlatformTab('haiwen')}
                      className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-all ${
                        platformTab === 'haiwen'
                          ? (theme === 'dark' ? 'bg-indigo-600 text-white shadow-sm' : theme === 'light' ? 'bg-indigo-500 text-white shadow-sm' : 'bg-indigo-600 text-white shadow-sm')
                          : (theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-500 hover:text-gray-900' : 'text-gray-400 hover:text-white')
                      }`}
                    >
                      海问思答
                    </button>
                  )}
                </div>
              )}

              {/* 海问思答平台内容 */}
              {(platformTab === 'haiwen' || (platforms.haiwen && !platforms.hiDesk && !platforms.local)) && (
              <>
              <div className={`p-4 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
                <div className="flex items-center justify-between mb-3">
                  <label className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>海问思答</label>
                  <div className="flex items-center gap-2">
                    {haiwenAuthenticated ? (
                      <>
                        <span className={`text-xs ${theme === 'dark' ? 'text-green-400' : 'text-green-500'}`}>已登录</span>
                        <button
                          onClick={handleHaiwenLogout}
                          className={`px-2 py-1 text-xs rounded-lg transition-all ${
                            theme === 'dark' ? 'bg-red-600/30 hover:bg-red-600/50 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-600'
                          }`}
                        >
                          退出登录
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => autologinHaiwen()}
                        className={`px-2 py-1 text-xs rounded-lg transition-all ${
                          theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        }`}
                      >
                        登录
                      </button>
                    )}
                  </div>
                </div>
                <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                  基于华为海问思答平台的企业级知识检索
                </p>
              </div>
              </>
              )}

              {(platformTab === 'hiDesk' || (platforms.hiDesk && !platforms.local && !platforms.haiwen)) && (
              <HiDeskPanel
              theme={theme}
              refreshHiDeskConnection={refreshHiDeskConnection} hiDeskRefreshing={hiDeskRefreshing} hiDeskTestResult={hiDeskTestResult}
              hiDeskConfigured={hiDeskConfigured}
              hiDeskDomains={hiDeskDomains} hiDeskSelectedDomain={hiDeskSelectedDomain} handleHiDeskDomainChange={handleHiDeskDomainChange}
              hiDeskDatasets={hiDeskDatasets} hiDeskSelectedDataset={hiDeskSelectedDataset} setHiDeskSelectedDataset={setHiDeskSelectedDataset}
              hiDeskViews={hiDeskViews} hiDeskSelectedView={hiDeskSelectedView} handleHiDeskViewChange={handleHiDeskViewChange}
            />)}

            {(platformTab === 'local' || (platforms.local && !platforms.hiDesk && !platforms.haiwen)) && (
              <>
              <div className={`p-5 rounded-xl ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
                <div className="flex gap-3">
                  <div ref={treePanelRef} style={{ width: treePanelWidth }} className="flex-shrink-0 overflow-hidden">
                    <KnowledgeBaseTreePanel
                      theme={theme}
                      publicKbList={knowledgeBaseList.filter(kb => isCommonKb(kb))}
                      personalKbList={knowledgeBaseList.filter(kb => !isCommonKb(kb) && !isCommonKbParentDir(kb))}
                      kbMetadata={kbMetadata}
                      kbStats={kbStats}
                      kbListLoading={kbListLoading}
                      selectedKBIds={selectedKBIds}
                      activeKBKey={selectedKBIds.length > 0 ? selectedKBIds[selectedKBIds.length - 1] : ''}
                      kbHierarchy={kbHierarchy}
                      onUpdateHierarchy={updateKbHierarchy}
                      getKbKey={getKbKey}
                      getKBStatus={getKBStatus}
                      onSelectKB={selectKnowledgeBase}
                      onSelectKBGroup={selectKBGroup}
                      onOpenSettings={openKBSettings}
                      onRescanKB={handleKbRescan}
                    />
                  </div>
                  <div
                    className={`w-1 cursor-col-resize flex-shrink-0 rounded-full transition-colors ${
                      theme === 'dark' ? 'bg-gray-600 hover:bg-indigo-500' : theme === 'light' ? 'bg-gray-300 hover:bg-indigo-400' : 'bg-gray-500 hover:bg-indigo-400'
                    }`}
                    onMouseDown={handleTreeResizeStart}
                  />
                  <div className="flex-1 min-w-0">
                    {/* 公共知识库 */}
                    <div className="mb-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                        公共
                      </span>
                      <button
                        onClick={() => setShowPreprocessorSettingsModal(true)}
                        className={`p-1.5 rounded-lg transition-all ${
                          theme === 'dark'
                            ? 'hover:bg-gray-600 text-gray-400 hover:text-gray-200'
                            : theme === 'light'
                              ? 'hover:bg-gray-200 text-gray-400 hover:text-gray-600'
                              : 'hover:bg-gray-500 text-gray-400 hover:text-gray-200'
                        }`}
                        title="预处理设置"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowCommonKbConfig(!showCommonKbConfig)}
                        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-all ${
                          theme === 'dark'
                            ? 'bg-cyan-600 hover:bg-cyan-700 text-white'
                            : theme === 'light'
                              ? 'bg-cyan-500 hover:bg-cyan-600 text-white'
                              : 'bg-cyan-600 hover:bg-cyan-700 text-white'
                        }`}
                      >
                        <Download className="w-4 h-4" />
                        拉取知识库
                      </button>
                      <button
                        onClick={checkCommonKbLocal}
                        disabled={commonKbCheckingLocal}
                        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm transition-all ${
                          theme === 'dark'
                            ? 'bg-gray-600 hover:bg-gray-500 text-gray-300 disabled:opacity-50'
                            : theme === 'light'
                              ? 'bg-gray-200 hover:bg-gray-300 text-gray-600 disabled:opacity-50'
                              : 'bg-gray-500 hover:bg-gray-400 text-gray-300 disabled:opacity-50'
                        }`}
                        title="刷新知识库列表"
                      >
                        {commonKbCheckingLocal ? (
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* 拉取知识库配置区域 */}
                  {showCommonKbConfig && (
                    <div className={`p-3 rounded-lg mb-3 ${theme === 'dark' ? 'bg-gray-600/50' : theme === 'light' ? 'bg-gray-100' : 'bg-gray-500/50'}`}>
                      {/* 服务器选择 */}
                      <div className="mb-2">
                        <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>选择服务器</label>
                        <div className="flex gap-1">
                          <select
                            value={commonKbActiveServer}
                            onChange={(e) => switchCommonKbServer(e.target.value)}
                            className={`flex-1 px-2 py-1 text-xs rounded border ${
                              theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                            }`}
                          >
                            {commonKbServerList.map(s => (
                              <option key={s.name} value={s.name}>{s.name} ({s.host})</option>
                            ))}
                          </select>
                          <button
                            onClick={() => {
                              setShowAddServerForm(!showAddServerForm);
                              if (!showAddServerForm) {
                                setNewServerName('');
                                setNewServerConfig({ host: '', port: 22, username: 'root', password: '', remotePath: '/home/Knowledge_Management/common', localPath: 'D:\\Knowledge_Management\\common' });
                              }
                            }}
                            title="新增服务器"
                            className={`px-2 py-1 text-xs rounded transition-all ${
                              showAddServerForm
                                ? (theme === 'dark' ? 'bg-gray-600 text-gray-300' : theme === 'light' ? 'bg-gray-300 text-gray-700' : 'bg-gray-500 text-gray-300')
                                : (theme === 'dark' ? 'bg-green-700 hover:bg-green-600 text-white' : theme === 'light' ? 'bg-green-500 hover:bg-green-600 text-white' : 'bg-green-600 hover:bg-green-500 text-white')
                            }`}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          {commonKbActiveServer && (
                            <button
                              onClick={() => deleteCommonKbServer(commonKbActiveServer)}
                              title="删除当前服务器"
                              className={`px-2 py-1 text-xs rounded transition-all ${
                                theme === 'dark' ? 'bg-red-700 hover:bg-red-600 text-white' : theme === 'light' ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-red-600 hover:bg-red-500 text-white'
                              }`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 新增服务器表单 */}
                      {showAddServerForm && (
                        <div className={`mb-2 p-2 rounded border ${theme === 'dark' ? 'border-green-700 bg-gray-700/50' : theme === 'light' ? 'border-green-300 bg-green-50' : 'border-green-600 bg-gray-600/50'}`}>
                          <div className="mb-2">
                            <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>服务器名称 *</label>
                            <input
                              type="text"
                              value={newServerName}
                              onChange={(e) => setNewServerName(e.target.value)}
                              placeholder="例: My_Server"
                              className={`w-full px-2 py-1 text-xs rounded border ${
                                theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                              }`}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div>
                              <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>服务器 IP</label>
                              <input
                                type="text"
                                value={newServerConfig.host}
                                onChange={(e) => setNewServerConfig(prev => ({ ...prev, host: e.target.value }))}
                                placeholder="例: 192.168.1.100"
                                className={`w-full px-2 py-1 text-xs rounded border ${
                                  theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                                }`}
                              />
                            </div>
                            <div>
                              <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>端口</label>
                              <input
                                type="number"
                                value={newServerConfig.port}
                                onChange={(e) => setNewServerConfig(prev => ({ ...prev, port: parseInt(e.target.value) || 22 }))}
                                className={`w-full px-2 py-1 text-xs rounded border ${
                                  theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                                }`}
                              />
                            </div>
                            <div>
                              <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>用户名</label>
                              <input
                                type="text"
                                value={newServerConfig.username}
                                onChange={(e) => setNewServerConfig(prev => ({ ...prev, username: e.target.value }))}
                                className={`w-full px-2 py-1 text-xs rounded border ${
                                  theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                                }`}
                              />
                            </div>
                            <div>
                              <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>密码</label>
                              <input
                                type="password"
                                value={newServerConfig.password}
                                onChange={(e) => setNewServerConfig(prev => ({ ...prev, password: e.target.value }))}
                                className={`w-full px-2 py-1 text-xs rounded border ${
                                  theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                                }`}
                              />
                            </div>
                          </div>
                          <div className="mb-2">
                            <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>远程路径</label>
                            <input
                              type="text"
                              value={newServerConfig.remotePath}
                              onChange={(e) => setNewServerConfig(prev => ({ ...prev, remotePath: e.target.value }))}
                              className={`w-full px-2 py-1 text-xs rounded border ${
                                theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                              }`}
                            />
                          </div>
                          <div className="mb-2">
                            <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>本地存放路径</label>
                            <input
                              type="text"
                              value={newServerConfig.localPath}
                              onChange={(e) => setNewServerConfig(prev => ({ ...prev, localPath: e.target.value }))}
                              className={`w-full px-2 py-1 text-xs rounded border ${
                                theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                              }`}
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={addCommonKbServer}
                              className={`flex-1 px-3 py-1.5 rounded text-xs transition-all ${
                                theme === 'dark' ? 'bg-green-700 hover:bg-green-600 text-white' : theme === 'light' ? 'bg-green-500 hover:bg-green-600 text-white' : 'bg-green-600 hover:bg-green-500 text-white'
                              }`}
                            >
                              确认添加
                            </button>
                            <button
                              onClick={() => setShowAddServerForm(false)}
                              className={`px-3 py-1.5 rounded text-xs transition-all ${
                                theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : theme === 'light' ? 'bg-gray-300 hover:bg-gray-400 text-gray-700' : 'bg-gray-500 hover:bg-gray-400 text-gray-300'
                              }`}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <div>
                          <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>服务器 IP</label>
                          <input
                            type="text"
                            value={commonKbConfig.host}
                            onChange={(e) => setCommonKbConfig(prev => ({ ...prev, host: e.target.value }))}
                            placeholder="例: 192.168.1.100"
                            className={`w-full px-2 py-1 text-xs rounded border ${
                              theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                            }`}
                          />
                        </div>
                        <div>
                          <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>端口</label>
                          <input
                            type="number"
                            value={commonKbConfig.port}
                            onChange={(e) => setCommonKbConfig(prev => ({ ...prev, port: parseInt(e.target.value) || 22 }))}
                            className={`w-full px-2 py-1 text-xs rounded border ${
                              theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                            }`}
                          />
                        </div>
                        <div>
                          <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>用户名</label>
                          <input
                            type="text"
                            value={commonKbConfig.username}
                            onChange={(e) => setCommonKbConfig(prev => ({ ...prev, username: e.target.value }))}
                            className={`w-full px-2 py-1 text-xs rounded border ${
                              theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                            }`}
                          />
                        </div>
                        <div>
                          <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>密码</label>
                          <input
                            type="password"
                            value={commonKbConfig.password}
                            onChange={(e) => setCommonKbConfig(prev => ({ ...prev, password: e.target.value }))}
                            className={`w-full px-2 py-1 text-xs rounded border ${
                              theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                            }`}
                          />
                        </div>
                      </div>
                      <div className="mb-2">
                        <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>远程路径</label>
                        <input
                          type="text"
                          value={commonKbConfig.remotePath}
                          onChange={(e) => setCommonKbConfig(prev => ({ ...prev, remotePath: e.target.value }))}
                          className={`w-full px-2 py-1 text-xs rounded border ${
                            theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                          }`}
                        />
                      </div>
                      <div className="mb-2">
                        <label className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>本地存放路径</label>
                        <input
                          type="text"
                          value={commonKbConfig.localPath}
                          onChange={(e) => setCommonKbConfig(prev => ({ ...prev, localPath: e.target.value }))}
                          className={`w-full px-2 py-1 text-xs rounded border ${
                            theme === 'dark' ? 'bg-gray-700 border-gray-500 text-white' : theme === 'light' ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-600 border-gray-400 text-white'
                          }`}
                        />
                      </div>
                      <button
                        onClick={saveCommonKbConfig}
                        className={`w-full px-3 py-1.5 rounded text-xs transition-all ${
                          theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                        }`}
                      >
                        保存配置
                      </button>

                      {/* 操作按钮 */}
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={checkCommonKbLocal}
                          disabled={commonKbCheckingLocal || commonKbSyncing}
                          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs transition-all ${
                            theme === 'dark'
                              ? 'bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-50'
                              : theme === 'light'
                                ? 'bg-cyan-500 hover:bg-cyan-600 text-white disabled:opacity-50'
                                : 'bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50'
                          }`}
                        >
                          {commonKbCheckingLocal ? (
                            <><div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" /> 检测中</>
                          ) : (
                            <><Search className="w-3 h-3" /> 检测本地</>
                          )}
                        </button>
                        <button
                          onClick={checkCommonKbServer}
                          disabled={commonKbCheckingServer || commonKbSyncing}
                          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs transition-all ${
                            theme === 'dark'
                              ? 'bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50'
                              : theme === 'light'
                                ? 'bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50'
                                : 'bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50'
                          }`}
                        >
                          {commonKbCheckingServer ? (
                            <><div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" /> 检测中</>
                          ) : (
                            <><Globe className="w-3 h-3" /> 检测服务器</>
                          )}
                        </button>
                      </div>

                      <button
                        onClick={syncCommonKb}
                        disabled={commonKbSyncing}
                        className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all mt-2 ${
                          theme === 'dark'
                            ? 'bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50'
                            : theme === 'light'
                              ? 'bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50'
                              : 'bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50'
                        }`}
                      >
                        {commonKbSyncing ? (
                          <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> 同步中...</>
                        ) : (
                          <><Download className="w-4 h-4" /> 同步公共知识库</>
                        )}
                      </button>

                      {/* 状态提示 */}
                      {commonKbStatus && (
                        <div className={`mt-3 p-2 rounded-lg text-xs ${
                          commonKbStatus.type === 'success'
                            ? (theme === 'dark' ? 'bg-green-900/30 text-green-400' : 'bg-green-50 text-green-600')
                            : commonKbStatus.type === 'error'
                              ? (theme === 'dark' ? 'bg-red-900/30 text-red-400' : 'bg-red-50 text-red-600')
                              : (theme === 'dark' ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-50 text-blue-600')
                        }`}>
                          {commonKbStatus.message}
                        </div>
                      )}

                      {/* 状态指示器 */}
                      <div className="flex gap-4 mt-2 text-xs">
                        <span className={`flex items-center gap-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}`}>
                          <span className={`w-2 h-2 rounded-full ${
                            commonKbLocalExists === true ? 'bg-green-500' : commonKbLocalExists === false ? 'bg-red-500' : 'bg-gray-500'
                          }`} />
                          本地
                        </span>
                        <span className={`flex items-center gap-1 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-300'}`}>
                          <span className={`w-2 h-2 rounded-full ${
                            commonKbServerReachable === true ? 'bg-green-500' : commonKbServerReachable === false ? 'bg-red-500' : 'bg-gray-500'
                          }`} />
                          服务器
                        </span>
                      </div>
                    </div>
                  )}

                      {/* 公共知识库卡片 */}
                      {(() => {
                        const publicList = knowledgeBaseList.filter(kb => isCommonKb(kb));
                        return publicList.length === 0 ? (
                          <div className={`text-center py-4 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                            {kbListLoading ? (
                              <>
                                <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-1"></div>
                                <p className="text-xs">正在连接知识库服务...</p>
                              </>
                            ) : (
                              <>
                                <Database className="w-8 h-8 mx-auto mb-1 opacity-50" />
                                <p className="text-xs">暂无公共知识库，请拉取</p>
                              </>
                            )}
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-3">
                            {publicList.map((kb) => (
                              <KbCard key={getKbKey(kb)} kb={kb} theme={theme} isCommonKb={true} isSelected={selectedKBIds.includes(getKbKey(kb))} activeKBKey={selectedKBIds.length > 0 ? selectedKBIds[selectedKBIds.length - 1] : ''} kbMetadata={kbMetadata} kbStats={kbStats} kbIngestStatus={kbIngestStatus} getKbKey={getKbKey} getKBStatus={getKBStatus} openKBSettings={openKBSettings} selectKnowledgeBase={selectKnowledgeBase} handleRescanKb={handleKbRescan} kbRescanProgress={kbRescanProgress} />
                            ))}
                          </div>
                        );
                      })()}

                      {/* 个人知识库 */}
                      <div className="border-t border-gray-600 pt-4 mt-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                            个人
                          </span>
                          <button
                            onClick={() => setShowPreprocessorSettingsModal(true)}
                            className={`p-1.5 rounded-lg transition-all ${
                              theme === 'dark'
                                ? 'hover:bg-gray-600 text-gray-400 hover:text-gray-200'
                                : theme === 'light'
                                  ? 'hover:bg-gray-200 text-gray-400 hover:text-gray-600'
                                  : 'hover:bg-gray-500 text-gray-400 hover:text-gray-200'
                            }`}
                            title="预处理设置"
                          >
                            <Settings className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setShowCreateKBModal(true); setNewKBName(''); if (lastKbDir) setNewKBPath(lastKbDir); }}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-all ${
                              theme === 'dark'
                                ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                                : theme === 'light'
                                  ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                            }`}
                          >
                            <Plus className="w-4 h-4" />
                            创建知识库
                          </button>
                          <button
                            onClick={handleRegisterExistingKB}
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm transition-all ${
                              theme === 'dark'
                                ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                                : theme === 'light'
                                  ? 'bg-gray-200 hover:bg-gray-300 text-gray-600'
                                  : 'bg-gray-500 hover:bg-gray-400 text-gray-300'
                            }`}
                            title="注册已存在的知识库目录"
                          >
                            <FolderOpen className="w-4 h-4" />
                          </button>
                          <button
                            onClick={handleRefreshPersonalKB}
                            disabled={tasks.some(t => t.name === '刷新个人知识库' && t.status === 'running')}
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm transition-all ${
                              theme === 'dark'
                                ? 'bg-gray-600 hover:bg-gray-500 text-gray-300 disabled:opacity-50'
                                : theme === 'light'
                                  ? 'bg-gray-200 hover:bg-gray-300 text-gray-600 disabled:opacity-50'
                                  : 'bg-gray-500 hover:bg-gray-400 text-gray-300 disabled:opacity-50'
                            }`}
                            title="刷新知识库列表并重新索引"
                          >
                            {tasks.some(t => t.name === '刷新个人知识库' && t.status === 'running') ? (
                              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <RefreshCw className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>
                      
                      {knowledgeBaseList.length === 0 ? (
                        <div className={`text-center py-8 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                          {kbListLoading ? (
                            <>
                              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                              {(() => {
                                const llmTask = tasks.find(t => t.status === 'running' && (t.name.includes('KMA') || t.name.includes('Wiki')));
                                if (llmTask && llmTask.message) {
                                  return <p className="text-sm">{llmTask.message}</p>;
                                }
                                if (llmTask) {
                                  return <p className="text-sm">{llmTask.name}中...</p>;
                                }
                                return <p className="text-sm">正在连接知识库服务...</p>;
                              })()}
                            </>
                          ) : (
                            <>
                              <Database className="w-12 h-12 mx-auto mb-2 opacity-50" />
                              <p className="text-sm">暂无知识库，请创建</p>
                            </>
                          )}
                        </div>
                      ) : (
                        <div>
                          {(() => {
                            const personalList = knowledgeBaseList.filter(kb => !isCommonKb(kb) && !isCommonKbParentDir(kb));
                            return personalList.length === 0 ? (
                              <div className={`text-center py-4 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                                <Database className="w-8 h-8 mx-auto mb-1 opacity-50" />
                                <p className="text-xs">暂无个人知识库，请创建</p>
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 gap-3">
                                {personalList.map((kb) => (
                                  <KbCard key={getKbKey(kb)} kb={kb} theme={theme} isCommonKb={false} isSelected={selectedKBIds.includes(getKbKey(kb))} activeKBKey={selectedKBIds.length > 0 ? selectedKBIds[selectedKBIds.length - 1] : ''} kbMetadata={kbMetadata} kbStats={kbStats} kbIngestStatus={kbIngestStatus} getKbKey={getKbKey} getKBStatus={getKBStatus} openKBSettings={openKBSettings} selectKnowledgeBase={selectKnowledgeBase} handleRescanKb={handleKbRescan} kbRescanProgress={kbRescanProgress} />
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

              {/* 摄入与删除状态监控 — 独立卡片，与知识库列表分离 */}
              <div className={`p-5 rounded-xl mt-4 ${theme === 'dark' ? 'bg-gray-700/50' : theme === 'light' ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-500/50'}`}>
                <IngestMonitor projectPath={projectPath} theme={theme} />
              </div>
            </>
            )}

            </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif"
              onChange={handleLocalImage}
              className="hidden"
            />
          </div>
        </div>
      </div>
      )}

      {/* 折叠/展开按钮 + 可拖动分隔条 */}
      <div className="relative flex flex-col items-center flex-shrink-0">
        {!collapsed ? (
          <div 
            className={`w-1 h-full cursor-col-resize flex items-center justify-center transition-colors ${
              isDragging 
                ? `${theme === 'dark' ? 'bg-indigo-500' : theme === 'light' ? 'bg-indigo-400' : 'bg-indigo-500'}` 
                : `${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500' : theme === 'light' ? 'bg-gray-300 hover:bg-gray-400' : 'bg-gray-400 hover:bg-gray-300'}`
            }`}
            onMouseDown={() => setIsDragging(true)}
          >
            <div className={`w-0.5 h-8 rounded-full ${theme === 'dark' ? 'bg-gray-400' : theme === 'light' ? 'bg-gray-500' : 'bg-gray-300'}`} />
          </div>
        ) : (
          <button
            onClick={() => setCollapsed(false)}
            className={`absolute left-0 top-1/2 -translate-y-1/2 w-5 h-12 flex items-center justify-center cursor-pointer rounded-r-md transition-colors z-10 ${
              theme === 'dark' ? 'bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600' : theme === 'light' ? 'bg-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-300' : 'bg-gray-500 text-gray-300 hover:text-white hover:bg-gray-400'
            }`}
            title="展开侧边栏"
          >
            <ChevronRight className="w-3 h-3" />
          </button>
        )}
        
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className={`absolute right-full top-1/2 -translate-y-1/2 w-5 h-12 flex items-center justify-center cursor-pointer rounded-l-md transition-colors ${
              theme === 'dark' ? 'bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600' : theme === 'light' ? 'bg-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-300' : 'bg-gray-500 text-gray-300 hover:text-white hover:bg-gray-400'
            }`}
            title="收起侧边栏"
          >
            <ChevronLeft className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* 中间：AI对话区 */}
      <div className={`h-full flex flex-col transition-all duration-100`} style={{ width: collapsed ? `${100 - rightWidth}%` : `${100 - leftWidth - rightWidth}%` }}>
        {/* AI对话头部 */}
        <div className={`flex items-center gap-3 px-4 py-3 ${theme === 'dark' ? 'bg-gray-800 border-b border-gray-700' : theme === 'light' ? 'bg-white border-b border-gray-200' : 'bg-gray-600 border-b border-gray-500'}`}>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${theme === 'dark' ? 'bg-indigo-600' : theme === 'light' ? 'bg-indigo-500' : 'bg-indigo-600'}`}>
            <MessageSquare className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className={`text-sm font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>AI 助手</h2>
            <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>智能对话助手，支持多轮对话</p>
          </div>
        </div>

        {/* PPT 六步流水线状态面板 */}
        {targetFileType === 'slides' && pipelineState && <PptPipelineStatusBar pipelineState={pipelineState} theme={theme} pipelineDetailsOpen={pipelineDetailsOpen} setPipelineDetailsOpen={setPipelineDetailsOpen} pipelineAbortRef={pipelineAbortRef} setPipelineState={setPipelineState} openPptPreviewModal={openPptPreviewModal} svgToPreviewSrc={svgToPreviewSrc} />}

        {/* AI对话内容区域 */}
        <div className={`flex-1 overflow-auto p-4 ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
          <div className="w-full space-y-4 px-6">
            {messages.map((msg, idx) => {
              // ppt_review 卡片：全宽渲染，不走普通气泡
              if (msg.kind === 'ppt_review') {
                return (
                  <div key={idx} className="flex justify-start">
                    <div className="w-full min-w-0">
                      {renderPptReviewCard(msg)}
                    </div>
                  </div>
                );
              }
              return (
              <div key={idx} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`flex items-start gap-3 ${msg.type === 'user' ? 'max-w-[60%]' : 'max-w-[70%]'}`}>
                  {msg.type === 'assistant' && (
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${theme === 'dark' ? 'bg-indigo-600' : theme === 'light' ? 'bg-indigo-500' : 'bg-indigo-600'}`}>
                      <Bot className="w-4 h-4 text-white" />
                    </div>
                  )}
                  <div className={`min-w-0 px-4 py-3 break-words ${msg.type === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
                    {msg.type === 'assistant' && renderMode === 'markdown' ? (
                      <div
                        className={`markdown-body text-sm ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                      />
                    ) : (
                      <p className={`text-sm ${msg.type === 'user' ? 'text-white' : theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                        {msg.content}
                      </p>
                    )}
                    {/* 来源引用展示 */}
                    {msg.type === 'assistant' && (
                      <>
                        {/* 平台标签 */}
                        {msg.platformsUsed && msg.platformsUsed.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {msg.platformsUsed.map((p, i) => (
                              <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${
                                p === 'local' ? (theme === 'dark' ? 'bg-indigo-900/50 text-indigo-300' : 'bg-indigo-100 text-indigo-700') :
                                p === 'web' ? (theme === 'dark' ? 'bg-green-900/50 text-green-300' : 'bg-green-100 text-green-700') :
                                p === 'hiDesk' ? (theme === 'dark' ? 'bg-orange-900/50 text-orange-300' : 'bg-orange-100 text-orange-700') :
                                p === 'haiwen' ? (theme === 'dark' ? 'bg-cyan-900/50 text-cyan-300' : 'bg-cyan-100 text-cyan-700') :
                                (theme === 'dark' ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600')
                              }`}>
                                {p === 'local' ? '本地知识库' : p === 'web' ? '联网搜索' : p === 'hiDesk' ? 'HiDesk' : p === 'haiwen' ? '海问思答' : p}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* 来源详情 */}
                        {msg.sources && msg.sources.length > 0 && (() => {
                            // 按平台统计命中文件数
                            const platformStats = {};
                            msg.sources.forEach(src => {
                              const platform = typeof src === 'string' ? 'local' : (src.platform || 'local');
                              platformStats[platform] = (platformStats[platform] || 0) + 1;
                            });
                            const platformLabels = { local: '本地知识库', web: '联网搜索', haiwen: '海问思答', hiDesk: 'HiDesk' };
                            const statsText = Object.entries(platformStats)
                              .map(([k, v]) => `${platformLabels[k] || k}: ${v}`)
                              .join(', ');
                            return (
                          <details className="mt-2">
                            <summary className={`text-xs cursor-pointer font-medium ${theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : theme === 'light' ? 'text-gray-500 hover:text-gray-700' : 'text-gray-400 hover:text-gray-300'}`}>
                              参考来源 ({msg.sources.length} 个文件{statsText ? `, ${statsText}` : ''})
                            </summary>
                            <ul className="mt-1 ml-2 text-xs space-y-1 list-none">
                              {msg.sources.slice(0, 20).map((src, i) => {
                                // 兼容两种格式：字符串（旧 chat 接口返回的路径）和对象（统一搜索接口返回）
                                const isString = typeof src === 'string';
                                const sourceObj = isString
                                  ? { index: i + 1, platform: 'local', title: src, url: '' }
                                  : src;
                                const isHttp = sourceObj.url && sourceObj.url.startsWith('http');
                                const displayTitle = sourceObj.title || sourceObj.url || '(无标题)';
                                return (
                                <li key={i} className="flex items-start gap-1.5">
                                  <span className={`flex-shrink-0 w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold ${
                                    sourceObj.platform === 'local' ? 'bg-indigo-500/20 text-indigo-400' :
                                    sourceObj.platform === 'web' ? 'bg-green-500/20 text-green-400' :
                                    'bg-gray-500/20 text-gray-400'
                                  }`}>
                                    {sourceObj.index}
                                  </span>
                                  {isHttp ? (
                                    <a
                                      href={sourceObj.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={`truncate hover:underline ${theme === 'dark' ? 'text-green-400' : 'text-green-600'}`}
                                      title={sourceObj.url}
                                    >
                                      {displayTitle}
                                    </a>
                                  ) : (
                                    <button
                                      className={`truncate text-left hover:underline cursor-pointer bg-transparent border-none p-0 ${theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}`}
                                      title={displayTitle}
                                      onClick={async () => {
                                        if (!sourceObj._fullPath) return;
                                        const { ipcRenderer } = window.require('electron');
                                        await ipcRenderer.invoke('open-file-path', sourceObj._fullPath);
                                      }}
                                    >
                                      {displayTitle}
                                    </button>
                                  )}
                                </li>
                                );
                              })}
                              {msg.sources.length > 20 && (
                                <li className={`text-[11px] ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                                  ... 还有 {msg.sources.length - 20} 条来源
                                </li>
                              )}
                            </ul>
                          </details>
                          ); })()}

                        {/* 兼容旧版 citedPages */}
                        {msg.citedPages && msg.citedPages.length > 0 && !msg.sources && (
                          <div className="mt-3 pt-3 border-t border-gray-300 dark:border-gray-600">
                            <span className={`text-xs font-semibold ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                              参考文献 ({msg.citedPages.length} 个文件):
                            </span>
                            <ul className="mt-1 ml-4 text-xs space-y-0.5 list-none">
                              {msg.citedPages.map((cp) => (
                                <li key={cp.index}>
                                  <button
                                    className={`hover:underline text-left ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`}
                                    onClick={async () => {
                                      if (!cp._fullPath) return;
                                      const { ipcRenderer } = window.require('electron');
                                      await ipcRenderer.invoke('open-file-path', cp._fullPath);
                                    }}
                                    title={cp.title || cp.path}
                                  >
                                    [{cp.index}] {cp.title || cp.path}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
            
            {isTyping && <TypingIndicator theme={theme} />}
            
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* AI对话输入区域 — PPT生成期间隐藏 */}
        {!(targetFileType === 'slides' && pipelineState?.running) && (
        <>
        <ChrysSessionBanner theme={theme} chrysSessionId={chrysSessionId} setChrysSessionId={setChrysSessionId} chrysCodeSessionId={chrysCodeSessionId} setChrysCodeSessionId={setChrysCodeSessionId} />
        <div className={`p-4 border-t ${theme === 'dark' ? 'border-gray-700 bg-gray-800' : theme === 'light' ? 'border-gray-200 bg-white' : 'border-gray-500 bg-gray-600'}`}>
          <div className="w-full px-6">
            <div className="relative">
              <input
                type="text"
                ref={chatInputRef}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleChatKeyDown}
                placeholder={isChrysBusy && (targetFileType === 'slides' || targetFileType === 'code') ? '等待上一轮 Chrys 完成...' : (chrysSessionId ? '输入 PPT 修改要求（同一会话继续）...' : (chrysCodeSessionId ? '输入代码修改要求（同一会话继续）...' : '输入您的问题...'))}
                className={`w-full px-4 py-3 pr-14 rounded-xl outline-none transition-all ${
                  theme === 'dark'
                    ? 'bg-gray-700 text-white placeholder-gray-400'
                    : theme === 'light'
                      ? 'bg-white text-gray-900 placeholder-gray-400 border border-gray-300'
                      : 'bg-gray-500 text-white placeholder-gray-400'
                }`}
              />
              <button
                onClick={sendChatMessage}
                disabled={isTyping || (isChrysBusy && (targetFileType === 'slides' || targetFileType === 'code'))}
                className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-all ${
                  (isTyping || (isChrysBusy && (targetFileType === 'slides' || targetFileType === 'code')))
                    ? `${theme === 'dark' ? 'bg-gray-600 text-gray-400' : theme === 'light' ? 'bg-gray-200 text-gray-400' : 'bg-gray-500 text-gray-400'}`
                    : `${theme === 'dark'
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : theme === 'light'
                        ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`
                }`}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>

            {images.length > 0 && <ImageThumbnailBar images={images} theme={theme} removeImage={removeImage} />}
            
            
            <ChatToolbar
              theme={theme}
              setShowImageModal={setShowImageModal}
              targetFileType={targetFileType}
              fetchPptTasks={fetchPptTasks} pptTasksLoading={pptTasksLoading}
              isTyping={isTyping} isChrysBusy={isChrysBusy}
              handleClearHistory={handleClearHistory} handleSaveHistory={handleSaveHistory}
              savedModels={savedModels} selectedModelConfigId={selectedModelConfigId}
              selectModelConfig={selectModelConfig}
            />
          </div>
        </div>
        </>
        )}
      </div>

      {/* 可拖动分隔条2 */}
      <div className="relative flex flex-col items-center flex-shrink-0">
        <div 
          className={`w-1 h-full cursor-col-resize flex items-center justify-center transition-colors ${
            isDraggingRight 
              ? `${theme === 'dark' ? 'bg-indigo-500' : theme === 'light' ? 'bg-indigo-400' : 'bg-indigo-500'}` 
              : `${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500' : theme === 'light' ? 'bg-gray-300 hover:bg-gray-400' : 'bg-gray-400 hover:bg-gray-300'}`
          }`}
          onMouseDown={() => setIsDraggingRight(true)}
        >
          <div className={`w-0.5 h-8 rounded-full ${theme === 'dark' ? 'bg-gray-400' : theme === 'light' ? 'bg-gray-500' : 'bg-gray-300'}`} />
        </div>
      </div>

      {/* 右侧：目标文件选择 */}
      <div className={`h-full flex flex-col transition-all duration-100`} style={{ width: `${rightWidth}%` }}>
        {/* 头部 */}
        <div className={`flex items-center gap-2 px-3 py-3 ${theme === 'dark' ? 'bg-gray-800 border-b border-gray-700' : theme === 'light' ? 'bg-white border-b border-gray-200' : 'bg-gray-600 border-b border-gray-500'}`}>
          <FileText className={`w-4 h-4 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-500' : 'text-indigo-400'}`} />
          <h2 className={`text-sm font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>目标文件</h2>
        </div>

        {/* 文件类型选择 */}
        <div className={`flex-1 overflow-auto p-3 ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-gray-50' : 'bg-gray-500'}`}>
          <div className="space-y-3">
            <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>选择输出格式</p>
            
            {/* 幻灯片 */}
            <button
              onClick={() => {
                const newVal = targetFileType === 'slides' ? null : 'slides';
                setTargetFileType(newVal);
                writeMemoryFile({ qaConfig: { targetFileType: newVal, workMode } });
              }}
              className={`group w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                targetFileType === 'slides'
                  ? theme === 'dark' 
                    ? 'border-indigo-400 bg-indigo-600/20' 
                    : theme === 'light' 
                      ? 'border-indigo-500 bg-indigo-50' 
                      : 'border-indigo-400 bg-indigo-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <span className="text-xl">📊</span>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium whitespace-nowrap ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>幻灯片</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>PPT演示风格</div>
              </div>
              {targetFileType === 'slides' && <Check className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`} />}
              {targetFileType === 'slides' && (
                <span
                  onClick={async (e) => { 
                    e.stopPropagation(); 
                    try {
                      const { ipcRenderer } = window.require('electron');
                      const res = await ipcRenderer.invoke('list-chrys-agents');
                      if (res && res.success && res.agents) {
                        setPptAgentList(res.agents);
                      }
                    } catch (_) {}
                    setShowPptSettings(true); 
                  }}
                  className={`p-1 rounded hover:bg-white/20 transition-all cursor-pointer flex-shrink-0 opacity-0 group-hover:opacity-100 ${theme === 'dark' ? 'text-gray-400 hover:text-gray-200' : theme === 'light' ? 'text-gray-400 hover:text-gray-600' : 'text-gray-400 hover:text-gray-200'}`}
                  title="PPT 生成设置"
                >
                  <Settings className="w-4 h-4" />
                </span>
              )}
            </button>

            {/* 代码 */}
            <button
              onClick={() => {
                const newVal = targetFileType === 'code' ? null : 'code';
                setTargetFileType(newVal);
                writeMemoryFile({ qaConfig: { targetFileType: newVal, workMode } });
              }}
              className={`group w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                targetFileType === 'code'
                  ? theme === 'dark' 
                    ? 'border-indigo-400 bg-indigo-600/20' 
                    : theme === 'light' 
                      ? 'border-indigo-500 bg-indigo-50' 
                      : 'border-indigo-400 bg-indigo-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <span className="text-xl">💻</span>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium whitespace-nowrap ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>代码</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>程序开发代码</div>
              </div>
              {targetFileType === 'code' && <Check className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`} />}
              {targetFileType === 'code' && (
                <span
                  onClick={async (e) => { 
                    e.stopPropagation(); 
                    try {
                      const { ipcRenderer } = window.require('electron');
                      const res = await ipcRenderer.invoke('list-chrys-agents');
                      if (res && res.success && res.agents) {
                        setCodeAgentList(res.agents);
                      }
                    } catch (_) {}
                    setShowCodeSettings(true); 
                  }}
                  className={`p-1 rounded hover:bg-white/20 transition-all cursor-pointer flex-shrink-0 opacity-0 group-hover:opacity-100 ${theme === 'dark' ? 'text-gray-400 hover:text-gray-200' : theme === 'light' ? 'text-gray-400 hover:text-gray-600' : 'text-gray-400 hover:text-gray-200'}`}
                  title="代码生成设置"
                >
                  <Settings className="w-4 h-4" />
                </span>
              )}
            </button>

            {/* 文档 */}
            <button
              onClick={() => {
                const newVal = targetFileType === 'document' ? null : 'document';
                setTargetFileType(newVal);
                writeMemoryFile({ qaConfig: { targetFileType: newVal, workMode } });
              }}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                targetFileType === 'document'
                  ? theme === 'dark' 
                    ? 'border-indigo-400 bg-indigo-600/20' 
                    : theme === 'light' 
                      ? 'border-indigo-500 bg-indigo-50' 
                      : 'border-indigo-400 bg-indigo-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <span className="text-xl">📄</span>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>文档</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>正式报告格式</div>
              </div>
              {targetFileType === 'document' && <Check className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`} />}
            </button>

            {/* 图片 */}
            <button
              onClick={() => {
                const newVal = targetFileType === 'image' ? null : 'image';
                setTargetFileType(newVal);
                writeMemoryFile({ qaConfig: { targetFileType: newVal, workMode } });
              }}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                targetFileType === 'image'
                  ? theme === 'dark' 
                    ? 'border-indigo-400 bg-indigo-600/20' 
                    : theme === 'light' 
                      ? 'border-indigo-500 bg-indigo-50' 
                      : 'border-indigo-400 bg-indigo-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <span className="text-xl">🖼️</span>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>图片</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>图文配合展示</div>
              </div>
              {targetFileType === 'image' && <Check className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`} />}
            </button>
          </div>

          {/* 分隔线 */}
          <div className={`my-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`} />

          {/* 工作模式选择 */}
          <div className="space-y-3">
            <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>工作模式</p>
            
            {/* 快速 */}
            <button
              onClick={() => {
                setWorkMode('speed');
                writeMemoryFile({ qaConfig: { targetFileType, workMode: 'speed' } });
              }}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                workMode === 'speed'
                  ? theme === 'dark' 
                    ? 'border-green-400 bg-green-600/20' 
                    : theme === 'light' 
                      ? 'border-green-500 bg-green-50' 
                      : 'border-green-400 bg-green-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                workMode === 'speed' 
                  ? `${theme === 'dark' ? 'border-green-400' : theme === 'light' ? 'border-green-600' : 'border-green-400'}`
                  : `${theme === 'dark' ? 'border-gray-500' : theme === 'light' ? 'border-gray-400' : 'border-gray-500'}`
              }`}>
                {workMode === 'speed' && <div className={`w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-green-400' : theme === 'light' ? 'bg-green-600' : 'bg-green-400'}`} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>快速</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>仅搜索摘要 · 不抓取网页 · 响应最快</div>
              </div>
            </button>

            {/* 正常 */}
            <button
              onClick={() => {
                setWorkMode('normal');
                writeMemoryFile({ qaConfig: { targetFileType, workMode: 'normal' } });
              }}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                workMode === 'normal'
                  ? theme === 'dark' 
                    ? 'border-indigo-400 bg-indigo-600/20' 
                    : theme === 'light' 
                      ? 'border-indigo-500 bg-indigo-50' 
                      : 'border-indigo-400 bg-indigo-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                workMode === 'normal' 
                  ? `${theme === 'dark' ? 'border-indigo-400' : theme === 'light' ? 'border-indigo-600' : 'border-indigo-400'}`
                  : `${theme === 'dark' ? 'border-gray-500' : theme === 'light' ? 'border-gray-400' : 'border-gray-500'}`
              }`}>
                {workMode === 'normal' && <div className={`w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-indigo-400' : theme === 'light' ? 'bg-indigo-600' : 'bg-indigo-400'}`} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>正常</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>通用问答 · 轻量检索</div>
              </div>
            </button>

            {/* 专业 */}
            <button
              onClick={() => {
                setWorkMode('professional');
                writeMemoryFile({ qaConfig: { targetFileType, workMode: 'professional' } });
              }}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                workMode === 'professional'
                  ? theme === 'dark' 
                    ? 'border-purple-400 bg-purple-600/20' 
                    : theme === 'light' 
                      ? 'border-purple-500 bg-purple-50' 
                      : 'border-purple-400 bg-purple-600/20'
                  : theme === 'dark'
                    ? 'border-gray-600 hover:border-gray-500 bg-gray-700/50'
                    : theme === 'light'
                      ? 'border-gray-200 hover:border-gray-300 bg-white'
                      : 'border-gray-500 hover:border-gray-400 bg-gray-600/50'
              }`}
            >
              <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                workMode === 'professional' 
                  ? `${theme === 'dark' ? 'border-purple-400' : theme === 'light' ? 'border-purple-600' : 'border-purple-400'}`
                  : `${theme === 'dark' ? 'border-gray-500' : theme === 'light' ? 'border-gray-400' : 'border-gray-500'}`
              }`}>
                {workMode === 'professional' && <div className={`w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-purple-400' : theme === 'light' ? 'bg-purple-600' : 'bg-purple-400'}`} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>专业</div>
                <div className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>全平台搜索 · 抓取网页 · 深入分析</div>
              </div>
            </button>
          </div>

          {/* 当前选择状态摘要 */}
          {(targetFileType || workMode !== 'normal') && (
            <div className={`mt-4 p-2 rounded-lg text-xs ${theme === 'dark' ? 'bg-gray-700 text-gray-300' : theme === 'light' ? 'bg-gray-100 text-gray-600' : 'bg-gray-600 text-gray-300'}`}>
              <span className="opacity-60">当前设置：</span>
              <span className="font-medium">
                {targetFileType === 'slides' ? '幻灯片' : targetFileType === 'code' ? '代码' : targetFileType === 'document' ? '文档' : targetFileType === 'image' ? '图片' : '对话'}
                {workMode !== 'normal' && ' · '}
                {workMode === 'professional' ? '专业模式' : workMode === 'speed' ? '快速模式' : ''}
              </span>
            </div>
          )}
        </div>
      </div>
      
      {/* Path type selection modal */}
      {showPathTypeModal && (
        <PathTypeModal
          theme={theme}
          onSelectFile={handleSelectFile}
          onSelectDirectory={handleSelectDirectory}
          onClose={() => setShowPathTypeModal(false)}
        />
      )}

      {/* Browse modal */}
      {showBrowseModal && (
        <BrowseModal
          theme={theme}
          browseMode={browseMode}
          currentPath={currentPath}
          parentPath={parentPath}
          fileSystemItems={fileSystemItems}
          onNavigateUp={handleNavigateUp}
          onNavigateTo={handleNavigateTo}
          onConfirmSelection={handleConfirmSelection}
          onClose={() => setShowBrowseModal(false)}
        />
      )}
      
      {/* 知识库文件列表弹窗 */}
      {showFileListModal && (
        <KbFileListModal
          theme={theme}
          fileTree={fileTree}
          selectedKbNames={selectedKBIds.length > 0 ? getSelectedKBNames() : ''}
          onClose={() => setShowFileListModal(false)}
        />
      )}

      {/* PPT 生成设置弹窗 */}
      {showPptSettings && (
        <PptSettingsModal
          theme={theme}
          outputDir={outputDir} setOutputDir={setOutputDir}
          pptTemplate={pptTemplate} setPptTemplate={setPptTemplate}
          referencePptx={referencePptx} setReferencePptx={setReferencePptx}
          pptPromptTemplate={pptPromptTemplate} setPptPromptTemplate={setPptPromptTemplate}
          pptAgent={pptAgent} setPptAgent={setPptAgent} pptAgentList={pptAgentList}
          pptSvgMaxWorkers={pptSvgMaxWorkers} setPptSvgMaxWorkers={setPptSvgMaxWorkers}
          refocusInput={refocusInput}
          writeMemoryFile={writeMemoryFile}
          onClose={() => setShowPptSettings(false)}
        />
      )}
      {showCodeSettings && (
        <CodeSettingsModal
          theme={theme}
          codeOutputDir={codeOutputDir} setCodeOutputDir={setCodeOutputDir}
          codePromptTemplate={codePromptTemplate} setCodePromptTemplate={setCodePromptTemplate}
          codeAgent={codeAgent} setCodeAgent={setCodeAgent} codeAgentList={codeAgentList}
          refocusInput={refocusInput}
          writeMemoryFile={writeMemoryFile}
          onClose={() => setShowCodeSettings(false)}
        />
      )}

      {/* 创建知识库弹窗 */}
      {showCreateKBModal && (
        <CreateKbModal
          theme={theme}
          newKBName={newKBName} setNewKBName={setNewKBName}
          newKBPath={newKBPath} setNewKBPath={setNewKBPath}
          newKBNameInputRef={newKBNameInputRef} newKBPathInputRef={newKBPathInputRef}
          lastKbDir={lastKbDir} saveMemory={saveMemory}
          onCreate={handleCreateKnowledgeBase}
          onClose={() => setShowCreateKBModal(false)}
        />
      )}

      {/* 知识库切换确认弹窗 */}
      {showSwitchConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={handleCancelSwitch}>
          <div
            className={`rounded-2xl shadow-2xl w-[400px] overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`px-6 py-4 border-b flex items-center gap-3 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${theme === 'dark' ? 'bg-yellow-500/20 text-yellow-400' : theme === 'light' ? 'bg-yellow-100 text-yellow-600' : 'bg-yellow-500/20 text-yellow-400'}`}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div>
                <h3 className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                  切换知识库
                </h3>
                <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                  当前知识库有任务正在进行
                </p>
              </div>
            </div>

            <div className="px-6 py-4">
              <p className={`text-sm ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>
                切换知识库后，旧知识库的所有进行中任务（导入、删除、扫描等）将立即停止，已完成的部分会持久化到磁盘。切回时可恢复继续。
              </p>
            </div>

            <div className={`px-6 py-4 border-t flex justify-end gap-3 ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-100' : 'border-gray-600'}`}>
              <button
                onClick={handleCancelSwitch}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500 text-gray-200' : theme === 'light' ? 'bg-gray-200 hover:bg-gray-300 text-gray-600' : 'bg-gray-500 hover:bg-gray-400 text-gray-200'
                }`}
              >
                取消
              </button>
              <button
                onClick={handleConfirmSwitch}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  theme === 'dark' ? 'bg-yellow-600 hover:bg-yellow-700 text-white' : theme === 'light' ? 'bg-yellow-500 hover:bg-yellow-600 text-white' : 'bg-yellow-600 hover:bg-yellow-700 text-white'
                }`}
              >
                继续切换
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 远程目录树弹窗 */}
      {showRemoteTreeModal && remoteTreeData && (() => {
        const toggleExpand = (path) => {
          setRemoteTreeExpanded(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
          });
        };

        // 递归渲染树节点
        const TreeNode = ({ node, level = 0 }) => {
          const expanded = remoteTreeExpanded.has(node.path);
          const isDir = node.is_dir;
          const checkState = isDir ? getNodeCheckState(node) : null;
          const isChecked = remoteTreeChecked.has(node.path);

          const checkboxClass = `w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 cursor-pointer transition-all ${
            isChecked || checkState === 'checked'
              ? 'bg-indigo-500 border-indigo-500'
              : 'border-gray-500'
          }`;

          return (
            <div key={node.path}>
              <div
                className={`flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-white/5 cursor-pointer ${isChecked ? 'bg-indigo-500/10' : ''}`}
                style={{ paddingLeft: `${level * 20 + 8}px` }}
              >
                {/* 目录的展开/折叠按钮 */}
                {isDir && node.children && node.children.length > 0 ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleExpand(node.path); }}
                    className="p-0.5 rounded hover:bg-white/10 flex-shrink-0"
                  >
                    <ChevronDown
                      className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expanded ? '' : '-rotate-90'}`}
                    />
                  </button>
                ) : (
                  <span className="w-5 flex-shrink-0" />
                )}

                {/* 目录勾选框 */}
                {isDir ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleTreeNode(node); }}
                    className={checkboxClass}
                  >
                    {checkState === 'checked' && (
                      <Check className="w-3 h-3 text-white" />
                    )}
                    {checkState === 'indeterminate' && (
                      <div className="w-2 h-0.5 bg-white rounded" />
                    )}
                  </button>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleTreeNode(node); }}
                    className={checkboxClass}
                  >
                    {isChecked && <Check className="w-3 h-3 text-white" />}
                  </button>
                )}

                {/* 图标 */}
                <span
                  className="flex-shrink-0 cursor-pointer"
                  onClick={() => toggleTreeNode(node)}
                >
                  {isDir ? (
                    <Folder
                      className={`w-4 h-4 ${expanded ? 'text-amber-400' : 'text-amber-500'}`}
                    />
                  ) : (
                    <FileText className="w-4 h-4 text-blue-400" />
                  )}
                </span>

                {/* 名称 */}
                <span
                  className="text-sm truncate flex-1 cursor-pointer"
                  onClick={() => toggleTreeNode(node)}
                  style={{
                    color: theme === 'dark' ? '#e2e8f0' : theme === 'light' ? '#1a202c' : '#e2e8f0',
                  }}
                >
                  {node.name}
                </span>

                {/* 文件大小 */}
                {!isDir && node.size > 0 && (
                  <span className="text-xs text-gray-500 flex-shrink-0">
                    {node.size >= 1048576
                      ? `${(node.size / 1048576).toFixed(1)} MB`
                      : node.size >= 1024
                        ? `${(node.size / 1024).toFixed(1)} KB`
                        : `${node.size} B`}
                  </span>
                )}
              </div>

              {/* 递归显示子节点 */}
              {isDir && expanded && node.children && node.children.length > 0 && (
                <div>
                  {node.children.map((child) => (
                    <TreeNode key={child.path} node={child} level={level + 1} />
                  ))}
                </div>
              )}
              {isDir && expanded && node.children && node.children.length === 0 && (
                <div
                  className="text-xs text-gray-500 py-1"
                  style={{ paddingLeft: `${(level + 1) * 20 + 8}px` }}
                >
                  空目录
                </div>
              )}
            </div>
          );
        };

        const selectedCount = remoteTreeChecked.size;
        const allPaths = collectAllPaths(remoteTreeData);
        const allChecked = allPaths.every(p => remoteTreeChecked.has(p));

        return (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
            onClick={() => {
              setShowRemoteTreeModal(false);
              setRemoteTreeData(null);
            }}
          >
            <div
              className={`rounded-2xl shadow-2xl w-[520px] max-h-[85vh] overflow-hidden flex flex-col ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 头部 */}
              <div className={`px-5 py-3 border-b flex items-center gap-3 flex-shrink-0 ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-100' : 'border-gray-600'}`}>
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${theme === 'dark' ? 'bg-cyan-500/20 text-cyan-400' : theme === 'light' ? 'bg-cyan-100 text-cyan-600' : 'bg-cyan-500/20 text-cyan-400'}`}>
                  <Folder className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                    选择要下载的目录 / 文件
                  </h3>
                  <p className={`text-xs truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                    已选择 {selectedCount} 项
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowRemoteTreeModal(false);
                    setRemoteTreeData(null);
                  }}
                  className={`p-1.5 rounded-lg transition-all flex-shrink-0 ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-400 hover:text-white' : theme === 'light' ? 'hover:bg-gray-100 text-gray-400 hover:text-gray-600' : 'hover:bg-gray-600 text-gray-400 hover:text-white'}`}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* 树内容 */}
              <div className="flex-1 overflow-y-auto px-3 py-2 max-h-[50vh]">
                <TreeNode node={remoteTreeData} level={0} />
              </div>

              {/* 底部操作栏 */}
              <div className={`px-5 py-3 border-t flex items-center justify-between flex-shrink-0 ${theme === 'dark' ? 'border-gray-700 bg-gray-800/50' : theme === 'light' ? 'border-gray-100 bg-gray-50/50' : 'border-gray-600 bg-gray-700/50'}`}>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (allChecked) {
                        setRemoteTreeChecked(new Set());
                      } else {
                        setRemoteTreeChecked(new Set(allPaths));
                      }
                    }}
                    className={`text-xs px-2 py-1 rounded transition-all ${
                      theme === 'dark' ? 'text-gray-300 hover:bg-gray-600' : theme === 'light' ? 'text-gray-600 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {allChecked ? '取消全选' : '全选'}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setShowRemoteTreeModal(false);
                      setRemoteTreeData(null);
                    }}
                    className={`px-4 py-2 rounded-lg text-sm transition-all ${
                      theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : theme === 'light' ? 'bg-gray-200 hover:bg-gray-300 text-gray-600' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                    }`}
                  >
                    取消
                  </button>
                  <button
                    onClick={doSyncCommonKb}
                    disabled={selectedCount === 0}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      theme === 'dark'
                        ? 'bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40'
                        : theme === 'light'
                          ? 'bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-40'
                          : 'bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40'
                    }`}
                  >
                    <Download className="w-4 h-4" />
                    确认同步 ({selectedCount})
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <PreprocessorSettingsModal
        show={showPreprocessorSettingsModal}
        preprocessorConfig={preprocessorConfig}
        setPreprocessorConfig={setPreprocessorConfig}
        userInfo={userInfo}
        theme={theme}
        onClose={() => setShowPreprocessorSettingsModal(false)}
        onSave={savePreprocessorSettings}
        autoManage={preprocessorAutoManage}
        onToggleAutoManage={togglePreprocessorAutoManage}
        serviceStatus={preprocessorServiceStatus}
        onSetupService={setupPreprocessorService}
        onStopService={stopPreprocessorService}
      />

      <KBSettingsModal
        show={showKBSettingsModal}
        editingKB={editingKB}
        editingKBName={editingKBName}
        setEditingKBName={setEditingKBName}
        editingKBDesc={editingKBDesc}
        setEditingKBDesc={setEditingKBDesc}
        showUrlInput={showUrlInput}
        setShowUrlInput={setShowUrlInput}
        urlInputValue={urlInputValue}
        setUrlInputValue={setUrlInputValue}
        kbKnowledgeList={kbKnowledgeList}
        kbKnowledgeTree={kbKnowledgeTree}
        kbKnowledgeLoading={kbKnowledgeLoading}
        theme={theme}
        kbStatus={getKBStatus(editingKB?.id || editingKB?.knowledge_base_id)}
        onClose={() => { setShowKBSettingsModal(false); setEditingKB(null); refocusInput(); }}
        onSave={saveKBSettings}
        onDelete={deleteKB}
        onDeleteKnowledge={deleteKnowledge}
        onImportFiles={importFilesToKB}
        onImportFolders={importFoldersToKB}
        onImportUrl={importUrlToKB}
        onConfirmImportUrl={confirmImportUrl}
        onOpenWikiWindow={() => { setShowKBSettingsModal(false); handleToggleWikiWindow(); }}
        onOpenVector={() => { setShowKBSettingsModal(false); setShowVectorModal(true); }}
        onOpenSearchImport={openSearchImport}
      />
      {/* 搜索导入弹窗 */}
      {showSearchImport && (
        <SearchImportModal
          theme={theme}
          searchImportInputRef={searchImportInputRef}
          searchImportQuery={searchImportQuery} setSearchImportQuery={setSearchImportQuery}
          searchImportLoading={searchImportLoading}
          searchImportResults={searchImportResults}
          searchImportSelected={searchImportSelected}
          toggleSearchImportAll={toggleSearchImportAll}
          toggleSearchImportItem={toggleSearchImportItem}
          searchImportImporting={searchImportImporting}
          onSearch={doSearchImport}
          onConfirm={confirmSearchImport}
          onClose={() => setShowSearchImport(false)}
        />
      )}

      {showVectorModal && (
        <VectorModal
          theme={theme}
          vectorLoading={vectorLoading}
          vectorError={vectorError}
          vectorData={vectorData}
          vectorCanvasRef={vectorCanvasRef}
          vectorTooltipRef={vectorTooltipRef}
          fetchVectorVisualization={fetchVectorVisualization}
          onClose={() => setShowVectorModal(false)}
        />
      )}

      {/* 耗时打点统计可视化弹窗 */}
      {showPerfStats && (
        <PerfStatsModal
          theme={theme}
          projectPath={projectPath}
          onClose={() => setShowPerfStats(false)}
        />
      )}

      {/* 设置面板模态框 */}
      {showSettingsPanel && (
        <SettingsPanelModal
          theme={theme}
          onClose={() => setShowSettingsPanel(false)}
          searchMode={searchMode} setSearchMode={setSearchMode}
          renderMode={renderMode} setRenderMode={setRenderMode}
          wikiRunning={wikiRunning} onStartWiki={handleStartWiki} onStopWiki={handleStopWiki}
          mcpRunning={mcpRunning} mcpMode={mcpMode} onStartMcp={handleStartMcp} onStopMcp={handleStopMcp}
          kmaRunning={kmaRunning} onStartKma={handleStartKma} onStopKma={handleStopKma}
          searchEngine={searchEngine} setSearchEngine={setSearchEngine}
          searxngUrl={searxngUrl} setSearxngUrl={setSearxngUrl}
          proxyUrl={proxyUrl} setProxyUrl={setProxyUrl}
          processTree={processTree} processTreeLoading={processTreeLoading} processTreeError={processTreeError}
          onRefreshProcessTree={fetchProcessTree} onKillProcess={handleKillProcess} killPid={killPid}
          toolCheckLoading={toolCheckLoading} toolCheckResult={toolCheckResult} toolCheckError={toolCheckError}
          onCheckToolVersions={checkToolVersionUpdates}
          updatingTools={updatingTools} onUpdateTool={handleUpdateTool}
        />
      )}

      {/* 海问思答登录弹窗 */}
      {showHaiwenLogin && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]" onClick={() => setShowHaiwenLogin(false)}>
          <div
            className={`rounded-xl shadow-xl w-[400px] ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
              <div className={`text-lg font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>海问思答登录</div>
              <div className={`mt-1 text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                请输入 W3 账号密码（密码不会保存）
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                  W3 账号
                </label>
                <input
                  type="text"
                  value={haiwenUsername}
                  onChange={(e) => setHaiwenUsername(e.target.value)}
                  placeholder={userInfo?.name || "请输入 W3 账号"}
                  className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                    theme === 'dark'
                      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500'
                      : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400'
                  }`}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleHaiwenLogin(); }}
                />
              </div>

              <div>
                <label className={`block text-sm font-medium mb-1.5 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                  W3 密码
                </label>
                <input
                  type="password"
                  value={haiwenPassword}
                  onChange={(e) => setHaiwenPassword(e.target.value)}
                  placeholder="请输入 W3 密码"
                  className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                    theme === 'dark'
                      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500'
                      : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-400'
                  }`}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleHaiwenLogin(); }}
                />
              </div>

              {haiwenLoginError && (
                <div className={`text-sm p-2 rounded ${theme === 'dark' ? 'bg-red-900/30 text-red-400' : 'bg-red-50 text-red-600'}`}>
                  {haiwenLoginError}
                </div>
              )}
            </div>

            <div className={`p-4 border-t flex justify-end gap-3 ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
              <button
                onClick={() => setShowHaiwenLogin(false)}
                className={`px-4 py-2 rounded-lg text-sm ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'}`}
              >
                取消
              </button>
              <button
                onClick={handleHaiwenLogin}
                disabled={haiwenLoggingIn}
                className={`px-4 py-2 rounded-lg text-sm text-white transition-all ${
                  haiwenLoggingIn
                    ? 'bg-indigo-400 cursor-not-allowed'
                    : 'bg-indigo-600 hover:bg-indigo-500'
                }`}
              >
                {haiwenLoggingIn ? '登录中...' : '登录'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 后台任务面板 */}
      <TaskPanel
        tasks={tasks}
        onCancel={handleCancelTask}
        onClearCompleted={clearCompleted}
        theme={theme}
        kbCount={knowledgeBaseList.length}
      />
    </div>
  );
}

export default KnowledgeManagement;
