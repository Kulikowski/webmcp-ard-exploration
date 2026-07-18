import { describe, expect, it } from 'vitest';
import {
  providerForModel,
  toAnthropicMessages,
  toOpenAIMessages,
  toGeminiRequest,
  type Message,
} from './agent-core';

describe('providerForModel', () => {
  it('resolves known models to their provider', () => {
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
    expect(providerForModel('gpt-5.6')).toBe('openai');
    expect(providerForModel('gemini-3.5-flash')).toBe('gemini');
  });

  it('throws for an unknown model id', () => {
    expect(() => providerForModel('some-made-up-model')).toThrow(/Cannot determine provider/);
  });
});

describe('toAnthropicMessages', () => {
  it('passes plain string content through unchanged', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    expect(toAnthropicMessages(messages)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('keeps tool_use and tool_result blocks, marking is_error only when true', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call1', name: 'list_parts', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'call2', content: 'boom', is_error: true },
        ],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[0]!.content).toEqual([
      { type: 'tool_use', id: 'call1', name: 'list_parts', input: {} },
    ]);
    expect(out[1]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'call2', content: 'boom', is_error: true },
    ]);
  });

  it('passes thinking blocks through verbatim', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' } as never],
      },
    ];
    expect(toAnthropicMessages(messages)[0]!.content).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    ]);
  });
});

describe('toOpenAIMessages', () => {
  it('prepends a system message when provided', () => {
    const out = toOpenAIMessages('be nice', [{ role: 'user', content: 'hi' }]);
    expect(out[0]).toEqual({ role: 'system', content: 'be nice' });
  });

  it('converts assistant tool_use blocks into OpenAI tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'x', name: 'list_parts', input: { a: 1 } },
        ],
      },
    ];
    const out = toOpenAIMessages(undefined, messages);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'list_parts', arguments: '{"a":1}' } },
        ],
      },
    ]);
  });

  it('splits user tool_result blocks into role:"tool" messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }] },
    ];
    expect(toOpenAIMessages(undefined, messages)).toEqual([
      { role: 'tool', tool_call_id: 'x', content: 'done' },
    ]);
  });
});

describe('toGeminiRequest', () => {
  it('maps assistant/user roles to model/user and carries thought signatures', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'x', name: 'list_parts', input: {}, _thoughtSignature: 'sig' },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ];
    const body = toGeminiRequest(undefined, messages, [], 100) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0]!.role).toBe('model');
    expect(body.contents[0]!.parts[0]).toMatchObject({
      functionCall: { name: 'list_parts', args: {} },
      thoughtSignature: 'sig',
    });
    expect(body.contents[1]!.role).toBe('user');
    expect(body.contents[1]!.parts[0]).toEqual({
      functionResponse: { name: 'list_parts', response: { result: 'ok' } },
    });
  });

  it('omits parameters for tools with an empty input schema (Gemini rejects them)', () => {
    const body = toGeminiRequest(
      undefined,
      [],
      [{ name: 't', description: 'd', input_schema: { type: 'object', properties: {} } }],
      100,
    ) as {
      tools: Array<{ functionDeclarations: Array<{ parameters?: unknown }> }>;
    };
    expect(body.tools[0]!.functionDeclarations[0]!.parameters).toBeUndefined();
  });
});
