/**
 * /api/* catch-all Server Route
 *
 * ブラウザからの /api/* リクエストを Service Binding 経由で
 * API Worker へ転送する。React コンポーネントは持たない。
 */
import { createFileRoute } from '@tanstack/react-router';
import { proxyApiRequest } from '../../lib/api-proxy';

async function proxy({
  request,
  params,
}: {
  request: Request;
  params: { _splat: string };
}): Promise<Response> {
  try {
    const { env } = (await import('cloudflare:workers')) as unknown as {
      env: { API: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> } };
    };

    if (!env?.API) {
      return new Response(
        JSON.stringify({ error: 'API service unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return await proxyApiRequest(request, env.API, params._splat);
  } catch (error) {
    console.error('API proxy error', {
      name: error instanceof Error ? error.name : 'Unknown',
    });
    return new Response(
      JSON.stringify({ error: 'API service unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: proxy,
      POST: proxy,
      PUT: proxy,
      PATCH: proxy,
      DELETE: proxy,
      OPTIONS: proxy,
    },
  },
});
