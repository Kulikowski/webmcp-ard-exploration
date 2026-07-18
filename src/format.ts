import DOMPurify from 'dompurify';
import { marked } from 'marked';

export const escapeHtml = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function renderMarkdown(markdown: unknown): string {
  const parsed = marked.parse(String(markdown), { gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(parsed, { USE_PROFILES: { html: true } });
}

/** Pretty-prints a tool activity payload for display, truncating very long
 *  output so a single noisy call can't blow out the transcript view. */
export function prettyActivity(value: unknown, maxLength = 5000): string {
  if (value === undefined || value === null || value === '') return '(no payload)';
  let output: string;
  if (typeof value !== 'string') output = JSON.stringify(value, null, 2);
  else {
    try {
      output = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      output = value;
    }
  }
  return output.length > maxLength
    ? output.slice(0, maxLength) + '\n... truncated at ' + maxLength + ' characters'
    : output;
}

export function protocolPill(label: string, kind: string): string {
  return '<span class="protocol-pill ' + kind + '">' + label + '</span>';
}

export interface ToolChannel {
  label: string;
  kind: string;
  transport: string;
}

/** Classifies a tool call by which real transport it rides, for the transcript
 *  labels and the Tools panel's protocol pills. */
export function toolChannel(name: string): ToolChannel {
  if (name.startsWith('supplier_'))
    return {
      label: 'BACKEND MCP TOOL',
      kind: 'mcp',
      transport: 'MCP Streamable HTTP | JSON-RPC tools/call -> /mcp',
    };
  if (name === 'discover_ai_catalog')
    return {
      label: 'HOST DISCOVERY',
      kind: 'discovery',
      transport: 'ARD catalog + server card | MCP initialize + tools/list',
    };
  return {
    label: 'WEBMCP HOST CALL',
    kind: 'webmcp',
    transport: 'document.modelContext.getTools + executeTool',
  };
}
