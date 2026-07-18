import { defineConfig } from 'vite';
import { handleMcpRequest } from './server/supplier-mcp.ts';
import { serveAiCatalog } from './server/ai-catalog.ts';

export default defineConfig({
  plugins: [
    {
      name: 'forge-titan-supplier-mcp',
      configureServer(server) {
        server.middlewares.use('/mcp', (req, res) => handleMcpRequest(req, res));
        server.middlewares.use('/.well-known/ai-catalog.json', (req, res) =>
          serveAiCatalog(req, res),
        );
        // Dev-only sink for the ?autotest smoke run: the page POSTs its outcome and
        // protocol log here so headless runs can be verified from the terminal.
        server.middlewares.use('/__autotest', (req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            console.log('\n[AUTOTEST]\n' + body + '\n[/AUTOTEST]');
            res.statusCode = 204;
            res.end();
          });
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
