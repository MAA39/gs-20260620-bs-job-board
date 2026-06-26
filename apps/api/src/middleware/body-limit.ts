import { bodyLimit } from 'hono/body-limit';

// ── ADR-006: route別bodyLimit上限値 ─────────────────────
export const BODY_LIMITS = {
  /** POST /api/v1/threads, POST /api/v1/threads/:id/posts — title/body(日本語UTF-8 3B/文字) + JSON overhead */
  publicLarge: 10 * 1024,
  /** POST /api/v1/threads/:id/react, PATCH /api/v1/threads/:id — 小さいJSON or bodyなし */
  publicSmall: 1024,
  /** POST /api/auth/** — anonymous sign-in 等 */
  auth: 10 * 1024,
  /** internal generating/repairing — ほぼ空 */
  internalSmall: 1024,
  /** internal complete — ADR-005: 最大5件×500文字 + usage + meta */
  internalComplete: 20 * 1024,
  /** internal fail — errorCode + message */
  internalFail: 2 * 1024,
} as const;

/** JSON 413 を返す bodyLimit middleware factory */
export const jsonBodyLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: 'payload too large' }, 413),
  });
