/**
 * Thin wrapper around the browser's `document.modelContext` WebMCP host.
 * registerTool() is the only method the spec formally defines; getTools() and
 * executeTool() are named and intended (see the spec's README, "Discovering
 * and running tools" - formal IDL text is still a TODO there) and are exposed
 * to a document itself, same-origin documents in its tree, and built-in
 * browser agents by default, which is exactly the same-document round trip
 * this app relies on. This module knows nothing about assembly state; it only
 * knows how to talk to the host.
 */

export interface RegisteredToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContextTool {
  name: string;
  window?: Window;
}

interface ModelContextHost {
  registerTool: (tool: RegisteredToolDef, options?: { signal?: AbortSignal }) => Promise<void>;
  getTools: () => Promise<ModelContextTool[]>;
  executeTool: (tool: ModelContextTool, argsJson: string) => Promise<unknown>;
}

declare global {
  interface Document {
    modelContext?: ModelContextHost;
  }
}

export function getWebMcpHost(): ModelContextHost | undefined {
  const mc = document.modelContext;
  if (
    !mc ||
    typeof mc.registerTool !== 'function' ||
    typeof mc.getTools !== 'function' ||
    typeof mc.executeTool !== 'function'
  )
    return undefined;
  return mc;
}

function requireWebMcpHost(): ModelContextHost {
  const mc = getWebMcpHost();
  if (!mc)
    throw new Error(
      'WebMCP host unavailable: document.modelContext registerTool/getTools/executeTool are required.',
    );
  return mc;
}

/** Unwraps a WebMCP tool result: a resolved `{ isError: true, content }` JSON
 *  envelope becomes a thrown Error (some hosts replace a thrown Error with a
 *  generic message, so registered tools return failures this way instead). */
function webMcpResultText(result: unknown): string {
  if (result === null) throw new Error('WebMCP tool triggered navigation and returned no result.');
  let parsed: unknown = result;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      return result;
    }
  }
  const envelope = parsed as { isError?: boolean; content?: Array<{ text?: string }> } | null;
  if (envelope?.isError) {
    const detail =
      envelope.content
        ?.map((item) => item.text)
        .filter(Boolean)
        .join('\n') || 'WebMCP tool failed';
    throw new Error(detail.replace(/^Error:\s*/, ''));
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/** Calls a tool by name through the real getTools()/executeTool() round trip -
 *  the same path a visiting agent (or this page's own embedded demo agent)
 *  uses, not a shortcut that bypasses the host. */
export async function executeWebMcpTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const mc = requireWebMcpHost();
  const registered = await mc.getTools();
  const tool = registered.find(
    (candidate) => candidate.name === name && (!candidate.window || candidate.window === window),
  );
  if (!tool) throw new Error(`WebMCP tool is not registered in the current state: ${name}`);
  return webMcpResultText(await mc.executeTool(tool, JSON.stringify(args)));
}

export interface WebMcpStatus {
  supported: boolean;
  registered: number;
  error: string | null;
}

/**
 * Registers every tool in `defs` with the host, replacing whatever was
 * registered before (each previous registration is aborted first). Returns
 * the resulting status; call again whenever the tool surface should change.
 */
export function registerAllTools(
  defs: RegisteredToolDef[],
  registrations: AbortController[],
): WebMcpStatus {
  registrations.forEach((controller) => controller.abort());
  registrations.length = 0;
  const status: WebMcpStatus = { supported: false, registered: 0, error: null };
  const mc = getWebMcpHost();
  if (!mc) {
    status.error = 'This browser does not expose the complete experimental WebMCP host API.';
    return status;
  }
  status.supported = true;
  for (const def of defs) {
    const controller = new AbortController();
    registrations.push(controller);
    try {
      mc.registerTool(def, { signal: controller.signal });
      status.registered++;
    } catch (error) {
      status.error = (error as Error).message;
      console.debug('WebMCP registration unavailable', error);
    }
  }
  return status;
}

/** What this page currently has registered, read back through the real host -
 *  see the module doc comment on why that's the intended, spec-backed path. */
export async function liveRegisteredToolNames(): Promise<string[]> {
  const mc = getWebMcpHost();
  if (!mc) return [];
  const tools = await mc.getTools();
  return tools.filter((tool) => !tool.window || tool.window === window).map((tool) => tool.name);
}
