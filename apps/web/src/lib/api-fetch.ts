/**
 * apiFetch — Web serverFn → API Worker 呼び出しヘルパー
 *
 * Service Binding (env.API) を使い、必要に応じて
 * incoming request の Cookie/Authorization を転送する。
 *
 * #29: mutation 系 serverFn では forwardAuth: true で使う。
 *      GET 系 public route では省略可。
 */

type ApiFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Service Binding または localhost fallback の API fetch 関数を返す。
 *
 * @param options.cookie  - 転送する Cookie header 値
 * @param options.authorization - 転送する Authorization header 値
 */
export async function getApi(options?: {
  cookie?: string | null;
  authorization?: string | null;
}): Promise<ApiFn> {
  const injectAuth = (init?: RequestInit): RequestInit => {
    if (!options?.cookie && !options?.authorization) return init ?? {};
    const headers = new Headers(init?.headers);
    if (options.cookie) headers.set('cookie', options.cookie);
    if (options.authorization) headers.set('authorization', options.authorization);
    return { ...init, headers };
  };

  try {
    const { env } = (await import('cloudflare:workers')) as unknown as {
      env: { API: { fetch: typeof fetch } };
    };
    return (url: string, init?: RequestInit) =>
      env.API.fetch(`https://api${url}`, injectAuth(init));
  } catch {
    return (url: string, init?: RequestInit) =>
      fetch(`http://localhost:8787${url}`, injectAuth(init));
  }
}

/**
 * serverFn handler 内で incoming request の auth headers を取得する。
 *
 * TanStack Start v1 では getRequest() from '@tanstack/react-start/server'
 * で元のブラウザリクエストにアクセスできる。
 */
export function getIncomingAuthHeaders(): {
  cookie: string | null;
  authorization: string | null;
} {
  try {
    // Dynamic import to avoid build errors in non-server contexts
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRequest } = require('@tanstack/react-start/server') as {
      getRequest: () => Request;
    };
    const request = getRequest();
    return {
      cookie: request.headers.get('cookie'),
      authorization: request.headers.get('authorization'),
    };
  } catch {
    return { cookie: null, authorization: null };
  }
}

/**
 * 認証ヘッダーを転送する API fetch 関数を返す。
 * mutation 系 serverFn で使う。
 */
export async function getAuthenticatedApi(): Promise<ApiFn> {
  const auth = getIncomingAuthHeaders();
  return getApi(auth);
}
