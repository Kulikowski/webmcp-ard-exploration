import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { handleMcpRequest } from './supplier-mcp.ts';
import { serveAiCatalog } from './ai-catalog.ts';

const root = new URL('../dist/', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (requestPath === '/mcp') return handleMcpRequest(req, res);
  if (requestPath === '/.well-known/ai-catalog.json') return serveAiCatalog(req, res);
  let pathname = decodeURIComponent(requestPath);
  if (pathname === '/') pathname = '/index.html';
  let file = normalize(join(root, pathname));
  if (!file.startsWith(normalize(root))) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    const publicCatalogResource =
      pathname.startsWith('/skills/') || pathname === '/supplier/server-card.json';
    const headers = {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      ...(publicCatalogResource
        ? { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }
        : {}),
    };
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'content-type': mime['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Build the app first with npm run build.');
    }
  }
}).listen(8787, '127.0.0.1', () => console.log('Forge Titan: http://127.0.0.1:8787'));
