/**
 * 联网搜索 —— 配置获取/连通性检测/搜索执行/结果收集
 */
export default function useWebSearch({
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
}) {
  const performWebSearch = async (query) => {
    if (!query.trim()) return;
    setSearchLoading(true);
    setSearchResults([]);
    setSearchDiagnostics(null);
    try {
      const result = await searchWeb(query, 10, true);
      if (result.results) {
        setSearchResults(result.results);
        setSearchDiagnostics(result.diagnostics || { engine: result.engine, kept_count: result.results.length });
      } else {
        setSearchResults([]);
        setSearchDiagnostics(result.diagnostics || null);
      }
    } catch (err) {
      console.error('[web-search] Error:', err);
      setSearchResults([]);
      setSearchDiagnostics({ errors: [err.message] });
    } finally {
      setSearchLoading(false);
    }
  };

  const searchWeb = async (query, maxResults = 8, rawSearch = false) => {
    try {
      const res = await fetch(`${WIKI_BASE}/web-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          raw_search: rawSearch,
          engine: searchEngine,
          searxng_url: searxngUrl || undefined,
        }),
      });
      const data = await res.json();
      if (data.success && data.data) return data.data;
      return { results: [] };
    } catch (e) {
      return { results: [] };
    }
  };

  const formatSearchDiagnostics = (diag) => {
    if (!diag) return '';
    const raw = diag.raw_count ?? 0;
    const deduped = diag.deduped_count ?? raw;
    const kept = diag.kept_count ?? deduped;
    const parts = [`引擎: ${diag.engine || '-'}`];

    if (raw === deduped && deduped === kept) {
      parts.push(`结果: ${kept} 条`);
    } else if (raw === deduped && deduped !== kept) {
      parts.push(`结果: ${raw} 条，保留: ${kept} 条`);
    } else if (raw !== deduped && deduped === kept) {
      parts.push(`结果: ${raw} 条，去重后: ${deduped} 条`);
    } else {
      parts.push(`原始: ${raw}，去重: ${deduped}，保留: ${kept}`);
    }

    if (diag.fallback_used) parts.push(`回退: ${diag.requested_engine || '-'} → ${diag.engine || '-'}`);
    if (diag.errors?.length) parts.push(`错误: ${diag.errors.slice(0, 2).join(' | ')}`);
    return parts.join('，');
  };

  const fetchWebSearchConfig = async () => {
    try {
      const res = await fetch(`${WIKI_BASE}/websearch-config`);
      const data = await res.json();
      if (data.success && data.data) {
        const engine = data.data.engine || 'searxng';
        const searxng_url = data.data.searxng_url || '';
        setSearchEngine(engine);
        setSearxngUrl(searxng_url);
        writeMemoryFile({ webSearchConfig: { engine, searxng_url, api_key_set: !!data.data.api_key_set } });
      }
    } catch (_) {}
  };

  const checkWebSearchConnectivity = async () => {
    setWebSearchChecking(true);
    try {
      const res = await fetch(`${WIKI_BASE}/web-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'connectivity test', max_results: 1, raw_search: true }),
      });
      const data = await res.json();
      const available = data.success === true;
      setWebSearchAvailable(available);
      if (!available && platforms.webSearch) {
        setPlatforms(prev => {
          const newPlatforms = { ...prev, webSearch: false };
          writeMemoryFile({ platforms: newPlatforms });
          return newPlatforms;
        });
      }
    } catch (_) {
      setWebSearchAvailable(false);
      if (platforms.webSearch) {
        setPlatforms(prev => {
          const newPlatforms = { ...prev, webSearch: false };
          writeMemoryFile({ platforms: newPlatforms });
          return newPlatforms;
        });
      }
    } finally {
      setWebSearchChecking(false);
    }
  };

  const fetchPageContent = async (pageUrl) => {
    setFetchingPageUrl(pageUrl);
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('web-fetch-page', { pageUrl, proxyUrl: proxyUrl || undefined });
      if (result.success) {
        return result.content;
      }
      return null;
    } catch (err) {
      console.error('[web-fetch] Error:', err);
      return null;
    } finally {
      setFetchingPageUrl(null);
    }
  };

  const toggleSearchResultSelection = (result) => {
    setSelectedSearchResults(prev => {
      const exists = prev.find(r => r.url === result.url);
      if (exists) return prev.filter(r => r.url !== result.url);
      return [...prev, result];
    });
  };

  const collectSearchResultContent = async (result) => {
    const content = await fetchPageContent(result.url);
    const fallbackContent = result.snippet || result.title || '';
    return !!(content || fallbackContent);
  };

  const collectSelectedSearchResults = async () => {
    if (selectedSearchResults.length === 0) return;
    let successCount = 0;
    for (const result of selectedSearchResults) {
      if (await collectSearchResultContent(result)) successCount++;
    }
    setSelectedSearchResults([]);
    setMessages(prev => [...prev, {
      type: 'assistant',
      content: `已加入 ${successCount} 条资料。`,
      isStep: true,
    }]);
  };

  return {
    performWebSearch, searchWeb, formatSearchDiagnostics,
    fetchWebSearchConfig, checkWebSearchConnectivity, fetchPageContent,
    toggleSearchResultSelection, collectSearchResultContent, collectSelectedSearchResults,
  };
}
