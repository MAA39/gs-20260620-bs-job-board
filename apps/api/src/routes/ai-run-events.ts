import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getAiRunById,
  listAiRunEventsAfter,
} from '@bs-job-board/db/ai-pipeline';
import type {
  PublicAiRunEvent,
  PublicAiErrorCode,
} from '@bs-job-board/contracts';

// ── Types ───────────────────────────────────────────────

type Bindings = {
  DB: D1Database;
};

type AiRunStatus = 'queued' | 'admitted' | 'generating' | 'repairing' | 'completed' | 'failed';

const TERMINAL_STATUSES = new Set<AiRunStatus>(['completed', 'failed']);

const STATUS_ALLOW_LIST = new Set<AiRunStatus>([
  'queued', 'admitted', 'generating', 'repairing', 'completed', 'failed',
]);

/** 公開境界で許可する error code。自由文字列は通さない。 */
const PUBLIC_ERROR_CODES = new Set<PublicAiErrorCode>([
  'AI_CONFIGURATION_ERROR',
  'AI_PROVIDER_TIMEOUT',
  'AI_OUTPUT_INVALID',
  'AI_INPUT_INVALID',
  'AI_RUN_FAILED',
  'AI_DISPATCH_FAILED',
  'AI_EVENT_INVALID',
]);

/** eventType と status の許可組み合わせ */
const EVENT_TYPE_STATUS_MAP: Record<string, ReadonlySet<AiRunStatus>> = {
  status: new Set<AiRunStatus>(['queued', 'admitted', 'generating', 'repairing']),
  completed: new Set<AiRunStatus>(['completed']),
  failed: new Set<AiRunStatus>(['failed']),
};

// ── Route factory config ────────────────────────────────
// テスト時に差し替え可能にする

export type SseRouteConfig = {
  pollMs: number;
  heartbeatMs: number;
  maxPolls: number;
  sleep: (ms: number) => Promise<void>;
  listEvents: typeof listAiRunEventsAfter;
  getRunById: typeof getAiRunById;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEFAULT_CONFIG: SseRouteConfig = {
  pollMs: 1_500,
  heartbeatMs: 15_000,
  maxPolls: 32,
  sleep: defaultSleep,
  listEvents: listAiRunEventsAfter,
  getRunById: getAiRunById,
};

// ── Public event mapper ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * data_json → PublicAiRunEvent。
 * total function: どんな入力でも例外を投げずnullを返す。
 */
function mapToPublicEvent(
  eventType: string,
  dataJson: string,
): PublicAiRunEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const status = parsed.status;
  if (typeof status !== 'string' || !STATUS_ALLOW_LIST.has(status as AiRunStatus)) return null;

  // eventType-status 整合チェック
  const allowedStatuses = EVENT_TYPE_STATUS_MAP[eventType];
  if (allowedStatuses && !allowedStatuses.has(status as AiRunStatus)) return null;

  if (status === 'completed') {
    const postIds = parsed.post_ids;
    if (!Array.isArray(postIds) || !postIds.every((id) => typeof id === 'string')) {
      return null;
    }
    return { status: 'completed', post_ids: postIds as string[] };
  }

  if (status === 'failed') {
    const raw = parsed.error_code;
    const errorCode: PublicAiErrorCode =
      typeof raw === 'string' && PUBLIC_ERROR_CODES.has(raw as PublicAiErrorCode)
        ? (raw as PublicAiErrorCode)
        : 'AI_RUN_FAILED';
    return { status: 'failed', error_code: errorCode };
  }

  return { status: status as 'queued' | 'admitted' | 'generating' | 'repairing' };
}

/**
 * event が terminal 相当か判定する。
 * event_type だけでなく、parse できた status が completed/failed の場合も含める。
 */
function isTerminalEvent(eventType: string, dataJson: string): boolean {
  if (eventType === 'completed' || eventType === 'failed') return true;
  try {
    const parsed = JSON.parse(dataJson);
    if (isRecord(parsed) && typeof parsed.status === 'string') {
      return TERMINAL_STATUSES.has(parsed.status as AiRunStatus);
    }
  } catch { /* noop */ }
  return false;
}

// ── Helpers ─────────────────────────────────────────────

function parseAfterParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0) return null;
  return num;
}

// ── Route factory ───────────────────────────────────────

export function createAiRunEventRoutes(config: SseRouteConfig = DEFAULT_CONFIG) {
  const routes = new Hono<{ Bindings: Bindings }>();

  routes.get('/:aiRunId/events', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    const db = c.env.DB as unknown as Parameters<typeof getAiRunById>[0];

    // ── 1. Run 存在確認
    const run = await config.getRunById(db, aiRunId);
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
      const events = await config.listEvents(db, aiRunId, cursor);
      if (events.length === 0) {
        return new Response(null, { status: 204 });
      }
    }

    // ── 4. SSE stream
    return streamSSE(c, async (stream) => {
      try {
        let currentCursor = cursor;
        let pollCount = 0;
        let lastHeartbeat = Date.now();

        while (pollCount < config.maxPolls) {
          if (stream.aborted) break;

          const events = await config.listEvents(db, aiRunId, currentCursor);

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
            } else if (isTerminalEvent(event.event_type, event.data_json)) {
              // terminal 相当の壊れた event → AI_EVENT_INVALID で閉じる
              await stream.writeSSE({
                event: 'ai-run',
                data: JSON.stringify({
                  status: 'failed',
                  error_code: 'AI_EVENT_INVALID',
                } satisfies PublicAiRunEvent),
                id: String(event.sequence),
              });
              return;
            } else {
              // 非 terminal の壊れた event: id だけ進める（WHATWG: data なし → イベント未発火）
              await stream.write(`id: ${event.sequence}\n\n`);
            }

            currentCursor = event.sequence;
          }

          pollCount++;

          // ── Heartbeat (SSEコメント行: で開始、イベント未発火)
          const now = Date.now();
          if (now - lastHeartbeat >= config.heartbeatMs) {
            await stream.write(': heartbeat\n\n');
            lastHeartbeat = now;
          }

          if (pollCount < config.maxPolls) {
            await config.sleep(config.pollMs);
          }
        }
      } catch (error) {
        if (!stream.aborted) {
          console.error('ai-run SSE failed', {
            aiRunId,
            name: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
    });
  });

  return routes;
}

// ── Default export ──────────────────────────────────────

export const aiRunEventRoutes = createAiRunEventRoutes();

// テスト用: mapper単体テスト向け
export { mapToPublicEvent };
