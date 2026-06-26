# Same-Origin Auth Runbook

> scope: #29 same-origin API proxy + auth fail-closed
> updated: 2026-06-26

## 設計原則

- ブラウザは API Worker 別 origin を直接呼ばない
- Better Auth cookie は Web same-origin `/api/auth/*` 経由で作成・取得する
- Safari third-party cookie に依存しない
- `localStorage` の UUID は認証根拠ではない
- mutation route（POST threads、POST posts）は server session 必須

## Deploy 前 Smoke Test

1. **anonymous sign-in → Set-Cookie 確認**
   - ブラウザ DevTools Network tab
   - `/api/auth/sign-in/anonymous` へのリクエストが same-origin であること
   - Response に `Set-Cookie: better-auth.session_token=...` があること

2. **reload 後に session 維持確認**
   - sign-in 後にページをリロード
   - cookie が保持されていること

3. **投稿成功確認**
   - 新規スレッド作成 → 201
   - コメント投稿 → 201 + AI run 開始

4. **sign-in 失敗時に local UUID が作られないことを確認**
   - DevTools Console で `localStorage.getItem('bs-auth-user-id')` が null
   - Network tab で API Worker 別 origin へのリクエストがないこと

5. **Network tab で API Worker 別 origin を直接叩いていないことを確認**
   - `bs-job-board-api.masa-nekoshinshi39.workers.dev` への直接リクエストがゼロ
