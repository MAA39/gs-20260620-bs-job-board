import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getAiRunById,
  listAiRunEventsAfter,
} from '@bs-job-board/db/ai-pipeline';

// ── Types ───────────────────────────────────────────────

type Bindings = {
  DB: D1Database;
};

/** ADR-003: allow-list方式で公開データを再構築。
 *  prompt/completion/thinking/stack を配信しない。 */
type PublicAiRunEvent =
  | { status: 'queued' | 'admitted' | 'generating' | 'repairing' }
  | { status: 'completed'; post_ids: string[] }
  | { status: 'failed'; error_code: string };

type AiRunStatus = 'queued' | 'admitted' | 'generating' | 'repairing' | 'completed' | 'failed';

const TERMINAL_STATUSES = new Set<AiRunStatus>(['completed', 'failed']);

const STATUS_ALLOW_LIST = new Set<AiRunStatus>([
  'queued', 'admitted', 'generating', 'repairing', 'completed', 'failed',
]);

// ── Constants ───────────────────────────────────────────

const POLL_MS = 1_500;
const HEARTBEAT_MS = 15_000;
const MAX_POLLS = 32;

// ── Public event mapper ─────────────────────────────────

/** data_json → PublicAiRunEvent。不正な値は null を返す。 */
function mapToPublicEvent(
  eventType: string,
  dataJson: string,
): PublicAiRunEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    return null;
  }

  const status = parsed.status as AiRunStatus | undefined;
  if (!status || !STATUS_ALLOW_LIST.has(status)) return null;

  if (status === 'completed') {
    const postIds = parsed.post_ids;
    if (!Array.isArray(postIds) || !postIds.every((id) => typeof id === 'string')) {
      return null;
    }
    return { status: 'completed', post_ids: postIds as string[] };
  }

  if (status === 'failed') {
    const errorCode = typeof parsed.error_code === 'string'
      ? parsed.error_code
      : 'UNKNOWN_ERROR';
    return { status: 'failed', error_code: errorCode };
  }

  return { status };
}

// ── Helpers ─────────────────────────────────────────────

function parseAfterParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0) return null;
  return num;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Route ───────────────────────────────────────────────

export const aiRunEventRoutes = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/v1/ai-runs/:aiRunId/events
 *
 * 購読専用SSE。run を作成・変更しない。
 * - D1 polling (1.5s), heartbeat (15s), poll上限 (32回)
 * - Last-Event-ID or ?after= で resume（Last-Event-ID優先）
 * - terminal event 後に close
 * - 完了済み run で後続 event なし → 204 (EventSource 再接続停止)
 */
aiRunEventRoutes.get('/:aiRunId/events', async (c) => {
  const aiRunId = c.req.param('aiRunId');
  const db = c.env.DB as unknown as Parameters<typeof getAiRunById>[0];

  // ── 1. Run 存在確認
  const run = await getAiRunById(db, aiRunId);
  if (!run) return c.json({ error: 'ai_run not found' }, 404);

  // ── 2. after sequence 解決（Last-Event-ID 優先）
  const lastEventId = c.req.header('Last-Event-ID');
  const queryAfter = c.req.query('after');
  const rawAfter = lastEventId ?? queryAfter;
  const afterSequence = parseAfterParam(rawAfter);

  if (rawAfter !== undefined && rawAfter !== '' && afterSequence === null) {
    return c.json({ error: 'invalid after parameter: non-negative safe integer required' }, 400);
  }

  const cursor = afterSequence ?? 0;

  // ── 3. Terminal run で後続 event なし → 204
  if (TERMINAL_STATUSES.has(run.status as AiRunStatus)) {
    const events = await listAiRunEventsAfter(db, aiRunId, cursor);
    if (events.length === 0) {
      return new Response(null, { status: 204 });
    }
  }

  // ── 4. SSE stream
  return streamSSE(c, async (stream) => {
    let currentCursor = cursor;
    let pollCount = 0;
    let lastHeartbeat = Date.now();

    while (pollCount < MAX_POLLS) {
      if (stream.aborted) break;

      const events = await listAiRunEventsAfter(db, aiRunId, currentCursor);

      for (const event of events) {
        if (stream.aborted) break;

        const publicEvent = mapToPublicEvent(event.event_type, event.data_json);
        if (publicEvent) {
          await stream.writeSSE({
            event: 'ai-run',
            data: JSON.stringify(publicEvent),
            id: String(event.sequence),
          });

          if (TERMINAL_STATUSES.has(publicEvent.status as AiRunStatus)) {
            return;
          }
        } else {
          // 壊れた event: WHATWG 仕様に従い id だけ進める。
          // data なし frame → Last-Event-ID 更新、イベント未発火。
          // ただし terminal 相当の壊れた event は generic failure で閉じる。
          if (event.event_type === 'completed' || event.event_type === 'failed') {
            await stream.writeSSE({
              event: 'ai-run',
              data: JSON.stringify({
                status: 'failed',
                error_code: 'INTERNAL_EVENT_ERROR',
              } satisfies PublicAiRunEvent),
              id: String(event.sequence),
            });
            return;
          }
          // 非 terminal の壊れた event: cursor だけ進める
          await stream.writeSSE({ id: String(event.sequence), data: '' });
        }

        currentCursor = event.sequence;
      }

      pollCount++;

      // ── Heartbeat (SSEコメント行は : で開始、イベント未発火)
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        await stream.write(': heartbeat\n\n');
        lastHeartbeat = now;
      }

      if (pollCount < MAX_POLLS) {
        await sleep(POLL_MS);
      }
    }

    // MAX_POLLS 到達 → connection 終了。EventSource は自動再接続する。
  });
});
