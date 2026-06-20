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
 */
export async function getSessionUser(
  d1: D1Database,
  secret: string,
  baseURL: string,
  request: Request,
): Promise<{ id: string; name: string } | null> {
  try {
    const auth = createAuth(d1, { secret, baseURL });
    const session = await auth.api.getSession({ headers: request.headers });
    if (session?.user) {
      return { id: session.user.id, name: session.user.name };
    }
  } catch {}
  return null;
}
