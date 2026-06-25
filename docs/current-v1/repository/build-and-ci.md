# repository build / CI 現行仕様

## workspace

package manager:

```text
pnpm 9.15.0
```

workspace glob:

```yaml
packages:
  - apps/*
  - packages/*
```

monorepo task runner: Turborepo。

## root scripts

```json
{
  "dev": "turbo dev",
  "build": "turbo build",
  "typecheck": "turbo typecheck",
  "probe:flue-stream": "node scripts/probe-flue-stream.mjs"
}
```

rootに`test`、`test:integration`、`lint`、`format` scriptはない。

## Turbo task

### `build`

- dependency packageの`build`へ依存
- cache output: `dist/**`, `.output/**`

build scriptを持つworkspaceのみ実行される。

現状:

- `apps/web`: Vite build
- `apps/api`: Wrangler dry-run
- `apps/agent`: Flue Cloudflare build

`packages/contracts`、`packages/db`、`packages/agent`、`packages/config`にはbuild scriptがない。

APIのWrangler dry-runはTurbo指定のoutputを残さないため、`no output files found` warningが出る場合がある。exit codeが0ならbuild自体は成功。

### `dev`

- cache disabled
- persistent task

### `typecheck`

- upstream packageの`build`へ依存
- 各workspaceの`typecheck` scriptを実行

## GitHub Actions

file:

```text
.github/workflows/ci.yml
```

trigger:

- pull request
- main push

permissions:

```text
contents: read
```

concurrency:

```text
group: workflow + ref
cancel-in-progress: true
```

同じrefへ新しいcommitがpushされると古いCI runはcancelされる。ログ末尾の`The operation was canceled`は、先行stepが成功していても表示される場合がある。

## CI steps

1. checkout（commit SHA固定）
2. checkout credential persistence無効
3. Node 22.19.0 setup（commit SHA固定）
4. corepack enable
5. pnpm 9.15.0 activate
6. `pnpm install --frozen-lockfile`
7. Turbo typecheck
8. failure時typecheck log artifact upload
9. Turbo build
10. probe script syntax check
11. AI route architecture guards

## typecheck log

Turbo outputを`typecheck.log`へ保存し、終了codeを保持したまま内容を表示する。

failure時は`typecheck-log` artifactとしてuploadする。

## AI route guards

対象:

- `apps/api`
- `apps/agent/src/workflows`

除外:

- node_modules
- dist
- `.flue-vite`
- `.wrangler`

禁止検出:

- source上の直接`fetch(`
- `chat/completions`
- `reasoning_content`

このguardはproduction AI entrypointの再二重化を防ぐが、`packages/agent`のlegacy direct fetchは対象外。

## 現在CIで確認しないもの

- unit test
- D1 integration test
- migration apply
- deployed Worker smoke test
- Service Binding疎通
- actual Flue stream
- Sakura provider疎通
- browser E2E
- lint / format
- secret configuration

## deploy script

```text
Web    wrangler deploy
API    wrangler deploy
Agent  flue deploy
```

root一括deploy scriptはない。

## 既知の差分・負債

- test task未導入
- package build contractが不統一
- API dry-run outputとTurbo cache設定が不一致
- architecture guardがlegacy `packages/agent`を見ない
- production deploy workflowなし
- migration CIなし
- environment別configuration検証なし
