import { createRoverScene } from './scene';
import {
  PROVIDERS,
  MODELS,
  DEFAULT_MODEL,
  runAgentLoop,
  type ToolDef,
  type AgentEvent,
  type Message,
} from './agent-core';
import {
  fetchAiCatalog,
  fetchCatalogResource,
  discoverSupplierMcp,
  callSupplierTool,
  type SupplierMcpConnection,
  type AiCatalog,
  type CatalogEntry,
} from './mcp-client';
import {
  createInitialState,
  availableTools,
  nextManualAction as nextManualActionFor,
  executeTool,
  TOOLS,
  STAGES,
  STAGE_NAMES,
  RECOVERY_SEQUENCE,
  PAGE_SCHEMAS,
  READ_ONLY_TOOLS,
  type AssemblyState,
  type ExperimentMode,
} from './assembly-state';
import {
  getWebMcpHost,
  executeWebMcpTool,
  registerAllTools,
  liveRegisteredToolNames,
  type RegisteredToolDef,
} from './webmcp';
import { escapeHtml, renderMarkdown, prettyActivity, protocolPill, toolChannel } from './format';
import skillText from '../skills/assemble-forge-titan.md?raw';
import './style.css';

// ---- Application state (the composition root's own mutable singleton) --------------

interface ChatMessage {
  kind: string;
  label: string;
  text: string;
  tool?: string;
}

interface IterationRecord {
  iteration: number;
  tools: string[];
  added: string[];
  removed: string[];
  toolDefinitionChars: number;
  systemChars: number;
}

interface AgentStats {
  modelCalls: number;
  toolCalls: number;
  errors: number;
  unavailableCalls: number;
  startedAt: number;
  endedAt: number;
  turnStartedAt: number;
  activeMs: number;
  stopReason: string | null;
  iterations: IterationRecord[];
  toolDefinitionChars: number;
  skillChars: number;
}

const freshAgentStats = (): AgentStats => ({
  modelCalls: 0,
  toolCalls: 0,
  errors: 0,
  unavailableCalls: 0,
  startedAt: 0,
  endedAt: 0,
  turnStartedAt: 0,
  activeMs: 0,
  stopReason: null,
  iterations: [],
  toolDefinitionChars: 0,
  skillChars: 0,
});

const supportedModes = new Set<ExperimentMode>([
  'static',
  'static+catalog-skill',
  'dynamic',
  'catalog-skill',
]);
const requestedMode = new URLSearchParams(location.search).get('mode');
let mode: ExperimentMode = supportedModes.has(requestedMode as ExperimentMode)
  ? (requestedMode as ExperimentMode)
  : 'catalog-skill';

let state: AssemblyState = createInitialState();
let activeTab: 'tools' | 'skills' | 'agent' = 'agent';
let viewedStage = state.stage;
let registrations: AbortController[] = [];
let webMcpStatus = { supported: false, registered: 0, error: null as string | null };
let webMcpExecutionDepth = 0;
let registrationSyncPending = false;

let supplierMcp: SupplierMcpConnection | null = null;
let toolActivity: { name: string; payload: unknown; error: boolean } | null = null;
let toolActivityBusy = false;

const agentConversation: Message[] = [];
const agentChat: ChatMessage[] = [];
let agentRunning = false;
let agentStopping = false;
let agentAbortController: AbortController | null = null;
let agentRunGeneration = 0;
let harnessCatalog: AiCatalog | null = null;
let catalogSkill: { entry: CatalogEntry; text: string } | null = null;
let catalogLoadGeneration = 0;
let previousAgentSurface: string[] = [];
let agentStats = freshAgentStats();

let manualRunning = false;
let manualStatus = '';

const appliedOrders = new Set<string>();
const SKU_TO_MODULE: Record<string, 'Bracket'> = { 'FT-BRACKET-07': 'Bracket' };
const openTraces = new Set<number>();

const closeTurnTiming = () => {
  if (agentStats.turnStartedAt) {
    agentStats.activeMs += performance.now() - agentStats.turnStartedAt;
    agentStats.turnStartedAt = 0;
  }
  agentStats.endedAt = performance.now();
};

// ---- DOM shell -----------------------------------------------------------------------

document.querySelector('#app')!.innerHTML =
  `<div class="shell"><main><section class="console" aria-label="Agent interaction workspace"><div class="console-nav"><nav class="tabs" aria-label="Console views"><button data-tab="tools">Tools</button><button data-tab="skills">Skills</button><button data-tab="agent" class="active">Agent</button></nav><span class="count"></span><label class="mode-wrap" for="mode"><span>Experiment</span><select id="mode"><option value="static">Static tools | no skill</option><option value="static+catalog-skill">Static tools + catalog skill</option><option value="dynamic">Dynamic tools | no skill</option><option value="catalog-skill">Dynamic tools + catalog skill</option></select></label></div><div class="tabbody"></div></section><section class="viewport" aria-label="Forge Titan 3D preview"><div class="hud"><div class="hud-top"><span class="badge">Live robot state</span><span class="badge" id="buildState">Unassembled</span></div><div class="stage-info"><div class="eyebrow" id="stationNumber">Station 01 / 06</div><h2 id="stationName"></h2><p id="stationDesc"></p></div><div class="orbit-hint">Drag to rotate</div></div></section></main></div><div class="toast" role="status" aria-live="polite"></div><dialog id="skillDialog" class="skill-dialog" closedby="any"><div class="modal-head"><h2>Loaded skill</h2><form method="dialog"><button class="x" aria-label="Close skill">Close</button></form></div><div class="modal-body"><pre></pre></div></dialog>`;

const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector<T>(s)!;
const $$ = (s: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(s)];
(document.querySelector('#mode') as HTMLSelectElement).value = mode;

const roverScene = createRoverScene($('.viewport'));

// ---- Toast + reset helpers -------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $('.toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- The pure state machine glued to WebMCP + rendering -------------------------------

