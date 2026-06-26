// 构建 OpenAI 兼容的 chat/completions API URL
export function buildChatCompletionsUrl(baseUrl) {
  if (!baseUrl) return '';
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/chat/completions')) {
    url = url.slice(0, -'/chat/completions'.length);
  }
  const lower = url.toLowerCase();
  // 火山引擎 Ark coding 端点以 /api/coding/v3 或 /v3 结尾，不需要额外追加 /v1
  if (lower.endsWith('/api/coding/v3') || lower.endsWith('/v3')) {
    return url + '/chat/completions';
  }
  if (!url.endsWith('/v1') && !url.endsWith('/compatible-mode')) {
    url += '/v1';
  }
  url += '/chat/completions';
  return url;
}

// 构建系统提示词
export function buildSystemPrompt(targetFileType, workMode) {
  const parts = [];
  if (targetFileType === 'slides') {
    parts.push('请以适合制作PPT幻灯片的形式回答。要求：结构清晰、标题层级分明、每页要点控制在3-5条、适当使用编号和分点。');
  } else if (targetFileType === 'document') {
    parts.push('请以正式文档格式回答。要求：条理清晰、内容完整、包含目录结构、适当使用标题层级、段落分明。');
  } else if (targetFileType === 'image') {
    parts.push('请以适合配合图片展示的形式回答。要求：在适当位置标注[插图]标记、说明每处插图应展示的内容、文字描述与图片相互补充。');
  }
  if (workMode === 'professional') {
    parts.push('请从专业技术角度深入分析。要求：面向技术人员、解释底层原理、提供技术细节、包含代码示例或架构图描述、不简化概念。');
  } else if (workMode === 'speed') {
    parts.push('请简洁高效地回答。要求：抓重点、减少冗余、快速给出核心信息。');
  }
  return parts.join('\n');
}

// 调用 LLM 将知识库回复与图片结合，生成融合回答
export async function refineAnswerWithImages(wikiAnswer, question, images, llmConfig, models = []) {
  let url = llmConfig.llmUrl;
  let key = llmConfig.llmApiKey;
  let model = llmConfig.llmModel;

  // 通过 model 字段匹配（而非 id）来查找额外配置（url、apiKey）
  const configMatch = models.find(c => c.model === model);
  if (configMatch) {
    key = configMatch.apiKey || key;
    if (!url) url = configMatch.url || url;
  }

  if (!url || !model || !key) {
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/server/llm-config');
      const d = await resp.json();
      if (d.success && d.data) {
        url = d.data.llm_url || url;
        key = d.data.llm_api_key || key;
        model = d.data.llm_model || model;
      }
    } catch (e) {
      /* ignore */
    }
  }

  const chatUrl = buildChatCompletionsUrl(url);
  if (!chatUrl) return null;

  const promptText = `用户提问：${question}\n\n知识库回复如下：\n${wikiAnswer}\n\n请结合上面的图片，对知识库回复进行补充和完善，生成一份包含图片分析信息的最终回答。`;

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const visionContent = [{ type: 'text', text: promptText }];
  images.forEach(img => {
    visionContent.push({ type: 'image_url', image_url: { url: img.url } });
  });

  try {
    let resp = await fetch(chatUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: visionContent }], temperature: 0.3, max_tokens: 2048 }),
    });

    if (resp.ok) {
      const json = await resp.json();
      return json.choices?.[0]?.message?.content || null;
    }

    const imageUrls = images.map(img => img.url).join('\n');
    const textContent = `${promptText}\n\n图片数据（base64）:\n${imageUrls}`;

    resp = await fetch(chatUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: textContent }], temperature: 0.3, max_tokens: 2048 }),
    });

    if (resp.ok) {
      const json = await resp.json();
      return json.choices?.[0]?.message?.content || null;
    }
  } catch (e) {
    console.error('[Vision] Image merge failed:', e.message);
  }

  return null;
}

