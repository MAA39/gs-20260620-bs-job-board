import { createAuthClient } from 'better-auth/client';
import { anonymousClient } from 'better-auth/client/plugins';

/**
 * Better Auth client — same-origin 設定
 *
 * baseURL を省略すると、Better Auth client は same-origin の
 * /api/auth/* にリクエストを送る。
 * Web Worker の /api/* proxy 経由で API Worker の auth handler へ到達する。
 *
 * 以前は API Worker の別 origin を直書きしていたが、
 * Safari ITP で third-party cookie がブロックされるため、
 * same-origin reverse proxy 方式へ移行した（#29）。
 */
export const authClient = createAuthClient({
  plugins: [anonymousClient()],
});
