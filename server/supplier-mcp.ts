import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MCP_PROTOCOL_VERSION = '2025-11-25';

interface CatalogPart {
  sku: string;
  name: string;
  purpose: string;
  stock: number;
  price: number;
}

interface Order {
  orderId: string;
  sku: string;
  part: string;
  quantity: number;
  createdAt: number;
  delivered: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: [{ type: 'text'; text: string }];
  structuredContent: unknown;
  isError: boolean;
}

const catalog: CatalogPart[] = [
  {
    sku: 'FT-BRACKET-07',
    name: 'Shoulder actuator bracket',
    purpose: 'Required mounting bracket for the paired Forge Titan shoulder actuators.',
    stock: 24,
    price: 18.5,
  },
  {
    sku: 'FT-BUS-03',
    name: 'Shielded reactor bus coupling',
    purpose: 'Replacement coupling for Forge Titan reactor power-bus repairs.',
    stock: 18,
    price: 12.25,
  },
  {
    sku: 'FT-JOINT-12',
    name: 'Heavy-lift joint actuator',
    purpose: 'Replacement high-load actuator for Forge Titan arm or leg joints.',
    stock: 8,
    price: 84,
  },
];
const orders = new Map<string, Order>();

const tools = [
  {
    name: 'list_catalog',
    description:
      'List the three supplier parts with their exact SKU and intended Forge Titan use. Call this before check_stock or order_part; never guess a SKU.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              name: { type: 'string' },
              purpose: { type: 'string' },
            },
            required: ['sku', 'name', 'purpose'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'check_stock',
    description: 'Check supplier stock for a part SKU.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact SKU copied from a list_catalog item.' },
      },
      required: ['sku'],
    },
  },
  {
    name: 'order_part',
    description: 'Order an in-stock Titan module. Returns an order ID for status polling.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact SKU copied from a list_catalog item.' },
        quantity: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Number of units to order.',
        },
      },
      required: ['sku', 'quantity'],
    },
  },
  {
    name: 'get_order_status',
    description: 'Get order status. Delivered orders can be added to workshop inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Exact orderId returned by order_part.' },
      },
      required: ['orderId'],
    },
  },
];

const result = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError,
});

export function callTool(name: string, args: Record<string, unknown> = {}): ToolResult | null {
  if (name === 'list_catalog') {
    return result({
      items: catalog.map(({ sku, name: partName, purpose }) => ({ sku, name: partName, purpose })),
    });
  }
  if (name === 'check_stock') {
    const part = catalog.find((p) => p.sku === args.sku);
    return part
      ? result({ sku: part.sku, available: part.stock, unitPrice: part.price })
      : result({ error: 'Unknown SKU' }, true);
  }
  if (name === 'order_part') {
    const part = catalog.find((p) => p.sku === args.sku);
    const quantity = Number(args.quantity);
    if (!part) return result({ error: 'Unknown SKU' }, true);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > part.stock)
      return result({ error: 'Requested quantity is unavailable' }, true);
    part.stock -= quantity;
    const orderId = `RB-${randomUUID().slice(0, 8).toUpperCase()}`;
    orders.set(orderId, {
      orderId,
      sku: part.sku,
      part: part.name,
      quantity,
      createdAt: Date.now(),
      delivered: false,
    });
    return result({ orderId, status: 'processing', estimatedDeliveryMs: 700 });
  }
  if (name === 'get_order_status') {
    const order = orders.get(String(args.orderId));
    if (!order) return result({ error: 'Unknown order ID' }, true);
    if (Date.now() - order.createdAt >= 700) order.delivered = true;
    return result({
      orderId: order.orderId,
      status: order.delivered ? 'delivered' : 'processing',
      sku: order.sku,
      part: order.part,
      quantity: order.quantity,
    });
  }
  return null;
}

function rpcResponse(message: JsonRpcRequest) {
  const { id, method, params = {} } = message || ({} as JsonRpcRequest);
  if (method === 'initialize')
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'forge-titan-module-supplier',
          title: 'Forge Titan Module Supplier',
          version: '1.0.0',
        },
      },
    };
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
  if (method === 'tools/call') {
    const toolResult = callTool(params.name as string, params.arguments as Record<string, unknown>);
    return toolResult
      ? { jsonrpc: '2.0', id, result: toolResult }
      : { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (origin) {
    let allowed = false;
    try {
      const url = new URL(origin);
      allowed = ['localhost', '127.0.0.1'].includes(url.hostname);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Origin forbidden' } }),
      );
      return;
    }
  }
  if (req.method === 'GET') {
    res.writeHead(405, { Allow: 'POST', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'This stateless demo server does not expose an SSE stream.' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST' });
    res.end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  if (
    message.method !== 'initialize' &&
    req.headers['mcp-protocol-version'] !== MCP_PROTOCOL_VERSION
  ) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32600, message: 'Missing or unsupported MCP-Protocol-Version' },
      }),
    );
    return;
  }
  const response = rpcResponse(message);
  if (!response) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(response));
}
