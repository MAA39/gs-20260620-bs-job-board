# AI回答context・出力 現行仕様

このページは、現在の`generate-replies` workflowがmodelへ何を渡し、何を保存するかを独立して記録する。

## 起動単位

AI生成は以下の各操作後に1回起動する。

- thread作成後
- client入力の`author_type`が`human`であるpost追加後

1回のworkflowでAI replyを3件生成する。

## workflow input

```json
{
  "threadId": "thread UUID",
  "threadTitle": "thread title",
  "targetBody": "作成または返信されたhuman body",
  "targetPostNumber": 1
}
```

APIはpost IDをAgentへ渡さない。返信元はthread内の表示番号で扱う。

## DBから取得するcontext

```sql
SELECT post_number, author_name, body, author_type
FROM posts
WHERE thread_id = ?
  AND author_name != '🤔 AIの思考'
ORDER BY post_number DESC
LIMIT 8
```

結果をreverseし、古い順へ戻して使用する。

### 含まれるもの

- 同じthreadの直近8post
- human post
- AI post
- legacy公開roleのpost

### 除外されるもの

- `author_name`が完全一致で`🤔 AIの思考`のpost

### 除外されない可能性があるもの

- `role='thinking'`だがauthor nameが異なるpost
- source postと関係のない別枝のpost
- source postより後に追加されたpost

## promptの順序

```text
SYSTEM_PROMPT

スレッド名: <threadTitle>

<post_number>. <author_name>: <body>
<最大8件>

返信対象: <targetBody>

返信を3件返す。
```

source postが直近8件に含まれる場合、その本文は履歴と`返信対象`で**2回入る**。

## 保持されないcontext

現在のcontext builderは以下を明示的に保持しない。

- thread rootの常時保持
- source post ID
- parent post ID
- source postを中心とする会話branch
- AIが直前に聞いた質問
- その質問へのhuman回答
- 既にAIが提示したviewpoint
- thread要約
- semantic relevance
- user identity / same author continuity

## system prompt

現在の主要制約:

- 2chふう匿名掲示板住民
- 判断や説教をしない
- 投稿者の言葉を拾う
- 深掘り質問は3件全体で最大1つ
- AIを名乗らない
- `>>`を書かない
- JSON objectだけを返す

## model設定

```text
provider      sakura-ai
model         gpt-oss-120b（default）
thinking      minimal
max tokens    1500
timeout       45 seconds
```

## 出力契約

```json
{
  "replies": [
    "5〜200文字",
    "5〜200文字",
    "5〜200文字"
  ]
}
```

validation:

- exactly 3件
- stringのみ
- 各5〜200文字
- 重複なし
- `?` / `？`は全体で最大1個
- JSON text以外を許容しない

## repair

初回validation failure時のみ、以下を追加して同じsessionへ再送する。

- validation issue一覧
- 正しいJSON shape
- 直前のmodel output全文

repairは1回だけ。

## 保存

3件を同じD1 batchで保存する。

```text
author_type       ai
author_name       名無しさん
role              NULL
source_post_number targetPostNumber
user_id           NULL
```

本文へ`>>N`は付けない。Webが`source_post_number`を見てインデントする。

## 現行context仕様の性質

`LIMIT 8`は現在の実装値であり、会話品質を保証する仕様ではない。

長いthreadでは、rootの問題設定や以前の重要回答を失う。複数枝がある場合は、targetと無関係な直近postがcontextを占有し得る。

このページはその問題を正当化するものではなく、移行前のbaselineを記録する。