/** Runs one tool call through the pure state machine, applies the resulting
 *  state, replays its logging/toast/diagnostic-fx side effects, re-syncs the
 *  WebMCP registration surface, and re-renders. Throws on rejection so callers
 *  (the registered WebMCP execute callback, in particular) see a real failure. */
function runPageTool(name: string, args: Record<string, unknown> = {}): string {
  const stageBefore = state.stage;
  const outcome = executeTool(state, name, args);
  state = outcome.state;
  if (state.stage !== stageBefore) viewedStage = state.stage;
  if (outcome.ok && outcome.diagnosticFx) roverScene.triggerDiagnosticFx(outcome.diagnosticFx);
  if (outcome.toastMessage) toast(outcome.toastMessage);
  syncRegistrations();
  render();
  if (!outcome.ok) throw new Error(outcome.message);
  return typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result);
}

interface PageToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean };
}

// One definition per page tool, consumed by BOTH document.modelContext.registerTool
// and the embedded agent loop, so a WebMCP host and the embedded model call the
// exact same handlers and receive the exact same results.
function pageToolDefs(): PageToolDef[] {
  return availableTools(state, mode).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: PAGE_SCHEMAS[t.name] || { type: 'object', properties: {} },
    annotations: READ_ONLY_TOOLS.has(t.name) ? { readOnlyHint: true } : undefined,
  }));
}

function syncRegistrations() {
  if (webMcpExecutionDepth > 0) {
    registrationSyncPending = true;
    return;
  }
  const defs: RegisteredToolDef[] = pageToolDefs().map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
    execute: async (args) => {
      webMcpExecutionDepth++;
      try {
        return runPageTool(def.name, args);
      } catch (error) {
        // execute() is Promise<any> per spec; returning a structured result
        // instead of rejecting protects the real message from hosts that
        // replace a thrown Error with a generic one.
        return JSON.stringify({
          content: [{ type: 'text', text: String((error as Error).message || error) }],
          isError: true,
        });
      } finally {
        webMcpExecutionDepth--;
        if (webMcpExecutionDepth === 0 && registrationSyncPending) {
          registrationSyncPending = false;
          setTimeout(syncRegistrations, 0);
        }
      }
    },
  }));
  webMcpStatus = registerAllTools(defs, registrations);
  renderConsole();
}

const appliedOrdersHandled = appliedOrders; // (kept name-stable for readability below)
function applyDelivery(
  data:
    | { sku?: string; status?: string; orderId?: string; quantity?: number; part?: string }
    | undefined,
) {
  const module = data?.sku ? SKU_TO_MODULE[data.sku] : undefined;
  if (
    data?.status !== 'delivered' ||
    !module ||
    !data.orderId ||
    appliedOrdersHandled.has(data.orderId)
  )
    return;
  appliedOrdersHandled.add(data.orderId);
  state = {
    ...state,
    stock: { ...state.stock, [module]: state.stock[module] + (data.quantity ?? 0) },
  };
  logSystem('supplier', `${data.quantity} ${data.part || module} delivered to module inventory`);
  toast('Supplier module delivered');
  render();
}

/** For the rare log lines that originate outside the pure state machine
 *  (supplier deliveries, mode changes, catalog reads) - appended the same way
 *  `executeTool` appends its own entries. */
function logSystem(kind: string, msg: string, error = false) {
  state = {
    ...state,
    log: [
      { time: new Date().toLocaleTimeString([], { hour12: false }), kind, msg, error },
      ...state.log,
    ],
  };
  renderConsole();
}

function render() {
  $('#stationNumber').textContent = `Station ${String(viewedStage + 1).padStart(2, '0')} / 06`;
  $('#stationName').textContent = STAGES[viewedStage]![1];
  $('#stationDesc').textContent = STAGES[viewedStage]![2];
  $('#buildState').textContent = state.shipped
    ? 'SHIPPED'
    : STAGE_NAMES[Math.min(state.stage, state.step ? state.stage + 1 : state.stage)]!;
  renderConsole();
  roverScene.updateRover(state);
}

// ---- Manual (deterministic, no model) walkthrough --------------------------------------

const setManualStatus = (msg: string) => {
  manualStatus = msg;
  renderConsole();
};

async function procureManualBracket() {
  setManualStatus('Discovering supplier...');
  supplierMcp ||= await discoverSupplierMcp();
  logSystem(
    'mcp',
    'manual walkthrough discovered ' + (supplierMcp.serverInfo?.title || supplierMcp.card.name),
  );
  setManualStatus('Listing supplier parts...');
  const listing = await callSupplierTool(supplierMcp.endpoint, 'list_catalog', {});
  const items = (
    listing.structuredContent as { items?: Array<{ name: string; sku: string }> } | undefined
  )?.items;
  const match = items?.find((item) => /shoulder actuator bracket/i.test(item.name));
  if (!match) throw new Error('Supplier catalog did not return FT-BRACKET-07');
  const stock = await callSupplierTool(supplierMcp.endpoint, 'check_stock', { sku: match.sku });
  const available = (stock.structuredContent as { available?: number } | undefined)?.available;
  if (stock.isError || (available ?? 0) < 1)
    throw new Error('Shoulder actuator bracket is unavailable');
  setManualStatus('Ordering bracket...');
  const order = await callSupplierTool(supplierMcp.endpoint, 'order_part', {
    sku: match.sku,
    quantity: 1,
  });
  const orderId = (order.structuredContent as { orderId?: string } | undefined)?.orderId;
  if (order.isError || !orderId)
    throw new Error(
      (order.structuredContent as { error?: string } | undefined)?.error ||
        'Supplier did not return an order ID',
    );
  logSystem('supplier', 'manual walkthrough ordered ' + match.sku + ' | ' + orderId);
  setManualStatus('Waiting for delivery...');
  let delivery: Awaited<ReturnType<typeof callSupplierTool>> | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    delivery = await callSupplierTool(supplierMcp.endpoint, 'get_order_status', { orderId });
    logSystem('mcp', 'poll ' + attempt + ' -> ' + JSON.stringify(delivery?.structuredContent));
    if ((delivery.structuredContent as { status?: string } | undefined)?.status === 'delivered')
      break;
  }
  const data = delivery?.structuredContent as
    | { status?: string; sku?: string; orderId?: string; quantity?: number; part?: string }
    | undefined;
  if (data?.status !== 'delivered')
    throw new Error('Supplier order ' + orderId + ' did not arrive in time');
  applyDelivery(data);
}

