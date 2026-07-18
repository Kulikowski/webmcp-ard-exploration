/** Minimal Streamable HTTP MCP client plus the Agentic Resource Discovery (ARD)
 *  catalog fetch. Talks to the supplier MCP server this demo ships with, and to
 *  any `/.well-known/ai-catalog.json` reachable from the current origin. */

export interface CatalogEntry {
  identifier: string;
  displayName: string;
  type: string;
  url?: string;
  data?: Record<string, unknown>;
  description: string;
  capabilities: string[];
  representativeQueries: string[];
  version: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AiCatalog {
  specVersion: string;
  host: { displayName: string; identifier: string; documentationUrl: string };
  entries: CatalogEntry[];
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface SupplierMcpConnection {
  catalog: AiCatalog;
  entry: CatalogEntry;
  card: { name: string; url: string; transport: string; protocolVersion: string; tools: string[] };
  endpoint: string;
  serverInfo: { name: string; title?: string; version: string };
  tools: McpToolSchema[];
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface RpcOptions {
  signal?: AbortSignal;
}

const PROTOCOL_VERSION = '2025-11-25';
let nextId = 0;

async function notify(
  endpoint: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: RpcOptions = {},
): Promise<void> {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
}

async function rpc<T = unknown>(
  endpoint: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: RpcOptions = {},
): Promise<T> {
  const body = { jsonrpc: '2.0', id: ++nextId, method, ...(params ? { params } : {}) };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (method !== 'initialize') headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error)
    throw new Error(data?.error?.message || `MCP HTTP ${response.status}`);
  return data.result;
}

export async function fetchAiCatalog(): Promise<AiCatalog> {
  const response = await fetch('/.well-known/ai-catalog.json', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`AI catalog discovery failed: HTTP ${response.status}`);
  return response.json();
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Dev-only convenience: if an advertised absolute URL points at a loopback
 *  host different from the one we're actually served from (e.g. the catalog
 *  hardcodes 127.0.0.1:8787 but Vite is running on a different port), rewrite
 *  it to the current origin. Never applies across real, non-loopback hosts. */
export function localLoopbackUrl(url: URL): URL | null {
  if (url.origin === location.origin) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname) || !LOOPBACK_HOSTS.has(location.hostname)) return null;
  return new URL(url.pathname + url.search, location.origin);
}

async function fetchAdvertisedResource(url: URL, options: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, options);
    if (response.ok) return response;
    throw new Error(`HTTP ${response.status}`);
  } catch (advertisedError) {
    if ((advertisedError as Error)?.name === 'AbortError') throw advertisedError;
    const fallbackUrl = localLoopbackUrl(url);
    if (!fallbackUrl)
      throw new Error(
        `Catalog resource fetch failed at ${url.href}: ${(advertisedError as Error).message}`,
        {
          cause: advertisedError,
        },
      );
    try {
      const fallback = await fetch(fallbackUrl, options);
      if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
      return fallback;
    } catch (fallbackError) {
      throw new Error(
        `Catalog resource fetch failed at ${url.href}; local fallback ${fallbackUrl.href} also failed: ${(fallbackError as Error).message}`,
        { cause: advertisedError },
      );
    }
  }
}

export async function fetchCatalogResource(
  entry: Pick<CatalogEntry, 'url'>,
  options: RequestInit = {},
): Promise<Response> {
  if (!entry?.url) throw new Error('Catalog entry has no URL resource');
  return fetchAdvertisedResource(new URL(entry.url, location.origin), options);
}

export async function discoverSupplierMcp(
  catalog: AiCatalog | null = null,
  options: RpcOptions = {},
): Promise<SupplierMcpConnection> {
  catalog ||= await fetchAiCatalog();
  const entry = catalog.entries?.find((item) => item.type === 'application/mcp-server-card+json');
  if (!entry?.url) throw new Error('AI catalog contains no MCP server card.');
  const cardResponse = await fetchCatalogResource(entry, {
    headers: { accept: 'application/json' },
    signal: options.signal,
  });
  const card = await cardResponse.json();
  const advertisedEndpoint = new URL(card.url, location.origin);
  const endpoint = (localLoopbackUrl(advertisedEndpoint) || advertisedEndpoint).href;
  const initialized = await rpc<{
    protocolVersion: string;
    serverInfo: SupplierMcpConnection['serverInfo'];
  }>(
    endpoint,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'forge-titan-browser-agent', version: '1.0.0' },
    },
    options,
  );
  if (initialized.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Unsupported MCP protocol version: ${initialized.protocolVersion}`);
  await notify(endpoint, 'notifications/initialized', undefined, options);
  const listed = await rpc<{ tools: McpToolSchema[] }>(endpoint, 'tools/list', {}, options);
  return {
    catalog,
    entry,
    card,
    endpoint,
    serverInfo: initialized.serverInfo,
    tools: listed.tools || [],
  };
}

export async function callSupplierTool(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
  options: RpcOptions = {},
): Promise<McpToolResult> {
  return rpc<McpToolResult>(endpoint, 'tools/call', { name, arguments: args }, options);
}
