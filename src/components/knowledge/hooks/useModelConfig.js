/**
 * 模型配置管理 —— save/delete/sync/select
 * 纯函数集合，通过 props 注入状态 setter，不依赖 React hooks
 */
export default function useModelConfig({
  savedModels, setSavedModels,
  selectedModelConfigId, setSelectedModelConfigId,
  newModelName, setNewModelName,
  showModelList, setShowModelList,
  llmConfigStatus, setLlmConfigStatus,
  llmUrl, setLlmUrl, llmApiKey, setLlmApiKey,
  llmModel, setLlmModel, llmEmbeddingModel, setLlmEmbeddingModel,
  getFsRef, writeMemoryFile, DEFAULT_MODEL_ID,
}) {
  const saveModelConfig = () => {
    const newConfig = {
      id: `model_${Date.now()}`,
      name: newModelName || '未命名模型',
      type: 'chat',
      url: llmUrl,
      apiKey: llmApiKey,
      model: llmModel,
      embeddingModel: llmEmbeddingModel
    };
    const updatedModels = [...savedModels, newConfig];
    setSavedModels(updatedModels);
    writeMemoryFile({ savedModels: updatedModels });
    syncModelsToConfigFile(updatedModels);
    syncToAppState(newConfig.url, newConfig.apiKey, newConfig.model, newConfig.embeddingModel);
    syncModelsToChrys();
    setNewModelName('');
    setShowModelList(false);
    setLlmConfigStatus({ type: 'success', message: '模型配置已保存' });
  };

  const deleteModelConfig = (modelId) => {
    const updatedModels = savedModels.filter(m => m.id !== modelId);
    const newSelectedId = modelId === selectedModelConfigId
      ? (updatedModels[0]?.id || DEFAULT_MODEL_ID)
      : selectedModelConfigId;
    if (modelId === selectedModelConfigId) {
      setSelectedModelConfigId(newSelectedId);
    }
    setSavedModels(updatedModels);
    writeMemoryFile({ savedModels: updatedModels });
    syncModelsToConfigFile(updatedModels);
    // 同步当前选中模型配置到 app-state.json
    const activeModel = updatedModels.find(m => m.id === newSelectedId) || updatedModels[0];
    if (activeModel) {
      syncToAppState(activeModel.url, activeModel.apiKey, activeModel.model, activeModel.embeddingModel);
    }
    syncModelsToChrys();
  };

  /** 将当前模型配置同步到 app-state.json，使 Rust 后端可以读取 */
  const syncToAppState = (url, apiKey, model, embeddingModel) => {
    fetch('http://127.0.0.1:5002/api/v1/server/llm-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm_url: url || '',
        llm_api_key: apiKey || '',
        llm_model: model || '',
        llm_embedding_model: embeddingModel || '',
      }),
    }).catch(e => console.error('Failed to sync model config to app-state.json:', e));
  };

  const syncModelsToChrys = () => {
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('sync-chrys-models').catch(() => {});
      if (selectedModelConfigId) {
        ipcRenderer.invoke('set-chrys-active-model', selectedModelConfigId).catch(() => {});
      }
    } catch (_) {}
  };

  const syncModelsToConfigFile = (models) => {
    try {
      const fs = getFsRef();
      const pathMod = window.require('path');
      const osMod = window.require('os');
      const modelsPath = pathMod.join(osMod.homedir(), '.SSSC_AI', 'models.json');
      let existing = { MODELS: [], DEFAULT_MODEL_ID: DEFAULT_MODEL_ID };
      if (fs.existsSync(modelsPath)) {
        try { existing = JSON.parse(fs.readFileSync(modelsPath, 'utf-8')); } catch (_) {}
      }
      // 合并而非替换：对 models 中的每个条目，更新或追加到 existing.MODELS
      const existingModels = existing.MODELS || [];
      for (const m of models) {
        const idx = existingModels.findIndex(em => em.id === m.id);
        if (idx >= 0) {
          existingModels[idx] = { ...existingModels[idx], ...m };
        } else {
          existingModels.push(m);
        }
      }
      existing.MODELS = existingModels;
      fs.writeFileSync(modelsPath, JSON.stringify(existing, null, 2), 'utf-8');
    } catch (e) {
      console.error('[useModelConfig] syncModelsToConfigFile failed:', e.message);
    }
  };

  /** 同步写入 memory file（绕过 writeMemoryFile 的 setTimeout，确保后端能立即读到最新值） */
  const writeMemoryFileSync = (updates) => {
    try {
      const fs = getFsRef();
      if (!fs) throw new Error('getFsRef() returned null');
      const pathMod = window.require('path');
      const osMod = window.require('os');
      const f = pathMod.join(osMod.homedir(), '.SSSC_AI', 'knowledge_management.json');
      const dir = pathMod.dirname(f);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let data = {};
      if (fs.existsSync(f)) {
        try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) {}
      }
      Object.assign(data, updates);
      fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8');
      console.log('[useModelConfig] writeMemoryFileSync OK:', updates);
    } catch (e) {
      console.error('[useModelConfig] writeMemoryFileSync failed:', e.message, 'updates:', updates);
    }
  };

  const selectModelConfig = async (modelId) => {
    const config = savedModels.find(m => m.id === modelId);
    console.log('[selectModelConfig] switching to:', modelId, 'config:', config ? { id: config.id, name: config.name, model: config.model, url: config.url } : null);
    const _llm_url = config ? (config.url || '') : llmUrl;
    const _llm_api_key = config ? (config.apiKey || '') : llmApiKey;
    const _llm_model = config ? (config.model || '') : llmModel;
    const _llm_embedding_model = config ? (config.embeddingModel || '') : llmEmbeddingModel;

    console.log('[selectModelConfig] resolved values: url=', _llm_url, 'model=', _llm_model, 'apiKey=', _llm_api_key ? '***' : 'empty');

    if (config) {
      setLlmUrl(_llm_url);
      setLlmApiKey(_llm_api_key);
      setLlmModel(_llm_model);
      setLlmEmbeddingModel(_llm_embedding_model);
    }
    setSelectedModelConfigId(modelId);
    // 同步写入 memory file，确保后端立即读到最新 selectedModelConfigId
    writeMemoryFileSync({ selectedModelConfigId: modelId });
    setShowModelList(false);

    // 仅发送 selected_model_id + set_active，后端从 models.json 读取配置，
    // 避免 React state 中的过时 config 值污染 models.json
    const payload = { selected_model_id: modelId, set_active: true };
    console.log('[selectModelConfig] PUT payload:', payload);
    try {
      await fetch('http://127.0.0.1:5002/api/v1/server/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log('[selectModelConfig] PUT succeeded');
    } catch (e) {
      console.error('[selectModelConfig] PUT failed:', e);
    }

    try {
      const { ipcRenderer } = window.require('electron');
      await ipcRenderer.invoke('sync-chrys-models');
      await ipcRenderer.invoke('set-chrys-active-model', modelId);
      console.log('[selectModelConfig] Chrys sync done');
    } catch (e) {
      console.error('[selectModelConfig] Chrys sync failed:', e);
    }
  };

  return { saveModelConfig, deleteModelConfig, syncModelsToChrys, syncModelsToConfigFile, selectModelConfig };
}
