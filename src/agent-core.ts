/**
 * agent-core.ts: the minimal multi-provider agent loop behind the Forge Titan
 * embedded agent. It stands in for the browser-hosted agent a visiting user would
 * bring, driving the page's WebMCP tool surface plus discovered supplier MCP tools.
 *
 * Supported providers: Anthropic (Claude), OpenAI (GPT), Google (Gemini), each via
 * its official REST API over raw fetch - no provider SDKs, so the loop runs in a
 * plain browser page.
 *
 * Conversation history is kept in ONE canonical format (Anthropic-style content
 * blocks: text / tool_use / tool_result). Each provider adapter converts that
 * canonical history to its own wire format on the way out and converts responses
 * back on the way in, so the same history can even move between providers
 * mid-conversation.
 *
 * Because WebMCP registrations change with application state, both `tools` and
 * `system` may be passed as functions; they are re-evaluated before every model
 * call so each iteration sees the live capability surface and skill set.
 */

// ---- Providers & models -------------------------------------------------------------

export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface ProviderInfo {
  id: Provider;
  label: string;
  keyPlaceholder: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', keyPlaceholder: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI', keyPlaceholder: 'sk-...' },
  { id: 'gemini', label: 'Google Gemini', keyPlaceholder: 'AIza...' },
];

export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string;
}

/**
 * Models the demo UI offers, grouped by provider. The full history is resent on
 * every call, so the demo defaults to the cheapest tier and lets you dial up when
 * you want a smarter agent.
 */
export const MODELS: ModelInfo[] = [
  { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', provider: 'anthropic', label: 'Opus 4.8' },
  { id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-terra', provider: 'openai', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6', provider: 'openai', label: 'GPT-5.6' },
  { id: 'gemini-3.1-flash-lite', provider: 'gemini', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3.5-flash', provider: 'gemini', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.1-pro-preview', provider: 'gemini', label: 'Gemini 3.1 Pro Preview' },
];
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Resolve which provider serves a model id. */
export function providerForModel(model: string): Provider {
  const known = MODELS.find((m) => m.id === model);
  if (known) return known.provider;
  throw new Error(`Cannot determine provider for model "${model}".`);
}

// ---- Canonical conversation format --------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Gemini-only: a thought signature that must be echoed back on the next turn. */
  _thoughtSignature?: string;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** Anthropic-origin reasoning blocks; passed through verbatim, never constructed here. */
export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  [key: string]: unknown;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type StopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'max_iterations';

interface ModelResponse {
  content: ContentBlock[];
  stopReason: StopReason;
}

/** A tool the loop can call. `input_schema` defaults to an empty object schema. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: { signal?: AbortSignal }) => Promise<unknown>;
}

interface ApiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

// ---- Anthropic adapter (Messages API) ----------------------------------------------

/** Strip loop-internal fields so only spec blocks reach the Messages API.
 *  Thinking blocks (Anthropic-origin) pass through verbatim; the API requires it. */
export function toAnthropicMessages(messages: Message[]) {
  return messages.map(({ role, content }) => {
    if (typeof content === 'string') return { role, content };
    const blocks = content
      .map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use')
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
        if (b.type === 'tool_result') {
          const r: { type: string; tool_use_id: string; content: string; is_error?: true } = {
            type: 'tool_result',
            tool_use_id: b.tool_use_id,
            content: b.content,
          };
          if (b.is_error) r.is_error = true;
          return r;
        }
        if (b.type === 'thinking' || b.type === 'redacted_thinking') return b;
        return null;
      })
      .filter(Boolean);
    return { role, content: blocks };
  });
}

interface CallParams {
  apiKey: string;
  model: string;
  system?: string;
  messages: Message[];
  tools: ApiTool[];
  maxTokens: number;
  signal?: AbortSignal;
}

async function callAnthropic({
  apiKey,
  model,
  system,
  messages,
  tools,
  maxTokens,
  signal,
}: CallParams): Promise<ModelResponse> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(messages),
  };
  // Adaptive thinking on models that support it (4.6+ families); Haiku 4.5 predates
  // adaptive and would reject it with a 400, so omit thinking there entirely.
  if (!model.includes('haiku')) {
    body.thinking = { type: 'adaptive' };
  }
  if (system) body.system = system;
  if (tools.length) body.tools = tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    signal,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct browser->api.anthropic.com CORS access. Harmless in Node.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok)
    throw new Error(`Anthropic API error: ${data?.error?.message || `HTTP ${res.status}`}`);
  // Already canonical.
  return { content: data.content, stopReason: data.stop_reason };
}

// ---- OpenAI adapter (Chat Completions API) ------------------------------------------

