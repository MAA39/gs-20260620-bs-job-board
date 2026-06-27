# うまくいかなかったこと

開発中に遭遇した問題と、それぞれの原因・対処・教訓を記録する。

## 1. 分析ロール3種を作って全廃した（2時間の手戻り）

「整理班」「構造分析ニキ」「変換提案マン」の3つのAI分析ロールを実装した。
投稿に対して3つの視点から分析レスを返す構成。

フィードバックで全廃した。
理由は「判断しない。材料を並べる。選ぶのは本人」という設計原則に反していたから。
分析ロールは名前からして「分析する側」になっており、投稿者の言葉を上書きする構造になっていた。

**原因**: 本業プロダクト（アイマニAI）のLinearに蓄積された8つの設計ドキュメントを事前に読まなかった。
読んでいれば、分析ロール方式は採用しなかった。

**教訓**: 手を動かす前に、既存の設計資産を調査する。ADRを実装前に策定する。

## 2. AIの出力ノイズに3つのフィルタを試した（2時間の手戻り）

さくらAI Engine（gpt-oss-120b）はreasoningモデルで、`content`に英語の思考過程が混入することがあった。
この混入を除去するために3つの戦略を順に試した。

1. 日本語行フィルタ → 英語混じりの行を通してしまう
2. 引用符抽出 → モデルの出力形式に依存して不安定
3. `response_format: {"type": "json_object"}` → 根本解決

`response_format`を最初から使っていれば、1と2は不要だった。
パラメータ1つの追加で、`content`に純粋なJSON、`reasoning_content`に思考過程が分離された。

**原因**: さくらAI EngineのAPIドキュメントを事前に通読していなかった。

**教訓**: APIのcapabilityは実装前に全て把握する。

## 3. Better AuthのDrizzle adapterがD1で500を返す

本業ではDrizzle ORMを使っている。Better AuthにもDrizzle adapterがある。
Drizzle adapterでD1に接続したところ、500エラー。レスポンスボディは空。

3パターン試して全て500。エラーメッセージなし。原因は特定できなかった。

Kyselyに切り替えたら一発で動いた。
Better Auth + D1の実績はKyselyの方が多い。

**対処**: 認証レイヤーだけKyselyを使う。アプリケーションCRUDは引き続きD1のprepare/bindで直接書く。

**教訓**: 「本業のスタックと揃える」ことと「今動くものを選ぶ」ことのバランスを判断する。

## 4. contextWindow: 0 で全AI生成が失敗

Agent WorkerのFlueプロバイダー登録で、contextWindowに0を設定していた。

```typescript
models: { [modelId]: { contextWindow: 0, maxTokens: 1_500 } },
```

gpt-oss-120bの実際のcontext windowは128,000 tokens。
0を渡すとFlueは「不明」と解釈し、proactive compaction（コンテキスト圧縮）を行わない。

本番デプロイ後、投稿しても一切AIレスが返らない状態になった。
SSEが正しくfailedイベントを配信していたため、エラーコード（AI_OUTPUT_INVALID）からAgent側の問題だと特定できた。

修正は1行。

```typescript
models: { [modelId]: { contextWindow: 128_000, maxTokens: 1_500 } },
```

**教訓**: 1つの設定値が全体を止めることがある。SSE等のオブザーバビリティが原因特定を可能にした。

## 5. AI出力のvalidationが厳しすぎて失敗率25%

デプロイ後、8回の投稿中2回がAI_OUTPUT_INVALIDで失敗した。

当初のvalidation条件:
- 3件ちょうど
- 各5-200文字
- 全件ユニーク
- 疑問符が全体で最大1つ

さくらAI Engineは指示通り3件返そうとするが、2件や4件になることがある。
「わかる」（3文字）のような短いレスも返す。疑問符を2つ使うこともある。

ADR-005で以下に緩和した。
- 件数: 1-5件
- 文字数: 1-500文字
- ユニーク制約: 撤廃
- 疑問符制約: 撤廃

さらに、repair後も失敗したらフォールバックレスで続行する仕組みを追加した。

```typescript
const FALLBACK_REPLIES = [
  'ちょっと拾いきれんかったわ。もう少し具体例あるとレスしやすい気がする。',
];
```

