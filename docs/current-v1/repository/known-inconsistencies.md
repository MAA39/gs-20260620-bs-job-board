# 現行コード内の不一致・dead path

このページは移行計画ではなく、同じmainブランチ内で仕様が一致していない箇所を記録する。

## 1. READMEのデータフローが旧仕様

root READMEは以下を記載する。

```text
API -> Agent POST /dispatch-analysis
Agent -> API tool経由でpost保存
```

現行コードは以下。

```text
API -> Agent POST /workflows/generate-replies
Agent -> application D1へ直接AI post保存
```

## 2. Webに削除済み`/ai-stream` clientが残る

API側の生成兼stream routeは削除済みだが、thread detailには以下が残る。

- `startAiStream()`
- `streamThinking`
- `streamContent`
- `streamSourceNum`
- `reasoning_content` parser

通常UIから呼ばれないためdead path。

## 3. reaction response field不一致

DB/API:

```json
{"reacted":true,"count":1}
```

Webの型注釈・参照:

```json
{"reacted":true,"reaction_count":1}
```

Webは`r.reaction_count`をthread stateへ代入するため、操作後にcountがundefinedになる可能性がある。

## 4. anonymous auth fallbackが画面ごとに異なる

### Home

- Better Auth responseにuserがない場合はbrowser UUID fallback
- `signIn.anonymous()`自体がthrowした場合のcatchはない

### Thread detail

- responseにuserがない場合もthrowした場合もbrowser UUID fallback

同じ認証操作で挙動が一致しない。

## 5. Better Auth sessionとServer Function API callが接続していない

- auth clientはpublic API originへ直接アクセス
- thread/post操作はWeb Worker Server Function -> Service Binding
- Server Functionはbrowser request cookieをAPI requestへ転送しない

localStorage上は認証済みでも、API `getSessionUser()`はnullになる可能性がある。

## 6. `packages/agent`とAgent workflowが二重実装

### production path

```text
apps/agent/src/workflows/generate-replies.ts
Flue session.prompt()
```

### legacy package

```text
packages/agent/src/analyze.ts
Sakura API direct fetch
```

legacy packageは現在参照されないが、非公開生成本文のlog/returnを含む。

## 7. Flue probeとrun route公開設定

- probeは`streamUrl` / `/runs/:id`を読む
- appは`/runs/*`へhostname middlewareを設定
- workflow moduleは`route`をexportするが`runs`をexportしない

Flue versionのHTTP公開契約上、run streamが明示公開されていない可能性がある。

## 8. `API_BASE_URL` varが未使用

Web wrangler configに`API_BASE_URL`があるが、route codeは参照しない。

- production: Service Binding
- fallback: hard-coded localhost API
- auth: hard-coded production API URL

API locationの設定元が3つに分かれる。

## 9. API packageのstale項目

- API `Bindings`型に`SAKURA_API_TOKEN`
- API package dependencyに`@bs-job-board/agent`

現行API routeはどちらも使用しない。

## 10. AI context仕様と望ましい会話仕様が一致しない

現行workflowはthread内の直近8postだけをpromptへ入れる。

保証されないもの:

- thread root
- source post中心の会話枝
- AIの質問とhuman回答のpair
- 既出観点
- semantic relevance

直近8件は現在の実装値であり、製品回答仕様として確定していない。

## 11. thinking除外条件が一致しない

- Agent履歴取得: `author_name != '🤔 AIの思考'`
- Web表示: `role === 'thinking'`

roleだけthinkingのpostや、author名だけlegacy thinkingのpostで挙動が変わる。

## 12. write authorityがREADME表現と一致しない

READMEではAPIがD1 holder/正本管理とされるが、現行Agent Workerにも同じD1 bindingがあり、AI postを書き込む。