export function toOpenAIMessages(system: string | undefined, messages: Message[]) {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const { role, content } of messages) {
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (role === 'assistant') {
      const text = content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolCalls = content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // Canonical user messages carry either text or tool_result blocks.
      for (const b of content) {
        if (b.type === 'text') out.push({ role: 'user', content: b.text });
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
        }
      }
    }
  }
  return out;
}

async function callOpenAI({
  apiKey,
  model,
  system,
  messages,
  tools,
  maxTokens,
  signal,
}: CallParams): Promise<ModelResponse> {
  const body: Record<string, unknown> = {
    model,
    // GPT-5-era models reject legacy max_tokens; reasoning tokens also count here.
    max_completion_tokens: maxTokens,
    messages: toOpenAIMessages(system, messages),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(`OpenAI API error: ${data?.error?.message || `HTTP ${res.status}`}`);

  const choice = data.choices?.[0];
  if (!choice) throw new Error('OpenAI API error: empty choices in response.');
  const content: ContentBlock[] = [];
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const tc of choice.message?.tool_calls || []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      // Leave input empty; the tool will report missing arguments.
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  const stopReason: StopReason =
    choice.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : choice.finish_reason === 'content_filter'
          ? 'refusal'
          : 'end_turn';
  return { content, stopReason };
}

// ---- Gemini adapter (generateContent API) --------------------------------------------

let geminiCallCounter = 0;

export function toGeminiRequest(
  system: string | undefined,
  messages: Message[],
  tools: ApiTool[],
  maxTokens: number,
) {
  // functionResponse parts must repeat the function *name*; canonical tool_result
  // only stores the tool_use id, so build an id -> name map from the history.
  const nameById = new Map<string, string>();
  for (const { content } of messages) {
    if (Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_use') nameById.set(b.id, b.name);
    }
  }

  const contents: Record<string, unknown>[] = [];
  for (const { role, content } of messages) {
    if (typeof content === 'string') {
      contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] });
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    for (const b of content) {
      if (b.type === 'text') parts.push({ text: b.text });
      if (b.type === 'tool_use') {
        const part: Record<string, unknown> = {
          functionCall: { name: b.name, args: b.input ?? {} },
        };
        // Gemini 3 models require thought signatures to be echoed back in
        // multi-turn function calling; we stash them on the canonical block.
        if (b._thoughtSignature) part.thoughtSignature = b._thoughtSignature;
        parts.push(part);
      }
      if (b.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: nameById.get(b.tool_use_id) || 'unknown_tool',
            response: b.is_error ? { error: String(b.content) } : { result: String(b.content) },
          },
        });
      }
    }
    if (parts.length) contents.push({ role: role === 'assistant' ? 'model' : 'user', parts });
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => {
          const decl: Record<string, unknown> = { name: t.name, description: t.description };
          // Gemini rejects object schemas with no properties; omit them instead.
          const properties = (t.input_schema?.properties ?? {}) as Record<string, unknown>;
          if (t.input_schema && Object.keys(properties).length) {
            decl.parameters = t.input_schema;
          }
          return decl;
        }),
      },
    ];
  }
  return body;
}

