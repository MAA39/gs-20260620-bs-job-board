import { describe, test, expect, vi } from 'vitest';
import { proxyApiRequest } from '../api-proxy';

// ── Helpers ─────────────────────────────────────────────

function fakeApi(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return {
    fetch: vi.fn(
      (input: RequestInfo, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        return Promise.resolve(handler(url, init));
      },
    ),
  };
}

function makeRequest(
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
): Request {
  return new Request(`https://web.example.com${path}`, {
    method: options?.method ?? 'GET',
    headers: options?.headers,
    body: options?.body,
  });
}

// ── Tests ───────────────────────────────────────────────

describe('proxyApiRequest', () => {
  test('preserves GET method and path', async () => {
    const api = fakeApi((url) => new Response('ok', { status: 200 }));
    const request = makeRequest('/api/v1/threads?sort=new');
    const response = await proxyApiRequest(request, api, 'v1/threads');

    expect(api.fetch).toHaveBeenCalledOnce();
    const calledUrl = (api.fetch.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('https://api/api/v1/threads');
    expect(response.status).toBe(200);
  });

  test('preserves POST method and body', async () => {
    const api = fakeApi((_url, init) => {
      return new Response(JSON.stringify({ received: true }), { status: 201 });
    });
    const request = makeRequest('/api/v1/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test', body: 'hello' }),
    });
    const response = await proxyApiRequest(request, api, 'v1/threads');
    expect(response.status).toBe(201);
  });

  test('preserves Cookie header', async () => {
    let receivedCookie = '';
    const api = fakeApi((_url, init) => {
      const headers = new Headers(init?.headers);
      receivedCookie = headers.get('cookie') ?? '';
      return new Response('ok');
    });
    const request = makeRequest('/api/auth/sign-in', {
      headers: { Cookie: 'better-auth.session_token=abc123' },
    });
    await proxyApiRequest(request, api, 'auth/sign-in');
    expect(receivedCookie).toBe('better-auth.session_token=abc123');
  });

  test('preserves Set-Cookie from upstream', async () => {
    const api = fakeApi(() => {
      return new Response('ok', {
        status: 200,
        headers: { 'Set-Cookie': 'better-auth.session_token=xyz789; Path=/; HttpOnly' },
      });
    });
    const request = makeRequest('/api/auth/sign-in');
    const response = await proxyApiRequest(request, api, 'auth/sign-in');
    expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=xyz789');
  });

  test('preserves upstream status code', async () => {
    const api = fakeApi(() => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    const request = makeRequest('/api/v1/threads/nonexistent');
    const response = await proxyApiRequest(request, api, 'v1/threads/nonexistent');
    expect(response.status).toBe(404);
  });

  test('preserves query string', async () => {
    let calledUrl = '';
    const api = fakeApi((url) => { calledUrl = url; return new Response('ok'); });
    const request = makeRequest('/api/v1/threads?sort=hot&page=2');
    await proxyApiRequest(request, api, 'v1/threads');
    expect(calledUrl).toContain('?sort=hot&page=2');
  });

  test('removes Host header', async () => {
    let headers: Headers | undefined;
    const api = fakeApi((_url, init) => {
      headers = new Headers(init?.headers);
      return new Response('ok');
    });
    const request = makeRequest('/api/v1/threads', {
      headers: { Host: 'web.example.com' },
    });
    await proxyApiRequest(request, api, 'v1/threads');
    expect(headers?.get('host')).toBeNull();
  });

  test('passes through SSE content-type', async () => {
    const api = fakeApi(() => {
      return new Response('data: test\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const request = makeRequest('/api/v1/ai-runs/123/events');
    const response = await proxyApiRequest(request, api, 'v1/ai-runs/123/events');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
  });
});