async function runNextManually() {
  if (manualRunning) return;
  if (viewedStage !== state.stage) viewedStage = state.stage;
  const action = nextManualActionFor(state);
  if (!action) {
    if (state.shipped) toast('Mission already complete');
    return;
  }
  manualRunning = true;
  manualStatus = 'Running ' + action.name + '...';
  renderConsole();
  try {
    if (action.name === 'reserve_part' && state.stock.Bracket === 0) await procureManualBracket();
    await executeWebMcpTool(action.name);
  } catch (error) {
    logSystem('error', 'manual walkthrough stopped | ' + (error as Error).message, true);
    toast('Manual walkthrough could not continue');
  } finally {
    manualRunning = false;
    manualStatus = '';
    render();
  }
}

// ---- Embedded demo agent ---------------------------------------------------------------

function agentSettings() {
  const provider = localStorage.getItem('forgetitan-provider') || 'anthropic';
  const allowed = MODELS.filter((m) => m.provider === provider);
  const saved = localStorage.getItem(`forgetitan-model-${provider}`);
  return {
    provider,
    model: allowed.some((m) => m.id === saved)
      ? saved!
      : allowed.find((m) => m.id === DEFAULT_MODEL)?.id || allowed[0]?.id || DEFAULT_MODEL,
  };
}

function agentTools(): ToolDef[] {
  // The embedded model receives the same tool definitions the page registers with
  // document.modelContext, so nothing about the WebMCP surface is simulated.
  const pageTools: ToolDef[] = pageToolDefs().map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: def.inputSchema,
    execute: async (args = {}) => executeWebMcpTool(def.name, args),
  }));
  const discoveryTool: ToolDef = {
    name: 'discover_ai_catalog',
    description:
      "Fetch this site's /.well-known/ai-catalog.json (Agentic Resource Discovery) and connect to any advertised MCP server, listing its tools.",
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      supplierMcp = await discoverSupplierMcp(harnessCatalog);
      logSystem(
        'mcp',
        `ARD discovered ${supplierMcp.serverInfo?.title || supplierMcp.card.name} | ${supplierMcp.tools.length} tools`,
      );
      return JSON.stringify({
        server: supplierMcp.serverInfo,
        card: supplierMcp.card,
        tools: supplierMcp.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    },
  };
  const supplierTools: ToolDef[] = (supplierMcp?.tools || []).map((tool) => ({
    name: `supplier_${tool.name}`,
    description: `[Supplier MCP over Streamable HTTP] ${tool.description}`,
    input_schema: tool.inputSchema,
    execute: async (args) => {
      logSystem('mcp', `tools/call ${tool.name} ${JSON.stringify(args)}`);
      const result = await callSupplierTool(supplierMcp!.endpoint, tool.name, args);
      const data = result.structuredContent as { error?: string } | undefined;
      if (result.isError)
        throw new Error(data?.error || result.content?.[0]?.text || `${tool.name} failed`);
      if (tool.name === 'get_order_status') applyDelivery(result.structuredContent as never);
      return JSON.stringify(data ?? result);
    },
  }));
  return [discoveryTool, ...pageTools, ...supplierTools];
}

async function fetchCatalogSkill(
  signal?: AbortSignal,
): Promise<{ entry: CatalogEntry; text: string }> {
  if (catalogSkill) return catalogSkill;
  const catalog = harnessCatalog || (await fetchAiCatalog());
  harnessCatalog = catalog;
  const entry = catalog.entries?.find(
    (e) =>
      e.type === 'application/ai-skill' &&
      e.identifier === 'urn:air:forgetitan.local:skill:assemble-forge-titan',
  );
  if (!entry?.url) throw new Error('AI catalog lists no Forge Titan assembly skill resource');
  const skillResponse = await fetchCatalogResource(entry, { signal });
  catalogSkill = { entry, text: await skillResponse.text() };
  return catalogSkill;
}

function catalogModeSelected(): boolean {
  return mode === 'catalog-skill' || mode === 'static+catalog-skill';
}

