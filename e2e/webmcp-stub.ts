import type { Page } from '@playwright/test';

export async function installWebMcpStub(page: Page) {
  await page.addInitScript(() => {
    const registry = new Map<string, { execute: (args: unknown) => Promise<unknown> }>();
    Object.defineProperty(document, 'modelContext', {
      value: {
        async registerTool(
          tool: { name: string; execute: (args: unknown) => Promise<unknown> },
          options: { signal?: AbortSignal } = {},
        ) {
          registry.set(tool.name, tool);
          options.signal?.addEventListener('abort', () => registry.delete(tool.name));
        },
        async getTools() {
          return [...registry.keys()].map((name) => ({ name }));
        },
        async executeTool(toolRef: { name: string }, argsJson: string) {
          const tool = registry.get(toolRef.name);
          if (!tool) throw new Error(`No such tool: ${toolRef.name}`);
          return tool.execute(JSON.parse(argsJson || '{}'));
        },
        ontoolchange: null,
      },
      configurable: true,
    });
  });
}
