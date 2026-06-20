/**
 * Better Auth — Drizzle adapter + D1 + anonymous plugin
 * aimani-chat の auth.ts パターンを踏襲。
 * Workers: リクエストごとにインスタンス生成（シングルトンNG）。
 */
import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';

export function createAuth(d1: D1Database, config: { secret: string; baseURL: string }) {
  const db = drizzle(d1);

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [
      'https://bs-job-board-web.masa-nekoshinshi39.workers.dev',
      'http://localhost:5173',
    ],
    database: drizzleAdapter(db, {
      provider: 'sqlite',
    }),
    plugins: [
      anonymous(),
    ],
  });
}
