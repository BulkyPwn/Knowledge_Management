// 引用标识提取与清洗、参考材料拼接

// 从答案文本中提取 [N] 引用，并将 <!-- cited: 1,2 --> 注释转为内联标记
export function extractAndCleanCitations(text, sources = []) {
  const citationIds = new Set();
  const addIds = (rawIds) => {
    String(rawIds || '')
      .split(/[^\d]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !Number.isNaN(n))
      .forEach(n => citationIds.add(n));
  };
  const toInlineMarkers = (rawIds) => {
    addIds(rawIds);
    const markers = String(rawIds || '')
      .split(/[^\d]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !Number.isNaN(n))
      .map(n => `[${n}]`)
      .join('');
    return markers ? ` ${markers}` : '';
  };
  const cleanText = String(text || '')
    .replace(/<!--\s*cited:\s*([^>]*)-->/gi, (_, rawIds) => toInlineMarkers(rawIds))
    .replace(/&lt;!--\s*cited:\s*([\s\S]*?)--&gt;/gi, (_, rawIds) => toInlineMarkers(rawIds))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text: cleanText,
    citedPages: sources.filter(s => citationIds.has(Number(s.index))),
    citationIds,
  };
}

export function buildReferenceMaterialsSection(sources = [], preferredSources = []) {
  const pool = preferredSources.length > 0 ? preferredSources : sources;
  const seen = new Set();
  const refs = [];

  for (const source of pool || []) {
    const key = source.url || source.path || source.title || source.index;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push(source);
    if (refs.length >= 20) break;
  }

  if (refs.length === 0) return '';

  const platformName = (platform) => (
    platform === 'local' ? '本地知识库'
      : platform === 'web' ? '互联网搜索'
      : platform === 'hiDesk' ? 'HiDesk'
      : platform === 'haiwen' ? '海问思答'
      : platform || '未知来源'
  );

  const lines = refs.map((source, idx) => {
    const index = Number(source.index) || idx + 1;
    const title = source.title || source.name || source.path || source.url || `参考材料 ${index}`;
    const location = source.url || source.path || '';
    const platform = platformName(source.platform);
    const detail = location ? `\n   来源：${platform} | ${location}` : `\n   来源：${platform}`;
    return `[${index}] ${title}${detail}`;
  });

  return `\n\n---\n\n## 参考材料\n\n${lines.join('\n\n')}`;
}

export function appendReferenceMaterials(answer, sources = [], preferredSources = []) {
  const cleanAnswer = String(answer || '').trim();
  if (!cleanAnswer || /(^|\n)#{1,3}\s*(参考材料|参考资料|信息来源|来源列表)\b/.test(cleanAnswer)) {
    return cleanAnswer;
  }
  return cleanAnswer + buildReferenceMaterialsSection(sources, preferredSources);
}
