/**
 * Reproduction Script for StreamableHTTPServerTransport Memory Leak
 * 
 * This script demonstrates the issue where request ID mappings are not
 * cleaned up when a connection closes unexpectedly.
 * 
 * Usage:
 *   1. npm install @modelcontextprotocol/sdk
 *   2. npx tsx reproduce-server.ts
 *   3. Run the test script in another terminal
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';

// Track active requests for debugging
const activeRequests = new Map<number, { startTime: number; toolName: string }>();

// Create MCP Server
const server = new Server(
  {
    name: 'reproduction-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log('[tools/list] Returning tool list');
  return {
    tools: [
      {
        name: 'slow_tool',
        description: 'A tool that takes 60 seconds to complete (simulates code analysis)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'fast_tool',
        description: 'A tool that returns immediately',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name as string;
  const requestId = (request as any).id;

  console.log(`[tools/call] Request ${requestId}: ${toolName} started`);
  activeRequests.set(requestId, { startTime: Date.now(), toolName });

  try {
    if (toolName === 'slow_tool') {
      // Simulate long-running operation (e.g., code analysis)
      console.log(`[tools/call] Request ${requestId}: slow_tool running (60s)...`);
      
      // Check every 5 seconds if we're still connected
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log(`[tools/call] Request ${requestId}: still running... (${(i + 1) * 5}s elapsed)`);
      }
      
      console.log(`[tools/call] Request ${requestId}: slow_tool completed!`);
      return {
        content: [
          {
            type: 'text',
            text: `slow_tool completed after 60 seconds (request ${requestId})`,
          },
        ],
      };
    } else if (toolName === 'fast_tool') {
      // Fast tool returns immediately
      console.log(`[tools/call] Request ${requestId}: fast_tool completed immediately`);
      return {
        content: [
          {
            type: 'text',
            text: `fast_tool completed (request ${requestId})`,
          },
        ],
      };
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }
  } finally {
    activeRequests.delete(requestId);
    console.log(`[tools/call] Request ${requestId}: handler finished`);
  }
});

// Create transport with debugging
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless mode (like production)
});

// Patch transport to add debugging
const originalHandleRequest = transport.handleRequest.bind(transport);
transport.handleRequest = async function (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) {
  console.log(`\n[HTTP] ${req.method} ${req.url}`);
  
  // Track connection close
  res.on('close', () => {
    console.log(`[HTTP] Connection closed`);
    console.log(`[DEBUG] Active requests still running:`, Array.from(activeRequests.keys()));
    
    // Access private fields for debugging (this is just for demonstration)
    const _requestToStreamMapping = (transport as any)._requestToStreamMapping;
    const _requestResponseMap = (transport as any)._requestResponseMap;
    
    console.log(`[DEBUG] _requestToStreamMapping size:`, _requestToStreamMapping.size);
    console.log(`[DEBUG] _requestToStreamMapping entries:`, Array.from(_requestToStreamMapping.entries()));
    console.log(`[DEBUG] _requestResponseMap size:`, _requestResponseMap.size);
    
    if (_requestToStreamMapping.size > 0) {
      console.warn('⚠️  WARNING: Stale mappings detected! These should have been cleaned up.');
    }
  });
  
  return originalHandleRequest(req, res, parsedBody);
};

// Connect server to transport
await server.connect(transport);
console.log('[Server] MCP Server connected to transport');

// Create HTTP server
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/mcp' && req.method === 'POST') {
    await transport.handleRequest(req, res);
  } else if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeRequests: Array.from(activeRequests.entries()).map(([id, info]) => ({
        requestId: id,
        toolName: info.toolName,
        elapsedMs: Date.now() - info.startTime,
      })),
      // Debug info
      mappingSize: (transport as any)._requestToStreamMapping.size,
      responseMapSize: (transport as any)._requestResponseMap.size,
    }, null, 2));
  } else if (req.url === '/debug' && req.method === 'GET') {
    // Debug endpoint to inspect internal state
    const _requestToStreamMapping = (transport as any)._requestToStreamMapping;
    const _requestResponseMap = (transport as any)._requestResponseMap;
    const _streamMapping = (transport as any)._streamMapping;
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      streamMapping: {
        size: _streamMapping.size,
        keys: Array.from(_streamMapping.keys()),
      },
      requestToStreamMapping: {
        size: _requestToStreamMapping.size,
        entries: Array.from(_requestToStreamMapping.entries()),
      },
      requestResponseMap: {
        size: _requestResponseMap.size,
        keys: Array.from(_requestResponseMap.keys()),
      },
      activeRequests: Array.from(activeRequests.entries()).map(([id, info]) => ({
        requestId: id,
        toolName: info.toolName,
        elapsedMs: Date.now() - info.startTime,
      })),
    }, null, 2));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n\nAvailable endpoints:\n  POST /mcp - MCP endpoint\n  GET /health - Health check\n  GET /debug - Debug info');
  }
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Reproduction server started on http://localhost:${PORT}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  POST /mcp     - MCP endpoint`);
  console.log(`  GET  /health  - Health check with active requests`);
  console.log(`  GET  /debug   - Debug internal state`);
  console.log(`\nTo reproduce the issue, run: npx tsx reproduce-test.ts\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  httpServer.close();
  process.exit(0);
});

