/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'assert';
import net from 'net';
import http from 'http';
import crypto from 'crypto';

import { debug } from 'playwright-core/lib/utilsBundle';

import * as mcpBundle from './bundle';
import * as mcpServer from './server';

import type { ServerBackendFactory } from './server';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const testDebug = debug('pw:mcp:test');

export async function startHttpServer(config: { host?: string, port?: number }, abortSignal?: AbortSignal): Promise<http.Server> {
  const { host, port } = config;
  const httpServer = http.createServer();
  decorateServer(httpServer);
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    abortSignal?.addEventListener('abort', () => {
      httpServer.close();
      reject(new Error('Aborted'));
    });
    httpServer.listen(port, host, () => {
      resolve();
      httpServer.removeListener('error', reject);
    });
  });
  return httpServer;
}

export function httpAddressToString(address: string | net.AddressInfo | null): string {
  assert(address, 'Could not bind server socket');
  if (typeof address === 'string')
    return address;
  const resolvedPort = address.port;
  let resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
  if (resolvedHost === '0.0.0.0' || resolvedHost === '[::]')
    resolvedHost = 'localhost';
  return `http://${resolvedHost}:${resolvedPort}`;
}

export async function installHttpTransport(httpServer: http.Server, serverBackendFactory: ServerBackendFactory, unguessableUrl: boolean, allowedHosts?: string[]) {
  const url = httpAddressToString(httpServer.address());
  const host = new URL(url).host;
  allowedHosts = (allowedHosts || [host]).map(h => h.toLowerCase());
  const allowAnyHost = allowedHosts.includes('*');
  const pathPrefix = unguessableUrl ? `/${crypto.randomUUID()}` : '';

  const sseSessions = new Map();
  const streamableSessions = new Map();
  httpServer.on('request', async (req, res) => {
    if (!allowAnyHost) {
      const host = req.headers.host?.toLowerCase();
      if (!host) {
        res.statusCode = 400;
        return res.end('Missing host');
      }

      // Prevent DNS evil.com -> localhost rebind.
      if (!allowedHosts.includes(host)) {
        // Access from the browser is forbidden.
        res.statusCode = 403;
        return res.end('Access is only allowed at ' + allowedHosts.join(', '));
      }
    }

    if (!req.url?.startsWith(pathPrefix)) {
      res.statusCode = 404;
      return res.end('Not found');
    }

    const path = req.url?.slice(pathPrefix.length);
    const url = new URL(`http://localhost${path}`);
    if (url.pathname === '/killkillkill' && req.method === 'GET') {
      res.statusCode = 200;
      res.end('Killing process');
      // Simulate Ctrl+C in a way that works on Windows too.
      process.emit('SIGINT');
      return;
    }
    if (url.pathname.startsWith('/sse'))
      await handleSSE(serverBackendFactory, req, res, url, sseSessions);
    else
      await handleStreamable(serverBackendFactory, req, res, streamableSessions);
  });

  // Cleanup pending timeouts on server shutdown to prevent memory leaks
  httpServer.on('close', () => {
    // Clear all pending cleanup timeouts
    for (const transport of streamableSessions.values()) {
      const timeout = (transport as any).cleanupTimeout;
      if (timeout)
        clearTimeout(timeout);

    }
    streamableSessions.clear();
    sseSessions.clear();
  });

  return `${url}${pathPrefix}`;
}

async function handleSSE(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sessions: Map<string, SSEServerTransport>) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      return res.end('Session not found');
    }

    return await transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    const transport = new mcpBundle.SSEServerTransport('/sse', res);
    sessions.set(transport.sessionId, transport);
    testDebug(`create SSE session: ${transport.sessionId}`);
    await mcpServer.connect(serverBackendFactory, transport, false);
    res.on('close', () => {
      testDebug(`delete SSE session: ${transport.sessionId}`);
      sessions.delete(transport.sessionId);
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamable(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    return await transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new mcpBundle.StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async sessionId => {
        testDebug(`create http session: ${transport.sessionId}`);
        await mcpServer.connect(serverBackendFactory, transport, true);
        sessions.set(sessionId, transport);
      }
    });

    // Use delayed cleanup to prevent premature session deletion
    // This allows multi-step operations to complete while still cleaning up resources
    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      const sessionId = transport.sessionId; // Capture sessionId for closure
      const cleanupDelay = parseInt(process.env.PLAYWRIGHT_MCP_SESSION_CLEANUP_DELAY || '5000', 10) || 5000;

      // Store timeout reference for cleanup on server shutdown
      const cleanupTimeout = setTimeout(() => {
        try {
          if (sessions.has(sessionId)) {
            sessions.delete(sessionId);
            testDebug(`delete http session: ${sessionId}`);
          }
        } catch (error) {
          testDebug(`error during session cleanup: ${error}`);
        }
      }, cleanupDelay);

      // Store timeout reference on transport for cleanup
      (transport as any).cleanupTimeout = cleanupTimeout;
    };

    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

function decorateServer(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const close = server.close;
  server.close = (callback?: (err?: Error) => void) => {
    for (const socket of sockets)
      socket.destroy();
    sockets.clear();
    return close.call(server, callback);
  };
}
