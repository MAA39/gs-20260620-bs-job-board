/**
 * Better Auth — Kysely adapter + D1 + anonymous plugin
 * Drizzle adapter はD1で500エラー（未解決）。Kyselyは動作確認済み。
 * アプリケーションCRUDは今後Drizzleに移行可能。
 */
import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';

export function createAuth(d1: D1Database, config: { secret: string; baseURL: string }) {
  const db = new Kysely({ dialect: new D1Dialect({ database: d1 }) });

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [
      'https://bs-job-board-web.masa-nekoshinshi39.workers.dev',
      'http://localhost:5173',
    ],
    database: {
      db: db as any,
      type: 'sqlite',
    },
    plugins: [
      anonymous(),
    ],
  });
}

/**
 * リクエストからBetter Authのセッションを取得する
 * cookieまたはAuthorizationヘッダーからtokenを解決
 *
 * #29: 例外を握り潰さず、auth_misconfigured / auth_failure / missing_session を区別する
 */

export type SessionResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; reason: 'missing_session' }
  | { ok: false; reason: 'auth_misconfigured' }
  | { ok: false; reason: 'auth_failure' };

export function getSessionResult(
  d1: D1Database,
  secret: string | undefined,
  baseURL: string,
  request: Request,
): Promise<SessionResult> {
  if (!secret?.trim()) {
    return Promise.resolve({ ok: false, reason: 'auth_misconfigured' });
  }

  return (async (): Promise<SessionResult> => {
    try {
      const auth = createAuth(d1, { secret, baseURL });
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user) {
        return { ok: true, user: { id: session.user.id, name: session.user.name } };
      }
      return { ok: false, reason: 'missing_session' };
    } catch (error) {
      console.error('auth session lookup failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return { ok: false, reason: 'auth_failure' };
    }
  })();
}

/**
 * 後方互換: 既存のGET route用。sessionなしでもnullを返す。
 * mutation routeでは getSessionResult を直接使うこと。
 */
export async function getSessionUser(
  d1: D1Database,
  secret: string,
  baseURL: string,
  request: Request,
): Promise<{ id: string; name: string } | null> {
  const result = await getSessionResult(d1, secret, baseURL, request);
  return result.ok ? result.user : null;
}
