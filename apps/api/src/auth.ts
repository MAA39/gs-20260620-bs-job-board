/**
 * Better Auth設定 — D1 + Kysely + anonymous plugin
 * Workers環境: リクエストごとにインスタンス生成（シングルトンNG）
 */
import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';

export function createAuth(db: D1Database, config: { secret: string; baseURL: string }) {
  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [
      'https://bs-job-board-web.masa-nekoshinshi39.workers.dev',
      'http://localhost:5173',
    ],
    database: {
      db: db as any,
      type: 'sqlite' as const,
    },
    plugins: [
      anonymous(),
    ],
  });
}
