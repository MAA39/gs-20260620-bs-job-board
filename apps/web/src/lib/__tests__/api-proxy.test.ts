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

  test('preserves POST method and body is readable upstream', async () => {
    let receivedBody = '';
    const api = fakeApi(async (_url, init) => {
      if (init?.body) {
        // body が ReadableStream の場合も対応
        if (typeof init.body === 'string') {
          receivedBody = init.body;
        } else {
          receivedBody = await new Response(init.body).text();
        }
      }
      return new Response(JSON.stringify({ received: true }), { status: 201 });
    });
    const payload = JSON.stringify({ title: 'test', body: 'hello' });
    const request = makeRequest('/api/v1/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const response = await proxyApiRequest(request, api, 'v1/threads');
    expect(response.status).toBe(201);
    expect(receivedBody).toBe(payload);
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

  test('preserves single Set-Cookie from upstream', async () => {
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

  test('preserves multiple Set-Cookie values individually', async () => {
    const api = fakeApi(() => {
      const headers = new Headers();
      headers.append('Set-Cookie', 'token=aaa; Path=/; HttpOnly');
      headers.append('Set-Cookie', 'csrf=bbb; Path=/; SameSite=Strict');
      headers.append('Content-Type', 'application/json');
      return new Response('ok', { status: 200, headers });
    });
    const request = makeRequest('/api/auth/sign-in');
    const response = await proxyApiRequest(request, api, 'auth/sign-in');
    // 複数 Set-Cookie が返されること（環境によって結合されるが、少なくとも両方の値を含む）
    const cookies = response.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('token=aaa');
    expect(cookies).toContain('csrf=bbb');
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

  test('sets X-Forwarded-Host and X-Forwarded-Proto', async () => {
    let headers: Headers | undefined;
    const api = fakeApi((_url, init) => {
      headers = new Headers(init?.headers);
      return new Response('ok');
    });
    const request = makeRequest('/api/v1/threads');
    await proxyApiRequest(request, api, 'v1/threads');
    expect(headers?.get('x-forwarded-host')).toBe('web.example.com');
    expect(headers?.get('x-forwarded-proto')).toBe('https');
  });

  test('passes through SSE content-type without buffering', async () => {
    const sseBody = 'data: {"status":"generating"}\n\ndata: {"status":"completed"}\n\n';
    const api = fakeApi(() => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    });
    const request = makeRequest('/api/v1/ai-runs/123/events');
    const response = await proxyApiRequest(request, api, 'v1/ai-runs/123/events');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    // body がそのまま返されること（buffer parse されていない）
    const text = await response.text();
    expect(text).toBe(sseBody);
  });

  test('upstream fetch throw → proxyApiRequest throws (caller handles 503)', async () => {
    const api = {
      fetch: vi.fn(() => Promise.reject(new Error('Service Binding unavailable'))),
    };
    const request = makeRequest('/api/v1/threads');
    // proxyApiRequest 自体は throw する。503 は route 側の責務。
    await expect(proxyApiRequest(request, api, 'v1/threads')).rejects.toThrow();
  });
});