修正後は20件連続投稿で全て成功。失敗率25%→0%。

**教訓**: validationの仕様を削るのが最速。「3件ちょうど」を要求するより「1-5件なら受け入れる」方が、ユーザー体験も品質も上がる。

## 6. wrangler v4でdeployしたのに反映されない

`wrangler deploy`が成功してVersion IDも発行される。
しかしブラウザで確認すると古いコードのまま。

wrangler v4からCloudflare WorkersにGradual Deploymentsが導入された。
`wrangler deploy`はアップロード+Version作成だけで、trafficが切り替わらない場合がある。
Durable Objectsを持つWorkerで発生しやすい。

対処:

```bash
npx wrangler deploy
npx wrangler versions deploy "<version-id>@100%" --name <worker-name> --yes
```

このセッション中に3回同じ問題にハマった。以降はデプロイ手順に組み込んだ。

**教訓**: Cloudflare Workersの「deploy成功」は「trafficが向いている」を意味しない。

## 7. Safari ITPでAPI Workerへの認証cookieが保存されない

API Workerへブラウザから直接認証リクエストを送ると、Safari ITP（Intelligent Tracking Prevention）がthird-party cookieをブロックする。

Web WorkerとAPI Workerは別originのCloudflare Workerとして動く。
SafariはWeb Worker originから見てAPI Worker originのcookieをthird-partyとみなす。

対処: same-origin proxyを構築した。
ブラウザからの`/api/*`リクエストをWeb WorkerがService Binding経由でAPI Workerへ中継する。
ブラウザからはWeb Workerのドメインだけが見え、cookieもWeb Workerのドメインで発行される。

**教訓**: 認証cookieが絡む場合、マルチオリジン構成はSafariで動かない前提で設計する。

## 8. Flue Framework betaの破壊的変更リスク

Flue 1.0 Beta（6/16リリース）からbeta.4（6/23）までの1週間で、335コミット、300ファイルの書き換えが入った。
beta.3では「Named Sessions削除」「Persistence adapter契約変更」「Provider affinity変更」等の破壊的変更があった。

package.jsonが `"@flue/runtime": "^1.0.0-beta.2"` となっていたため、pnpm installのタイミング次第でbeta.3が入る可能性があった。

対処: `^`を外してexactバージョンに固定。

```json
"@flue/runtime": "1.0.0-beta.2"
```

**教訓**: beta期間中のフレームワークはexactバージョン固定。アップグレードは別PRで意図的に行う。

## 9. mutation routeにsession guardがなかった

`POST /:id/react`がclient側のuserIdをそのまま受け取っていた。
任意のuserIdでreactionを偽装できる脆弱性。
`PATCH /:id`（状態変更）にもsession guardがなかった。

#49で修正。全mutation routeに`getSessionResult()`を追加し、userIdはsessionから導出する。
clientからuserIdを受け取るインターフェースを廃止した。

**教訓**: 認証と認可は全mutation routeで統一的に適用する。「認証は後から足す」と穴が残る。

## 10. UIデザインの二重作業

最初は最小限のCSSでUIを作った。
途中で参考リポジトリ（auto-reply-board）のデザイン移植を求められ、CSSを書き直した。

参考リポジトリがあるなら、最初からそのデザインを移植すべきだった。

**教訓**: 参考デザインがあれば初手で移植する。

## うまくいったこと

問題だけでなく、うまく機能した判断も記録する。

**骨格→デプロイのサイクルが早かった。**
最初の2時間で本番URLを確保し、以降は全て「変更→デプロイ→確認→フィードバック」で回した。

**デバッグページが原因特定を加速した。**
AIの出力品質問題が出たとき、デバッグページで即座に原因を切り分けられた。

**ADR策定が判断の軸を作った。**
ADR-002策定後、AI関連の細かい判断が迷わずに済んだ。

**SSEインフラが問題発見に貢献した。**
contextWindow: 0の問題は、SSEがfailedイベントを正しく配信していたから特定できた。

**ChatGPT/Geminiレビュー駆動。**
ADRをChatGPTにレビューさせ、PRをGeminiにレビューさせ、セルフレビューで仕上げる3ラウンド構成。
ソロ開発でもレビュー品質を確保できるパターンとして確立した。
