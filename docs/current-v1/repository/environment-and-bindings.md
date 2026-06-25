# environment / binding 現行仕様

実値はこのドキュメントへ記載しない。ここでは環境変数名、Cloudflare binding名、用途だけを記録する。

## Web Worker

file:

```text
apps/web/wrangler.jsonc
```

### Service Binding

```text
API -> bs-job-board-api
```

### var

```text
API_BASE_URL
```

現行route implementationでは`API_BASE_URL`を参照せず、Service Binding import失敗時はコード内の`http://localhost:8787`へfallbackする。

### hard-coded origin

Better Auth client:

```text
https://bs-job-board-api.masa-nekoshinshi39.workers.dev
```

Web production originもAPI CORS / Better Auth trustedOriginsへhard-codeされている。

## API Worker

file:

```text
apps/api/wrangler.jsonc
```

### D1

```text
DB -> bs-job-board-db
```

### Service Binding

```text
AGENT -> bs-job-board-agent
```

### secret

```text
BETTER_AUTH_SECRET
```

`.dev.vars.example`にはplaceholderのみを置く。

Bindings型には`SAKURA_API_TOKEN`が残るが、現行API codeでは未使用で、wrangler varにも記載されない。

## Agent Worker

file:

```text
apps/agent/wrangler.jsonc
```

### D1

```text
DB -> bs-job-board-db
```

APIと同じapplication D1を共有する。

### Durable Objects

```text
FLUE_ANALYST_AGENT
FLUE_GENERATE_REPLIES_WORKFLOW
FLUE_REGISTRY
```

### secrets / vars

```text
SAKURA_API_TOKEN
SAKURA_BASE_URL
SAKURA_MODEL_ID
```

- API tokenは必須
- base URLとmodel IDはコードdefaultあり
- `.dev.vars.example`はplaceholderのみ

## environment separation

wrangler configにenvironment別sectionはない。

- staging / production別service名なし
- D1 database IDはconfigへ固定
- production originはcode/configへhard-code
- secret存在をdeploy前に検証するscriptなし

## local ports

README上の想定:

```text
Web    localhost:5173
API    localhost:8787
Agent  localhost:3583
```

## 認証境界

- API auth routeは`BETTER_AUTH_SECRET`未設定時503
- Agent workflow/run routeはhostname allow-list
- Service Binding用hostnameは`agent`
- internal callback keyはまだない
- public API thread routeはsession必須ではない

## credential運用

- actual credentialをGit、Issue、PR、CI logへ記録しない
- localは`.dev.vars`または`.env`系を使用
- productionはCloudflare Worker secretを使用
- `.gitignore`は`.env`、`.env.local`、`.dev.vars`、`.dev.vars.*`を除外し、example fileだけを再許可する
