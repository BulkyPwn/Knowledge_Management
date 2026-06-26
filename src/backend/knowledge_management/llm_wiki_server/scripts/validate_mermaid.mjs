/**
 * Mermaid syntax validator using mermaid.parse()
 *
 * Usage: node llm_wiki_server/scripts/validate_mermaid.mjs
 *   Reads mermaid code from stdin.
 *   Exit 0 + JSON {"valid": true}  on success
 *   Exit 0 + JSON {"valid": false, "error": "..."} on failure
 */

// mermaid v11 需要 DOM 环境 (DOMPurify)，用 jsdom 提供
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

const { default: mermaid } = await import('mermaid');

let code = '';
for await (const chunk of process.stdin) {
  code += chunk;
}
code = code.trim();

if (!code) {
  console.log(JSON.stringify({ valid: false, error: 'empty input' }));
  process.exit(0);
}

try {
  await mermaid.parse(code);
  console.log(JSON.stringify({ valid: true }));
} catch (e) {
  const msg = (e && e.message) ? e.message : String(e);
  // 只取第一行，去掉过长的内容
  const firstLine = msg.split('\n')[0].substring(0, 300);
  console.log(JSON.stringify({ valid: false, error: firstLine }));
}