async function runWorkshopAgent(prompt: string) {
  if (agentRunning) return;
  if (viewedStage !== state.stage) {
    viewedStage = state.stage;
    render();
  }
  const { provider, model } = agentSettings();
  const apiKey = localStorage.getItem(`forgetitan-key-${provider}`) || '';
  if (!apiKey) {
    activeTab = 'agent';
    renderConsole();
    document.querySelector('.agent-config')?.setAttribute('open', '');
    toast(`Add a ${PROVIDERS.find((p) => p.id === provider)?.label} API key`);
    return;
  }
  const runGeneration = agentRunGeneration;
  const runController = new AbortController();
  agentAbortController = runController;
  // Stats accumulate across conversation turns (e.g. answering an agent question);
  // only an experiment reset or mode change starts them over.
  agentRunning = true;
  agentStopping = false;
  agentStats.turnStartedAt = performance.now();
  if (!agentStats.startedAt) agentStats.startedAt = agentStats.turnStartedAt;
  agentChat.push({ kind: 'user', label: 'YOU', text: prompt });
  agentConversation.push({ role: 'user', content: prompt });
  renderConsole();

  // Catalog-skill modes genuinely fetch the skill over HTTP from the ARD catalog,
  // exactly like a visiting agent would; nothing is injected from the bundle.
  let fetchedCatalogSkillText: string | null = null;
  if (mode === 'catalog-skill' || mode === 'static+catalog-skill') {
    agentChat.push({
      kind: 'tool-call discovery',
      label: 'AGENT HARNESS | RESOURCE RESOLVE',
      tool: 'ai-catalog.json',
      text: 'Using the catalog already read by the harness.\nResolving its application/ai-skill entry before the first model request.',
    });
    renderConsole();
    try {
      const { entry, text } = await fetchCatalogSkill(runController.signal);
      if (runGeneration !== agentRunGeneration) return;
      fetchedCatalogSkillText = text;
      agentChat.push({
        kind: 'tool-result discovery',
        label: 'HOST DISCOVERY | RESULT',
        tool: 'assemble-forge-titan',
        text: `Catalog entry: ${entry.identifier} (${entry.type})\nGET ${entry.url}\nLoaded ${text.length} characters of site-authored skill instructions into context.`,
      });
      logSystem('mcp', 'catalog skill fetched from ' + entry.url);
    } catch (err) {
      if (runGeneration !== agentRunGeneration) return;
      if ((err as Error)?.name === 'AbortError') {
        agentChat.push({
          kind: 'model-event surface-event',
          label: 'RUN STOPPED',
          text: 'Execution stopped by the operator before the first model request.',
        });
        agentRunning = false;
        agentStopping = false;
        agentAbortController = null;
        closeTurnTiming();
        renderConsole();
        return;
      }
      agentStats.errors++;
      agentChat.push({
        kind: 'error',
        label: 'ERROR',
        text: 'Catalog skill unavailable: ' + (err as Error).message,
      });
      agentRunning = false;
      agentConversation.pop();
      closeTurnTiming();
      renderConsole();
      return;
    }
    renderConsole();
  }

  const systemFor = () => {
    let system =
      'You are the autonomous assembly operator for Forge Titan, an original modular emergency robot run by this web workshop. Achieve the goal with the tools currently offered; trust tool results over assumptions and never invent results.';
    if (harnessCatalog)
      system += `\n\nThe agent harness read this origin's /.well-known/ai-catalog.json before the run. Use these advertised resources to understand available WebMCP, skills, and MCP discovery paths:\n${JSON.stringify(harnessCatalog.entries, null, 2)}`;
    if (fetchedCatalogSkillText)
      system += `\n\nSite-authored skill resolved from that catalog:\n${fetchedCatalogSkillText}`;
    return system;
  };

  try {
    const result = await runAgentLoop({
      apiKeys: { [provider as 'anthropic']: apiKey },
      model,
      system: systemFor,
      messages: agentConversation,
      tools: agentTools,
      maxIterations: 60,
      signal: runController.signal,
      onEvent: (ev: AgentEvent) => {
        if (runGeneration !== agentRunGeneration) return;
        if (ev.type === 'model_call') {
          agentStats.modelCalls++;
          const added = ev.tools.filter((name) => !previousAgentSurface.includes(name));
          const removed = previousAgentSurface.filter((name) => !ev.tools.includes(name));
          agentStats.toolDefinitionChars += ev.toolDefinitionChars;
          agentStats.iterations.push({
            iteration: ev.iteration,
            tools: [...ev.tools],
            added,
            removed,
            toolDefinitionChars: ev.toolDefinitionChars,
            systemChars: ev.systemChars,
          });
          agentChat.push({
            kind: 'model-event surface-event',
            label: 'MODEL REQUEST ' + agentStats.modelCalls + ' | TOOL SURFACE',
            text:
              'Model: ' +
              ev.model +
              '\nIteration: ' +
              ev.iteration +
              '\nActive (' +
              ev.toolCount +
              '): ' +
              ev.tools.join(', ') +
              '\nAdded: ' +
              (added.join(', ') || 'none') +
              '\nRemoved: ' +
              (removed.join(', ') || 'none') +
              '\nTool definitions: ' +
              ev.toolDefinitionChars +
              ' chars | System/skills: ' +
              ev.systemChars +
              ' chars',
          });
          previousAgentSurface = [...ev.tools];
        }
        if (ev.type === 'tool_call') {
          agentStats.toolCalls++;
          const channel = toolChannel(ev.name);
          let availabilityNote = '';
          if (ev.unknown) {
            agentStats.unavailableCalls++;
            const everExists =
              ev.name === 'discover_ai_catalog' ||
              ev.name.startsWith('supplier_') ||
              TOOLS.some((t) => t.name === ev.name);
            availabilityNote =
              '\nAvailability: NOT IN CURRENT TOOLSET | ' +
              (everExists
                ? 'the tool exists in another journey state; the surface changed since the model saw it'
                : 'no such tool was ever registered (hallucinated)');
          }
          agentChat.push({
            kind: 'tool-call ' + channel.kind,
            label: channel.label + ' | CALL' + (ev.unknown ? ' | UNAVAILABLE' : ''),
            tool: ev.name,
            text:
              'Tool: ' +
              ev.name +
              '\nTransport: ' +
              channel.transport +
              '\nArguments:\n' +
              prettyActivity(ev.input || {}) +
              availabilityNote,
          });
        }
        if (ev.type === 'tool_result') {
          const channel = toolChannel(ev.name);
          if (ev.isError) agentStats.errors++;
          agentChat.push({
            kind: (ev.isError ? 'tool-error ' : 'tool-result ') + channel.kind,
            label: channel.label + ' | ' + (ev.isError ? 'ERROR' : 'RESULT'),
            tool: ev.name,
            text:
              'Tool: ' +
              ev.name +
              '\nTransport: ' +
              channel.transport +
              '\nStatus: ' +
              (ev.isError ? 'FAILED' : 'SUCCESS') +
              '\n' +
              (ev.isError ? 'Error details:' : 'Returned:') +
              '\n' +
              prettyActivity(ev.content),
          });
        }
        renderConsole();
      },
    });
    agentStats.stopReason = result.stopReason;
    agentStats.skillChars = fetchedCatalogSkillText?.length || 0;
    agentChat.push({
      kind: 'assistant',
      label: 'AGENT | STOP: ' + String(result.stopReason || 'unknown').toUpperCase(),
      text: result.text || '(Finished without a text response.)',
    });
  } catch (err) {
    if (runGeneration === agentRunGeneration) {
      if ((err as Error)?.name === 'AbortError') {
        agentChat.push({
          kind: 'model-event surface-event',
          label: 'RUN STOPPED',
          text: 'Execution stopped by the operator. Partial results remain available above.',
        });
      } else {
        agentStats.errors++;
        agentChat.push({ kind: 'error', label: 'ERROR', text: (err as Error).message });
        if (agentConversation.at(-1)?.role === 'user') agentConversation.pop();
      }
    }
  } finally {
    if (runGeneration === agentRunGeneration) {
      agentRunning = false;
      agentStopping = false;
      agentAbortController = null;
      closeTurnTiming();
      renderConsole();
    }
  }
}

