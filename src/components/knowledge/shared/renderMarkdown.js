// 简易 Markdown → HTML 渲染（无外部依赖，与组件内实现一致）

export function renderMarkdown(text) {
  try {
    if (!text || typeof text !== 'string') return '';
    // 限制最大处理长度，防止超大文本导致正则回溯卡死
    const MAX_LENGTH = 50000;
    const truncated = text.length > MAX_LENGTH
      ? text.substring(0, MAX_LENGTH) + '\n\n...(内容过长已截断)'
      : text;
    let html = truncated
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<pre><code>${escaped}</code></pre>`;
    });

    html = html.replace(/(?:^|[ \t]*)\|(?:[^|\n]*\|)+\s*$\n?(?:^[ \t]*\|(?:[^|\n]*\|)+\s*$\n?)+/gm, (tableBlock) => {
      const lines = tableBlock.trim().split('\n');
      let result = '<table>';

      const headerCells = lines[0].split('|').filter(c => c.trim() !== '').map(c => c.trim());
      result += '<thead><tr>';
      headerCells.forEach(h => { result += `<th>${h}</th>`; });
      result += '</tr></thead>';

      let bodyStart = 1;
      if (lines.length > 1 && /^\|[\s\-:]+\|$/.test(lines[1])) {
        bodyStart = 2;
      }

      if (lines.length > bodyStart) {
        result += '<tbody>';
        for (let i = bodyStart; i < lines.length; i++) {
          const cells = lines[i].split('|').filter(c => c.trim() !== '').map(c => c.trim());
          result += '<tr>';
          cells.forEach(c => { result += `<td>${c}</td>`; });
          result += '</tr>';
        }
        result += '</tbody>';
      }

      result += '</table>';
      return result;
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 引用标识 [N] 突出显示
    html = html.replace(/\[(\d+)\]/g, '<cite class="citation">[$1]</cite>');

    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((<li>.*<\/li>\n?)+)/g, (match) => {
      if (!match.includes('<ul>')) {
        return `<ol>${match}</ol>`;
      }
      return match;
    });

    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br/>');
    html = '<p>' + html + '</p>';

    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>(<h[123][^>]*>)/g, '$1');
    html = html.replace(/(<\/h[123]>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>(<ol>)/g, '$1');
    html = html.replace(/(<\/ol>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>(<table>)/g, '$1');
    html = html.replace(/(<\/table>)\s*<\/p>/g, '$1');

    return html;
  } catch (e) {
    console.error('[renderMarkdown] error:', e);
    // 出错时返回纯文本，避免整个组件崩溃
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  }
}