async function callGemini({
  apiKey,
  model,
  system,
  messages,
  tools,
  maxTokens,
  signal,
}: CallParams): Promise<ModelResponse> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      signal,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(toGeminiRequest(system, messages, tools, maxTokens)),
    },
  );
  const data = await readJson(res);
  if (!res.ok) throw new Error(`Gemini API error: ${data?.error?.message || `HTTP ${res.status}`}`);

  const candidate = data.candidates?.[0];
  if (!candidate) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(
      `Gemini API error: no candidates returned${block ? ` (blocked: ${block})` : ''}.`,
    );
  }
  const content: ContentBlock[] = [];
  for (const part of candidate.content?.parts || []) {
    if (part.thought) continue; // thought summaries are not answer text
    if (part.text) content.push({ type: 'text', text: part.text });
    if (part.functionCall) {
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: `gemini-call-${++geminiCallCounter}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      };
      if (part.thoughtSignature) block._thoughtSignature = part.thoughtSignature;
      content.push(block);
    }
  }
  const hasCalls = content.some((b) => b.type === 'tool_use');
  const stopReason: StopReason = hasCalls
    ? 'tool_use'
    : candidate.finishReason === 'MAX_TOKENS'
      ? 'max_tokens'
      : candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT'
        ? 'refusal'
        : 'end_turn';
  return { content, stopReason };
}

// ---- Provider-neutral single call ----------------------------------------------------

const ADAPTERS: Record<Provider, (params: CallParams) => Promise<ModelResponse>> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  gemini: callGemini,
};

export type ApiKeys = Partial<Record<Provider, string>>;

/**
 * One non-streaming model call, any provider. `messages` is canonical history;
 * returns `{ content, stopReason }` with canonical content blocks.
 */
async function callModel({
  apiKeys = {},
  model = DEFAULT_MODEL,
  system,
  messages,
  tools = [],
  maxTokens = 16000,
  signal,
}: {
  apiKeys?: ApiKeys;
  model?: string;
  system?: string;
  messages: Message[];
  tools?: ApiTool[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<ModelResponse> {
  const provider = providerForModel(model);
  const apiKey = apiKeys[provider];
  if (!apiKey) {
    const label = PROVIDERS.find((p) => p.id === provider)?.label || provider;
    throw new Error(`No ${label} API key configured (model "${model}" needs one).`);
  }
  return ADAPTERS[provider]({ apiKey, model, system, messages, tools, maxTokens, signal });
}

// ---- The agent loop -------------------------------------------------------------------

export type AgentEvent =
  | {
      type: 'model_call';
      iteration: number;
      model: string;
      tools: string[];
      toolCount: number;
      toolDefinitionChars: number;
      systemChars: number;
    }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown>; unknown: boolean }
  | { type: 'tool_result'; name: string; content: string; isError: boolean };

export interface RunAgentLoopOptions {
  apiKeys?: ApiKeys;
  model?: string;
  /** Static system prompt, or a function re-evaluated before each model call. */
  system?: string | (() => string);
  /** Conversation history; mutated in place so callers keep multi-turn context. */
  messages: Message[];
  tools?: ToolDef[] | (() => ToolDef[]);
  onEvent?: (event: AgentEvent) => void;
  maxIterations?: number;
  signal?: AbortSignal;
}

export interface RunAgentLoopResult {
  text: string;
  messages: Message[];
  stopReason: StopReason;
}

/** Run the agentic loop until the model stops calling tools. */
export async function runAgentLoop({
  apiKeys,
  model,
  system,
  messages,
  tools = [],
  onEvent = () => {},
  maxIterations = 12,
  signal,
}: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  for (let i = 0; i < maxIterations; i++) {
    signal?.throwIfAborted();
    // Forge Titan may pass a function because WebMCP registrations change after
    // every state transition. Refresh before each model call so the model sees
    // the same live capability surface as a visiting browser agent.
    const iterationTools = typeof tools === 'function' ? tools() : tools;
    const apiTools: ApiTool[] = iterationTools.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema: input_schema || { type: 'object', properties: {} },
    }));
    const byName = new Map(iterationTools.map((t) => [t.name, t]));
    const iterationSystem = typeof system === 'function' ? system() : system;
    onEvent({
      type: 'model_call',
      iteration: i + 1,
      model: model || DEFAULT_MODEL,
      tools: apiTools.map((tool) => tool.name),
      toolCount: apiTools.length,
      toolDefinitionChars: JSON.stringify(apiTools).length,
      systemChars: String(iterationSystem || '').length,
    });
    const { content, stopReason } = await callModel({
      apiKeys,
      model,
      system: iterationSystem,
      messages,
      tools: apiTools,
      signal,
    });
    messages.push({ role: 'assistant', content });

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        onEvent({ type: 'assistant_text', text: block.text });
      }
    }

    if (stopReason !== 'tool_use') {
      const text = content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (stopReason === 'refusal') {
        return {
          text: text || 'The model declined this request.',
          messages,
          stopReason: 'refusal',
        };
      }
      return { text, messages, stopReason };
    }

    // Execute every tool_use block and answer all of them in one user message.
    const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const results: ToolResultBlock[] = [];
    for (const call of toolUses) {
      // `unknown` marks calls to tools absent from this iteration's surface -
      // either hallucinated or unregistered since the model last saw them.
      const tool = byName.get(call.name);
      onEvent({ type: 'tool_call', name: call.name, input: call.input, unknown: !tool });
      let resultContent: string;
      let isError = false;
      try {
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        signal?.throwIfAborted();
        const raw = await tool.execute(call.input ?? {}, { signal });
        resultContent = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        if (resultContent === undefined || resultContent === null || resultContent === '')
          resultContent = 'OK';
      } catch (err) {
        resultContent = `Error: ${(err as Error)?.message || err}`;
        isError = true;
      }
      onEvent({ type: 'tool_result', name: call.name, content: resultContent, isError });
      const result: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: call.id,
        content: resultContent,
      };
      if (isError) result.is_error = true;
      results.push(result);
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    text: '(Stopped: the agent hit its maximum number of loop iterations.)',
    messages,
    stopReason: 'max_iterations',
  };
}
