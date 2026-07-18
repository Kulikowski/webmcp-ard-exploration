// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { localLoopbackUrl } from './mcp-client';

describe('localLoopbackUrl', () => {
  it('returns null when the URL is already same-origin', () => {
    expect(localLoopbackUrl(new URL(location.origin + '/mcp'))).toBeNull();
  });

  it('rewrites a different loopback host/port to the current origin', () => {
    // jsdom's default test origin is http://localhost:3000.
    const advertised = new URL('http://127.0.0.1:8787/supplier/server-card.json?x=1');
    const rewritten = localLoopbackUrl(advertised);
    expect(rewritten?.origin).toBe(location.origin);
    expect(rewritten?.pathname).toBe('/supplier/server-card.json');
    expect(rewritten?.search).toBe('?x=1');
  });

  it('never rewrites a real, non-loopback host', () => {
    expect(localLoopbackUrl(new URL('https://example.com/mcp'))).toBeNull();
  });
});
