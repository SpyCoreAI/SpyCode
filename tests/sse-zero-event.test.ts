import { describe, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamWithRetry } from '../src/lib/sse.js';

/**
 * R3-1 - local-server repro, like the reviewer's: a 302 redirect and a
 * 200 text/html body both yield zero SSE events and end cleanly. Both used
 * to burn the whole retry budget and then resolve silently as success.
 * No mocks here - the real undici `request` against a real local server.
 */

function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string; count: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/api/x`, count: () => count });
    });
  });
}

describe('R3-1 · zero-event streams fail loudly', () => {
  test('a 302 throws at once (no retry burn) instead of resolving silently', async () => {
    const { server, url, count } = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1/other' });
      res.end();
    });
    try {
      await expect(
        streamWithRetry({ url, headers: {}, onEvent: () => {} }),
      ).rejects.toThrow(/redirected/i);
      expect(count()).toBe(1);
    } finally {
      server.close();
    }
  });

  test('a 200 non-SSE body throws once the retry budget is spent', async () => {
    const { server, url, count } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>not an event stream</body></html>');
    });
    try {
      const seen: unknown[] = [];
      await expect(
        streamWithRetry({
          url,
          headers: {},
          maxRetries: 1,
          onEvent: (e) => {
            seen.push(e);
          },
        }),
      ).rejects.toThrow(/without receiving any events/i);
      expect(seen).toHaveLength(0);
      expect(count()).toBe(2);
    } finally {
      server.close();
    }
  });

  test('a stream that delivers >= 1 event and ends cleanly still resolves', async () => {
    const { server, url, count } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"text","content":"hi"}\n\n');
    });
    try {
      const seen: unknown[] = [];
      await streamWithRetry({
        url,
        headers: {},
        maxRetries: 0,
        onEvent: (e) => {
          seen.push(e);
        },
      });
      expect(seen).toHaveLength(1);
      expect(count()).toBe(1);
    } finally {
      server.close();
    }
  });
});
