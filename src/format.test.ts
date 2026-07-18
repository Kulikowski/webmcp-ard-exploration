// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown, prettyActivity, toolChannel } from './format';

describe('escapeHtml', () => {
  it('escapes the five reserved HTML characters', () => {
    expect(escapeHtml(`<a href="x">it's & "great"</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;great&quot;&lt;/a&gt;',
    );
  });
});

describe('renderMarkdown', () => {
  it('renders basic markdown to sanitized HTML', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('strips a script tag instead of passing it through', () => {
    expect(renderMarkdown('<script>alert(1)</script>hello')).not.toContain('<script>');
  });
});

describe('prettyActivity', () => {
  it('shows a placeholder for empty payloads', () => {
    expect(prettyActivity(undefined)).toBe('(no payload)');
    expect(prettyActivity(null)).toBe('(no payload)');
    expect(prettyActivity('')).toBe('(no payload)');
  });

  it('pretty-prints an object as indented JSON', () => {
    expect(prettyActivity({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('re-indents a JSON string rather than double-encoding it', () => {
    expect(prettyActivity('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('leaves a non-JSON string as-is', () => {
    expect(prettyActivity('plain text')).toBe('plain text');
  });

  it('truncates output past maxLength', () => {
    const long = 'x'.repeat(20);
    expect(prettyActivity(long, 10)).toBe('xxxxxxxxxx\n... truncated at 10 characters');
  });
});

describe('toolChannel', () => {
  it('classifies supplier_ tools as backend MCP', () => {
    expect(toolChannel('supplier_check_stock').kind).toBe('mcp');
  });

  it('classifies discover_ai_catalog as host discovery', () => {
    expect(toolChannel('discover_ai_catalog').kind).toBe('discovery');
  });

  it('classifies everything else as a WebMCP host call', () => {
    expect(toolChannel('mount_torso').kind).toBe('webmcp');
  });
});