// 调用当前对话 LLM 将图片描述为文字，用于知识库检索
// 如果模型不支持 Vision（返回 400），跳过图片描述
// conversationContext: 对话历史消息数组 [{type: 'user'|'assistant', content: '...'}]，用于 prefix cache
export async function describeImagesToText(images, llmConfig, models = [], conversationContext = []) {
  let url = llmConfig.llmUrl;
  let key = llmConfig.llmApiKey;
  let model = llmConfig.llmModel;

  // 通过 model 字段匹配（而非 id）来查找额外配置（url、apiKey）
  const configMatch = models.find(c => c.model === model);
  if (configMatch) {
    key = configMatch.apiKey || key;
    if (!url) url = configMatch.url || url;
  }

  if (!url || !model || !key) {
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/server/llm-config');
      const d = await resp.json();
      if (d.success && d.data) {
        url = d.data.llm_url || url;
        key = d.data.llm_api_key || key;
        model = d.data.llm_model || model;
      }
    } catch (e) { /* server config fetch failed */ }
  }

  const chatUrl = buildChatCompletionsUrl(url);
  if (!chatUrl) {
    return '';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  // 从对话历史中取最近 5 轮 (10 条消息) 构建上下文前缀
  const hasContext = conversationContext.length > 0;
  const recentHistory = conversationContext.slice(-10);
  const historyMsgs = recentHistory.map(m => ({
    role: m.type === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : ''
  })).filter(m => m.content);

  // JSON schema 输出格式（放在 system message 中，所有请求共享，确保 prefix cache 命中）
  const JSON_SCHEMA = `严格按以下 JSON 格式输出图片分析结果（不要 markdown 代码块、不要任何解释文字）：
{
  "type": "图片类型（架构图/流程图/代码截图/数据图表/界面截图/照片/公式/其他）",
  "subject": "核心主体，10字以内",
  "keywords": ["3-6个用于知识库检索的关键术语${hasContext ? '，结合对话上下文提取' : ''}"],
  "summary": "一句话描述图片传达的核心信息，30字以内",
  "text": "图中可直接辨认的重要文字/标签/代码片段，用分号分隔，无则留空字符串",
  "relations": "元素之间的关键关系或数据流向，无则留空字符串"
}`;

  // 构建所有图片请求共享的消息前缀 (用于 prefix cache 命中)
  // system message 始终包含指令 + JSON schema，有 context 时额外包含对话历史
  const sharedPrefix = [];
  if (hasContext) {
    sharedPrefix.push({
      role: 'system',
      content: `你是一个图片分析助手。用户正在进行一段对话，请结合对话上下文来理解用户发送的图片内容，生成更精准的描述用于知识库检索。\n\n${JSON_SCHEMA}`
    });
    sharedPrefix.push(...historyMsgs);
  } else {
    sharedPrefix.push({
      role: 'system',
      content: `你是一个图片分析助手。请分析用户发送的图片内容，生成结构化描述用于知识库检索。\n\n${JSON_SCHEMA}`
    });
  }

  // user prompt 简化为短文本指令（JSON schema 已在 system message 中）
  const promptText = hasContext
    ? '结合上面的对话上下文，分析用户新发送的这张图片。'
    : '分析这张图片。';

  // 构建单张图片的请求 messages
  const buildImgMessages = (img) => [
    ...sharedPrefix,
    { role: 'user', content: [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: img.url } }] }
  ];

  // 发送单张图片描述请求
  const describeOne = async (img, i) => {
    try {
      const resp = await fetch(chatUrl, {
        method: 'POST', headers,
        body: JSON.stringify({
          model,
          messages: buildImgMessages(img),
          temperature: 0.1,
          max_tokens: 200,
          response_format: { type: 'json_object' },
        }),
      });
      if (resp.ok) {
        const json = await resp.json();
        const raw = json.choices?.[0]?.message?.content?.trim();
        if (!raw) return null;

        // 解析 JSON，容错处理（去掉可能的 markdown 包裹）
        let parsed;
        try {
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          console.warn('[Vision] describeImagesToText: image', i + 1, 'JSON parse failed, using raw text');
          return `[图片${i + 1}: ${img.name}]\n${raw}`;
        }

        const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.join(', ') : '';
        const label = `[图片${i + 1}: ${img.name}]`;
        const lines = [
          label,
          `类型: ${parsed.type || '未知'} | 主体: ${parsed.subject || ''}`,
          `关键词: ${keywords}`,
          `摘要: ${parsed.summary || ''}`,
        ];
        if (parsed.text) lines.push(`图中文字: ${parsed.text}`);
        if (parsed.relations) lines.push(`关系/流向: ${parsed.relations}`);

        const desc = lines.join('\n');
        return desc;
      }
      return { _visionUnsupported: true, status: resp.status };
    } catch (e) {
      console.error('[Vision] describeImagesToText: image', i + 1, 'description failed:', e.message);
      return null;
    }
  };

  // 全并发: system message 一致，prefix cache 自然生效
  const results = await Promise.all(images.map((img, i) => describeOne(img, i)));

  // 检查是否有模型不支持 Vision 的标记，过滤掉该标记后的有效结果
  const descriptions = [];
  for (const r of results) {
    if (r && typeof r === 'object' && r._visionUnsupported) {
      break;
    }
    if (r) descriptions.push(r);
  }

  const result = descriptions.join('\n\n');
  return result;
}