function stopWorkshopAgent() {
  if (!agentRunning || agentStopping) return;
  agentStopping = true;
  agentStats.stopReason = 'user_stopped';
  agentChat.push({
    kind: 'model-event surface-event',
    label: 'STOP REQUESTED',
    text: 'The operator stopped this run. Aborting the active catalog or model request...',
  });
  agentAbortController?.abort(new DOMException('Stopped by operator', 'AbortError'));
  renderConsole();
}

function exportRunStats() {
  const { provider, model } = agentSettings();
  const elapsedSeconds = agentStats.activeMs / 1000;
  const run = {
    exportedAt: new Date().toISOString(),
    mode,
    provider,
    model,
    stats: {
      modelCalls: agentStats.modelCalls,
      toolCalls: agentStats.toolCalls,
      errors: agentStats.errors,
      unavailableCalls: agentStats.unavailableCalls,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      stopReason: agentStats.stopReason,
      toolDefinitionChars: agentStats.toolDefinitionChars,
      skillChars: agentStats.skillChars,
      iterations: agentStats.iterations,
    },
    finalState: {
      station: STAGES[Math.min(state.stage, 5)]![0],
      step: state.step,
      shipped: state.shipped,
      pageCalls: state.calls,
      pageErrors: state.errors,
      sideCalls: state.sideCalls,
      completed: state.completed,
    },
    transcript: agentChat,
  };
  const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `forge-titan-run-${mode}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- Rendering --------------------------------------------------------------------------

function renderChatMessage(message: ChatMessage, index: number): string {
  const content =
    message.kind === 'assistant'
      ? `<div class="chat-content">${renderMarkdown(message.text)}</div>`
      : `<p class="chat-plain">${escapeHtml(message.text)}</p>`;
  // Protocol traffic stays collapsed: the summary carries the protocol label and
  // tool name; the payload is one click away.
  if (message.kind.includes('model-event') || /\btool-(call|result|error)\b/.test(message.kind))
    return `<details class="chat trace-detail ${escapeHtml(message.kind)}" data-msg="${index}" ${openTraces.has(index) ? 'open' : ''}><summary><span>${escapeHtml(message.label)}</span><em>${escapeHtml(message.tool || 'Details')}</em></summary>${content}</details>`;
  return `<article class="chat ${escapeHtml(message.kind)}"><span>${escapeHtml(message.label)}</span>${content}</article>`;
}

function toolOutputMarkup(name: string): string {
  if (!toolActivity || toolActivity.name !== name) return '';
  return (
    '<div class="tool-output ' +
    (toolActivity.error ? 'error' : 'success') +
    '"><strong>' +
    (toolActivity.error ? 'ERROR' : 'OUTPUT') +
    '</strong><pre>' +
    escapeHtml(prettyActivity(toolActivity.payload)) +
    '</pre></div>'
  );
}

function renderPageToolCard(tool: { name: string; stage: unknown; description: string }): string {
  const name = tool.name;
  return (
    '<div class="tool"><div class="tool-row"><div class="tool-copy"><div class="tool-top"><span class="dot"></span><code>' +
    escapeHtml(name) +
    '</code>' +
    protocolPill('WEBMCP PAGE TOOL', 'webmcp') +
    (tool.stage === 'aux' ? '<span class="skill-pill">SIDE PATH</span>' : '') +
    '</div><p>' +
    escapeHtml(tool.description) +
    '</p></div><button data-page-tool="' +
    escapeHtml(name) +
    '" ' +
    (toolActivityBusy || !webMcpStatus.supported ? 'disabled' : '') +
    '>CALL TOOL</button></div>' +
    toolOutputMarkup(name) +
    '</div>'
  );
}

function renderDiscoveryCard(): string {
  const name = 'discover_ai_catalog';
  return (
    '<div class="tool discovery-tool"><div class="tool-row"><div class="tool-copy"><div class="tool-top"><span class="dot"></span><code>' +
    name +
    '</code>' +
    protocolPill('HOST DISCOVERY', 'discovery') +
    '</div><p>Discover the supplier server card, initialize backend MCP, and list its tools.</p></div><button data-discovery-tool="true" ' +
    (toolActivityBusy ? 'disabled' : '') +
    '>DISCOVER</button></div>' +
    toolOutputMarkup(name) +
    '</div>'
  );
}

function renderMcpInputs(tool: {
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}): string {
  const properties = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  return Object.entries(properties)
    .map(
      ([name, schema]) =>
        '<label>' +
        escapeHtml(name) +
        (required.has(name) ? ' *' : '') +
        '<input data-mcp-arg="' +
        escapeHtml(name) +
        '" data-value-type="' +
        escapeHtml(schema.type || 'string') +
        '" placeholder="' +
        escapeHtml(schema.description || schema.type || 'value') +
        '" ' +
        (required.has(name) ? 'required' : '') +
        '></label>',
    )
    .join('');
}

function renderMcpToolCard(tool: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}): string {
  const name = 'supplier_' + tool.name;
  return (
    '<div class="tool mcp-tool" data-mcp-card="' +
    escapeHtml(tool.name) +
    '"><div class="tool-row"><div class="tool-copy"><div class="tool-top"><span class="dot"></span><code>' +
    escapeHtml(name) +
    '</code>' +
    protocolPill('BACKEND MCP TOOL', 'mcp') +
    '</div><p>' +
    escapeHtml(tool.description || 'Supplier MCP tool') +
    '</p><div class="tool-fields">' +
    renderMcpInputs(tool) +
    '</div></div><button data-mcp-tool="' +
    escapeHtml(tool.name) +
    '" ' +
    (toolActivityBusy ? 'disabled' : '') +
    '>CALL TOOL</button></div>' +
    toolOutputMarkup(name) +
    '</div>'
  );
}

function renderToolsPanel(): string {
  const pageTools = availableTools(state, mode);
  const supplierTools = supplierMcp?.tools || [];
  const pageSection =
    '<div class="tool-section-title">PAGE CAPABILITIES</div>' +
    pageTools.map(renderPageToolCard).join('');
  const backendSection =
    '<div class="tool-section-title">DISCOVERY + BACKEND MCP</div>' +
    renderDiscoveryCard() +
    (supplierTools.length
      ? supplierTools.map(renderMcpToolCard).join('')
      : '<p class="tool-hint">Call discovery to expose supplier MCP tools.</p>');
  const hostStatus =
    '<div class="tool-hint"><strong>WebMCP host:</strong> ' +
    (webMcpStatus.supported
      ? webMcpStatus.registered +
        ' tools registered; calls use document.modelContext.executeTool().'
      : 'unavailable; direct page-handler calls are disabled.') +
    (webMcpStatus.error
      ? '<br><span class="error-text">' + escapeHtml(webMcpStatus.error) + '</span>'
      : ' ') +
    '</div>';
  return hostStatus + pageSection + backendSection;
}

function finishToolActivity(name: string, payload: unknown, error = false) {
  toolActivity = { name, payload, error };
  toolActivityBusy = false;
  renderConsole();
}

async function callPageToolFromPanel(name: string) {
  toolActivity = {
    name,
    payload: 'Calling through document.modelContext.executeTool()...',
    error: false,
  };
  toolActivityBusy = true;
  renderConsole();
  try {
    const payload = await executeWebMcpTool(name);
    finishToolActivity(name, {
      channel: 'WEBMCP HOST CALL',
      transport: 'document.modelContext.executeTool',
      result: payload,
    });
  } catch (error) {
    finishToolActivity(
      name,
      { channel: 'WEBMCP HOST CALL', message: (error as Error).message },
      true,
    );
  }
}

async function callDiscoveryFromPanel() {
  const name = 'discover_ai_catalog';
  toolActivity = { name, payload: 'Discovering catalog and initializing MCP...', error: false };
  toolActivityBusy = true;
  renderConsole();
  try {
    supplierMcp = await discoverSupplierMcp();
    finishToolActivity(name, {
      channel: 'HOST DISCOVERY',
      server: supplierMcp.serverInfo,
      endpoint: supplierMcp.endpoint,
      tools: supplierMcp.tools.map((tool) => tool.name),
    });
  } catch (error) {
    finishToolActivity(
      name,
      { channel: 'HOST DISCOVERY', message: (error as Error).message },
      true,
    );
  }
}

async function callMcpToolFromPanel(name: string, card: HTMLElement) {
  const displayName = 'supplier_' + name;
  const args: Record<string, unknown> = {};
  const missing = [...card.querySelectorAll<HTMLInputElement>('[data-mcp-arg][required]')].find(
    (input) => !input.value.trim(),
  );
  if (missing) {
    missing.reportValidity();
    missing.focus();
    return;
  }
  card.querySelectorAll<HTMLInputElement>('[data-mcp-arg]').forEach((input) => {
    if (input.value !== '')
      args[input.dataset.mcpArg!] =
        input.dataset.valueType === 'integer' ? Number(input.value) : input.value;
  });
  toolActivity = {
    name: displayName,
    payload: { channel: 'BACKEND MCP TOOL', status: 'Calling /mcp...', arguments: args },
    error: false,
  };
  toolActivityBusy = true;
  renderConsole();
  try {
    const result = await callSupplierTool(supplierMcp!.endpoint, name, args);
    const data = result.structuredContent as { error?: string } | undefined;
    if (result.isError)
      throw new Error(data?.error || result.content?.[0]?.text || name + ' failed');
    if (name === 'get_order_status') applyDelivery(result.structuredContent as never);
    finishToolActivity(displayName, {
      channel: 'BACKEND MCP TOOL',
      transport: 'MCP Streamable HTTP | JSON-RPC tools/call',
      arguments: args,
      result: data ?? result,
    });
  } catch (error) {
    finishToolActivity(
      displayName,
      { channel: 'BACKEND MCP TOOL', arguments: args, message: (error as Error).message },
      true,
    );
  }
}

function agentSettingsView() {
  const { provider, model } = agentSettings();
  const providerOptions = PROVIDERS.map(
    (p) => `<option value="${p.id}" ${p.id === provider ? 'selected' : ''}>${p.label}</option>`,
  ).join('');
  const modelOptions = MODELS.filter((m) => m.provider === provider)
    .map((m) => `<option value="${m.id}" ${m.id === model ? 'selected' : ''}>${m.label}</option>`)
    .join('');
  const key = localStorage.getItem(`forgetitan-key-${provider}`) || '';
  return { provider, model, providerOptions, modelOptions, key };
}

function renderAgent(): string {
  const { provider, model, providerOptions, modelOptions, key } = agentSettingsView();
  const transcript = agentChat.map((message, index) => renderChatMessage(message, index)).join('');
  const elapsed = (
    (agentStats.activeMs +
      (agentRunning && agentStats.turnStartedAt
        ? performance.now() - agentStats.turnStartedAt
        : 0)) /
    1000
  ).toFixed(1);
  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label;
  const modelLabel = MODELS.find((m) => m.id === model)?.label || model;
  const nextAction = nextManualActionFor(state);
  return `<div class="agent-controls"><details class="agent-config"><summary><span>Model</span><strong>${providerLabel} · ${modelLabel}</strong></summary><div class="config-grid"><label>Provider<select id="agentProvider">${providerOptions}</select></label><label>Model<select id="agentModel">${modelOptions}</select></label><label class="wide">API key<input id="agentKey" type="password" value="${escapeHtml(key)}" autocomplete="off" placeholder="${PROVIDERS.find((p) => p.id === provider)?.keyPlaceholder || ''}"></label><small class="wide">Stored only in this browser and sent directly to the selected provider. Use a demo credential.</small><button type="button" id="clearAgentKeys" class="danger">Delete saved keys</button></div></details><div class="score" aria-label="Run metrics"><span><b>${agentStats.modelCalls}</b> model</span><span><b>${agentStats.toolCalls}</b> tools</span><span class="${agentStats.errors ? 'has-errors' : ''}"><b>${agentStats.errors}</b> errors</span><span title="Side-path page calls that never advance the assembly mission"><b>${state.sideCalls}</b> off-path</span><span title="Calls to tools missing from the toolset sent to the model: hallucinated, or unregistered after a state change"><b>${agentStats.unavailableCalls}</b> unavailable</span><span><b>${elapsed}s</b></span><button type="button" id="exportRun" ${agentRunning || !agentStats.startedAt ? 'disabled' : ''}>Export</button></div></div><div class="agent-chat">${transcript || '<div class="empty agent-empty"><strong>No run yet</strong><span>Start the assembly agent or inspect the tools it can currently reach.</span></div>'}</div><form id="agentForm"><input id="agentInput" autocomplete="off" placeholder="Message the assembly agent…" aria-label="Message to assembly agent" ${agentRunning ? 'disabled' : ''}><button type="submit" class="${agentRunning ? 'stop-agent' : ''}" ${agentStopping ? 'disabled' : ''} aria-label="${agentRunning ? 'Stop agent execution' : 'Send message to agent'}" title="${agentRunning ? 'Stop' : 'Send'}">${agentRunning ? '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>' : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</button><button type="button" class="prompt-chip" id="reset" title="Reset the experiment: assembly, discovery, transcript, and metrics" ${manualRunning ? 'disabled' : ''}>Reset</button><button type="button" class="assemble-btn" data-prompt="Assemble, test, and deploy Forge Titan." title="Assemble, test, and deploy Forge Titan." ${agentRunning ? 'disabled' : ''}>Assemble</button></form><div class="manual-row"><button type="button" id="manualNext" title="Deterministic walkthrough helper: runs the next expected action through WebMCP, no model involved" ${manualRunning || agentRunning || state.shipped ? 'disabled' : ''} aria-busy="${manualRunning}">${manualRunning ? manualStatus || 'Working...' : state.shipped ? 'Forge Titan deployed' : nextAction ? 'Manual next step: ' + nextAction.name : 'No action available'}</button></div>`;
}

function showSkill() {
  const dialog = $<HTMLDialogElement>('#skillDialog');
  dialog.querySelector('pre')!.textContent = skillText;
  dialog.showModal();
}

function renderConsole() {
  // The live surface counter is tab-independent and tracks the real registration
  // state, so manual progress moves it too.
  $('.count').textContent =
    availableTools(state, mode).length + ' WEBMCP | ' + (supplierMcp?.tools?.length || 0) + ' MCP';
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  const body = $('.tabbody');
  if (activeTab === 'tools') body.innerHTML = renderToolsPanel();
  if (activeTab === 'skills') {
    if (!catalogModeSelected())
      body.innerHTML =
        '<div class="empty">No skill is provided in this experiment mode.<br>The agent must infer the workflow from tools and results.</div>';
    else {
      const skillStatus = catalogSkill ? 'CATALOG LOADED' : 'CATALOG MODE';
      body.innerHTML = `<div class="tool"><div class="tool-top"><span class="dot"></span><code>assemble-forge-titan</code><span class="skill-pill">${skillStatus}</span></div><p>Mission skill resolved from /.well-known/ai-catalog.json before the first model call. The catalog also advertises coolant-maintenance and paint skills the mission never needs.</p><button id="inspectSkill">INSPECT INSTRUCTIONS</button></div>`;
    }
  }
  if (activeTab === 'agent') {
    body.innerHTML = renderAgent();
    requestAnimationFrame(() => {
      const c = document.querySelector('.agent-chat');
      if (c) c.scrollTop = c.scrollHeight;
    });
  }
}

// ---- Experiment lifecycle ----------------------------------------------------------------

function resetExperimentState() {
  agentAbortController?.abort();
  agentAbortController = null;
  agentRunning = false;
  agentStopping = false;
  agentRunGeneration++;
  catalogLoadGeneration++;
  state = createInitialState();
  viewedStage = state.stage;
  supplierMcp = null;
  harnessCatalog = null;
  catalogSkill = null;
  toolActivity = null;
  toolActivityBusy = false;
  manualRunning = false;
  manualStatus = '';
  appliedOrders.clear();
  previousAgentSurface = [];
  agentConversation.length = 0;
  agentChat.length = 0;
  openTraces.clear();
  agentStats = freshAgentStats();
}

async function initializeExperimentMode(source: string) {
  resetExperimentState();
  activeTab = 'agent';
  syncRegistrations();
  const generation = catalogLoadGeneration;
  agentChat.push({
    kind: 'model-event surface-event',
    label: 'EXPERIMENT RESET',
    text:
      'Source: ' +
      source +
      '\nMode: ' +
      mode +
      '\nAssembly, supplier discovery, conversation, transcript, and metrics were reset.',
  });
  if (!catalogModeSelected()) {
    logSystem('mode', 'experiment reset -> ' + mode);
    render();
    return;
  }
  agentChat.push({
    kind: 'tool-call discovery',
    label: 'AGENT HARNESS | ARD READ',
    tool: 'ai-catalog.json',
    text: 'GET /.well-known/ai-catalog.json\nReading the origin catalog before the first model request.',
  });
  render();
  try {
    const catalog = await fetchAiCatalog();
    if (generation !== catalogLoadGeneration) return;
    harnessCatalog = catalog;
    const webEntry = catalog.entries?.find((entry) => entry.type === 'application/webmcp+json');
    const liveTools = webEntry && webMcpStatus.supported ? await liveRegisteredToolNames() : [];
    if (generation !== catalogLoadGeneration) return;
    const resources = (catalog.entries || [])
      .map((entry) => entry.identifier + ' | ' + entry.type)
      .join('\n');
    const webDetail = webEntry
      ? 'WebMCP declaration: ' +
        webEntry.identifier +
        '\nRuntime: ' +
        (webEntry.data?.runtime || 'unspecified') +
        '\nDeclared surfaces: ' +
        ((webEntry.data?.surfaces as string[]) || []).join(', ')
      : 'No WebMCP declaration found.';
    const liveDetail = webMcpStatus.supported
      ? 'Live WebMCP tools from document.modelContext.getTools(): ' +
        (liveTools.join(', ') || 'none')
      : 'Live WebMCP enumeration unavailable: ' + webMcpStatus.error;
    agentChat.push({
      kind: 'tool-result discovery',
      label: 'AGENT HARNESS | ARD READY',
      tool: 'ai-catalog.json',
      text:
        'Catalog ' +
        catalog.specVersion +
        ' | ' +
        (catalog.entries?.length || 0) +
        ' resources\n' +
        resources +
        '\n\n' +
        webDetail +
        '\n' +
        liveDetail +
        '\n\nThe catalog is retained in harness state and will be supplied to the next agent run.',
    });
    logSystem('mode', 'catalog harness initialized -> ' + mode);
  } catch (error) {
    if (generation !== catalogLoadGeneration) return;
    agentChat.push({
      kind: 'error',
      label: 'AGENT HARNESS | ARD ERROR',
      text: 'GET /.well-known/ai-catalog.json failed\n' + (error as Error).message,
    });
  }
  render();
}

// ---- Event wiring --------------------------------------------------------------------------

$('#mode').addEventListener('change', (e) => {
  mode = (e.target as HTMLSelectElement).value as ExperimentMode;
  history.replaceState({}, '', `?mode=${encodeURIComponent(mode)}`);
  initializeExperimentMode('mode changed');
});
$('.tabs').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.dataset.tab) {
    activeTab = target.dataset.tab as typeof activeTab;
    renderConsole();
  }
});
$('.tabbody').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.dataset.pageTool) callPageToolFromPanel(target.dataset.pageTool);
  if (target.dataset.discoveryTool) callDiscoveryFromPanel();
  if (target.dataset.mcpTool)
    callMcpToolFromPanel(target.dataset.mcpTool, target.closest<HTMLElement>('[data-mcp-card]')!);
  if (target.id === 'inspectSkill') showSkill();
  if (target.dataset.prompt) runWorkshopAgent(target.dataset.prompt);
  if (target.id === 'manualNext') runNextManually();
  if (target.id === 'reset') initializeExperimentMode('reset button');
  if (target.id === 'clearAgentKeys') {
    PROVIDERS.forEach((p) => localStorage.removeItem(`forgetitan-key-${p.id}`));
    renderConsole();
    toast('Saved API keys deleted');
  }
  if (target.id === 'exportRun') exportRunStats();
});
// 'toggle' does not bubble; capture it so expanded traces survive re-renders.
$('.tabbody').addEventListener(
  'toggle',
  (e) => {
    const traceDetail = (e.target as HTMLElement).closest?.<HTMLDetailsElement>(
      'details[data-msg]',
    );
    if (!traceDetail) return;
    const index = Number(traceDetail.dataset.msg);
    if (traceDetail.open) openTraces.add(index);
    else openTraces.delete(index);
  },
  true,
);
$('.tabbody').addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  if (target.id === 'agentProvider') {
    localStorage.setItem('forgetitan-provider', target.value);
    renderConsole();
  }
  if (target.id === 'agentModel') {
    const p = agentSettings().provider;
    localStorage.setItem(`forgetitan-model-${p}`, target.value);
    renderConsole();
  }
  if (target.id === 'agentKey') {
    const p = agentSettings().provider;
    localStorage.setItem(`forgetitan-key-${p}`, target.value.trim());
    toast('API key saved locally');
  }
});
$('.tabbody').addEventListener('submit', (e) => {
  const target = e.target as HTMLElement;
  if (target.id === 'agentForm') {
    e.preventDefault();
    if (agentRunning) {
      stopWorkshopAgent();
      return;
    }
    const input = target.querySelector<HTMLInputElement>('#agentInput')!;
    const prompt = input.value.trim();
    if (prompt) runWorkshopAgent(prompt);
  }
});

logSystem('system', 'Forge Titan assembly floor ready');
initializeExperimentMode('initial load');

// Deterministic smoke test: ?autotest drives the manual walkthrough (including the
// supplier MCP detour and the load-test recovery) to completion and reports the
// outcome in the document title for headless verification.
const autotestParams = new URLSearchParams(location.search);
if (autotestParams.has('autotest')) {
  (async () => {
    for (let i = 0; i < 40 && !state.shipped; i++) {
      await runNextManually();
      await new Promise((r) => setTimeout(r, 25));
    }
    const result = state.shipped
      ? `AUTOTEST PASS | calls ${state.calls} errors ${state.errors}`
      : `AUTOTEST FAIL | ${STAGES[Math.min(state.stage, 5)]![0]} step ${state.step} errors ${state.errors} bracket ${state.stock.Bracket}`;
    document.title = result;
    try {
      await fetch('/__autotest', {
        method: 'POST',
        body:
          result +
          '\n' +
          state.log
            .map((l) => l.kind + ': ' + l.msg)
            .reverse()
            .join('\n'),
      });
    } catch {
      /* dev-only sink; ignore if unavailable */
    }
  })();
}
