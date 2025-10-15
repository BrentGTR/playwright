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

import { ChildProcess, spawn } from 'child_process';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test as baseTest, expect, mcpServerPath } from './fixtures';

const test = baseTest.extend<{ serverEndpoint: (options?: { args?: string[], noPort?: boolean }) => Promise<{ url: URL, stderr: () => string }> }>({
  serverEndpoint: async ({ mcpHeadless }, use, testInfo) => {
    let cp: ChildProcess | undefined;
    const userDataDir = testInfo.outputPath('user-data-dir');
    await use(async (options?: { args?: string[], noPort?: boolean }) => {
      if (cp)
        throw new Error('Process already running');

      cp = spawn('node', [
        ...mcpServerPath,
        ...(options?.noPort ? [] : ['--port=0']),
        '--user-data-dir=' + userDataDir,
        ...(mcpHeadless ? ['--headless'] : []),
        ...(options?.args || []),
      ], {
        stdio: 'pipe',
        env: {
          ...process.env,
          DEBUG: 'pw:mcp:test',
          DEBUG_COLORS: '0',
          DEBUG_HIDE_DATE: '1',
        },
      });
      let stderr = '';
      const url = await new Promise<string>(resolve => cp!.stderr?.on('data', data => {
        stderr += data.toString();
        const match = stderr.match(/Listening on (http:\/\/.*)/);
        if (match)
          resolve(match[1]);
      }));

      return { url: new URL(url), stderr: () => stderr };
    });
    cp?.kill('SIGTERM');
  },
});

test('http transport session cleanup with delayed deletion', async ({ serverEndpoint, server }) => {
  const { url, stderr } = await serverEndpoint({ args: ['--isolated'] });

  // Create first client and perform operations
  const transport1 = new StreamableHTTPClientTransport(new URL('/mcp', url));
  const client1 = new Client({ name: 'test', version: '1.0.0' });
  await client1.connect(transport1);

  // Perform multi-step operation that would fail with immediate cleanup
  await client1.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  // Take screenshot - this would fail with "Session not found" if cleanup was immediate
  await client1.callTool({
    name: 'browser_take_screenshot',
    arguments: {},
  });

  // Terminate session to trigger cleanup
  await transport1.terminateSession();
  await client1.close();

  // Wait for delayed cleanup to complete (5 seconds + buffer)
  await new Promise(resolve => setTimeout(resolve, 6000));

  // Verify that session was cleaned up after delay
  await expect(async () => {
    const lines = stderr().split('\n');

    // Should have created and deleted session
    expect(lines.filter(line => line.match(/create http session/)).length).toBe(1);
    expect(lines.filter(line => line.match(/delete http session/)).length).toBe(1);

    // Should have created and closed context
    expect(lines.filter(line => line.match(/create context/)).length).toBe(1);
    expect(lines.filter(line => line.match(/close context/)).length).toBe(1);

    // Should have created and closed browser context
    expect(lines.filter(line => line.match(/create browser context \(isolated\)/)).length).toBe(1);
    expect(lines.filter(line => line.match(/close browser context \(isolated\)/)).length).toBe(1);

    // Should have obtained and closed browser
    expect(lines.filter(line => line.match(/obtain browser \(isolated\)/)).length).toBe(1);
    expect(lines.filter(line => line.match(/close browser \(isolated\)/)).length).toBe(1);
  }).toPass();
});

test('http transport multi-step operations with session persistence', async ({ serverEndpoint, server }) => {
  const { url } = await serverEndpoint({ args: ['--isolated'] });

  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);

  // Perform multiple operations that require session persistence
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  // Wait a bit to simulate real-world usage
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Take screenshot - should work because session persists
  const screenshotResult = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: {},
  });

  expect(screenshotResult.isError).toBeFalsy();
  expect(screenshotResult.content?.[0]?.type).toBe('image');

  // Take another screenshot to verify continued persistence
  const screenshotResult2 = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: {},
  });

  expect(screenshotResult2.isError).toBeFalsy();
  expect(screenshotResult2.content?.[0]?.type).toBe('image');

  await transport.terminateSession();
  await client.close();
});

test('http transport session cleanup timing verification', async ({ serverEndpoint }) => {
  const { url, stderr } = await serverEndpoint({ args: ['--isolated'] });

  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });

  // Terminate session
  await transport.terminateSession();
  await client.close();

  const terminateTime = Date.now();

  // Wait for delayed cleanup
  await new Promise(resolve => setTimeout(resolve, 6000));

  const cleanupTime = Date.now();
  const timeDiff = cleanupTime - terminateTime;

  // Verify cleanup happened after delay (should be ~5-6 seconds)
  expect(timeDiff).toBeGreaterThan(5000);
  expect(timeDiff).toBeLessThan(7000);

  // Verify cleanup actually happened
  const finalStderr = stderr();
  const deleteLines = finalStderr.split('\n').filter(line => line.match(/delete http session/));
  expect(deleteLines.length).toBe(1);
});
