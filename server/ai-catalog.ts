import type { IncomingMessage, ServerResponse } from 'node:http';

interface CatalogEntry {
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

const entry = (
  identifier: string,
  displayName: string,
  type: string,
  url: string,
  description: string,
  capabilities: string[],
  representativeQueries: string[],
  metadata?: Record<string, unknown>,
): CatalogEntry => ({
  identifier,
  displayName,
  type,
  url,
  description,
  capabilities,
  representativeQueries,
  version: '1.0.0',
  updatedAt: '2026-07-18T00:00:00Z',
  ...(metadata ? { metadata } : {}),
});

export function createAiCatalog(origin: string) {
  const absolute = (pathname: string) => new URL(pathname, origin).href;
  return {
    specVersion: '1.0',
    host: {
      displayName: 'Forge Titan Assembly Floor',
      identifier: 'did:web:forgetitan.local',
      documentationUrl: 'https://github.com/Kulikowski/webmcp-ard-exploration',
    },
    entries: [
      entry(
        'urn:air:forgetitan.local:server:supplier',
        'Forge Titan Module Supplier',
        'application/mcp-server-card+json',
        absolute('/supplier/server-card.json'),
        'Supplier MCP server used to locate and order missing Forge Titan modules.',
        ['ListCatalog', 'CheckStock', 'OrderPart', 'GetOrderStatus'],
        [
          'find a missing Forge Titan shoulder actuator bracket',
          'order a replacement Forge Titan module',
        ],
      ),
      entry(
        'urn:air:forgetitan.local:skill:assemble-forge-titan',
        'Assemble Forge Titan',
        'application/ai-skill',
        absolute('/skills/assemble-forge-titan.md'),
        'Site-authored workflow guidance for assembling, testing, recovering, and deploying Forge Titan.',
        ['AssemblyWorkflow', 'SupplierRecovery', 'LoadTestRecovery', 'Deployment'],
        [
          'assemble test and deploy Forge Titan',
          'complete the Forge Titan assembly journey safely',
        ],
        { experimentalMediaType: true, status: 'example-grade' },
      ),
      entry(
        'urn:air:forgetitan.local:skill:recover-load-test',
        'Recover Forge Titan from a failed load test',
        'application/ai-skill',
        absolute('/skills/recover-forge-titan-load-test.md'),
        'State-specific recovery guidance for the seeded shoulder-bus coupling fault.',
        ['LoadTestDiagnosis', 'PowerBusRecovery'],
        ['recover Forge Titan after a failed load test', 'repair a shoulder bus coupling fault'],
        { experimentalMediaType: true, status: 'example-grade' },
      ),
      entry(
        'urn:air:forgetitan.local:skill:maintain-coolant-loop',
        'Maintain the Forge Titan coolant loop',
        'application/ai-skill',
        absolute('/skills/maintain-forge-titan-coolant.md'),
        'Site-authored procedure for flushing the actuator coolant loop through the cradle service hatch.',
        ['CoolantMaintenance', 'ServiceHatch'],
        ['flush the Forge Titan coolant loop', 'service the Forge Titan actuators'],
        { experimentalMediaType: true, status: 'example-grade' },
      ),
      entry(
        'urn:air:forgetitan.local:skill:paint-body',
        'Paint the Forge Titan body',
        'application/ai-skill',
        absolute('/skills/paint-forge-titan.md'),
        'Site-authored procedure for priming, painting, and curing the Forge Titan body.',
        ['PaintFinishing'],
        ['paint the Forge Titan body', 'prime and cure the Forge Titan body'],
        { experimentalMediaType: true, status: 'example-grade' },
      ),
      {
        identifier: 'urn:air:forgetitan.local:webmcp:assembly-floor',
        displayName: 'Forge Titan WebMCP surfaces',
        type: 'application/webmcp+json',
        data: {
          experimental: true,
          status: 'demo-defined-not-standardized',
          runtime: 'document.modelContext',
          lifecycle: 'stable core (discovery and side-path tools) plus state-gated assembly tools',
          surfaces: ['inventory', 'bench', 'wiring', 'calibration', 'test-rig', 'shipping'],
          relatedSkill: 'urn:air:forgetitan.local:skill:assemble-forge-titan',
        },
        description: 'Experimental declaration that this site exposes state-gated WebMCP tools.',
        capabilities: ['WebMCP', 'DynamicTools', 'StateGatedSkills'],
        representativeQueries: [
          'operate the Forge Titan assembly floor with WebMCP',
          'find a WebMCP robot assembly demo',
        ],
        version: '1.0.0',
        updatedAt: '2026-07-18T00:00:00Z',
        metadata: { experimentalMediaType: true, status: 'speculative' },
      } satisfies CatalogEntry,
    ],
  };
}

export function serveAiCatalog(req: IncomingMessage, res: ServerResponse): void {
  const origin = `http://${req.headers.host || '127.0.0.1'}`;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(createAiCatalog(origin), null, 2));
}
