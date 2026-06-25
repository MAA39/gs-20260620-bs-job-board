declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    INTERNAL_CALLBACK_KEY: string;
    BETTER_AUTH_SECRET: string;
    AGENT: { fetch: typeof fetch };
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
