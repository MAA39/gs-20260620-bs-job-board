/**
 * proxyApiRequest — Web Worker → API Worker proxy helper
 *
 * Service Binding 経由でリクエストを転送する。
 * body/header/Set-Cookie/SSE stream を透過的に扱う。
 *
 * このファイルは Hono/TanStack/React に依存しない。
 * 単体テスト可能。
 */

/** hop-by-hop headers（proxy で除去すべきヘッダー） */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** API への転送対象として保持するリクエストヘッダー */
function buildUpstreamHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  // Host は upstream 側で決まるので除去
  out.delete('host');
  return out;
}

/** upstream Response から client 向け Response を組み立てる */
function buildDownstreamResponse(upstream: Response): Response {
  const headers = new Headers();
  // Set-Cookie は getSetCookie() で複数値を保持する
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.append(key, value);
    }
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * API proxy 本体
 *
 * @param request  - incoming browser request
 * @param api      - Service Binding (env.API)
 * @param splatPath - wildcard 以降のpath（例: "v1/threads"）
 */
export async function proxyApiRequest(
  request: Request,
  api: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> },
  splatPath: string,
): Promise<Response> {
  // upstream URL を組み立てる
  // Service Binding は任意の origin を受け付ける
  const url = new URL(request.url);
  const upstreamUrl = `https://api/api/${splatPath}${url.search}`;

  const upstreamHeaders = buildUpstreamHeaders(request.headers);

  // reverse proxy 標準ヘッダー: API 側が元の origin を復元できるようにする
  upstreamHeaders.set('x-forwarded-host', url.host);
  upstreamHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const upstreamInit: RequestInit = {
    method: request.method,
    headers: upstreamHeaders,
  };

  // body がある場合のみ転送（GET/HEAD は body を持たない）
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    upstreamInit.body = request.body;
    // @ts-expect-error -- Cloudflare Workers では duplex: 'half' が必要
    upstreamInit.duplex = 'half';
  }

  const upstream = await api.fetch(upstreamUrl, upstreamInit);
  return buildDownstreamResponse(upstream);
}
