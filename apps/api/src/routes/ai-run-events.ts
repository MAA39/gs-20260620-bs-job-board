import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getAiRunById,
  listAiRunEventsAfter,
} from '@bs-job-board/db/ai-pipeline';
import type { PublicAiRunEvent, PublicAiErrorCode } from '@bs-job-board/contracts';
import { PUBLIC_AI_ERROR_CODE_SET } from '@bs-job-board/contracts';

// ── Types ───────────────────────────────────────────────

type Bindings = { DB: D1Database };

type AiRunStatus = 'queued' | 'admitted' | 'generating' | 'repairing' | 'completed' | 'failed';

const TERMINAL_STATUSES = new Set<AiRunStatus>(['completed', 'failed']);
const STATUS_ALLOW_LIST = new Set<AiRunStatus>(['queued', 'admitted', 'generating', 'repairing', 'completed', 'failed']);

const EVENT_TYPE_STATUS_MAP = new Map<string, ReadonlySet<AiRunStatus>>([
  ['status', new Set<AiRunStatus>(['queued', 'admitted', 'generating', 'repairing'])],
  ['completed', new Set<AiRunStatus>(['completed'])],
  ['failed', new Set<AiRunStatus>(['failed'])],
]);

// ── テスト境界用の狭い型 ────────────────────────────────

export type AiRunEventRow = {
  id: string;
  ai_run_id: string;
  sequence: number;
  event_type: string;
  data_json: string;
  created_at: string;
};

export type AiRunRow = {
  id: string;
  status: string;
  [key: string]: unknown;
};

export type ListEvents = (
  db: Parameters<typeof listAiRunEventsAfter>[0],
  aiRunId: string,
  afterSequence: number,
) => Promise<AiRunEventRow[]>;

export type GetRunById = (
  db: Parameters<typeof getAiRunById>[0],
  aiRunId: string,
) => Promise<AiRunRow | null>;

// ── Route factory config ────────────────────────────────

export type SseRouteConfig = {
  pollMs: number;
  heartbeatMs: number;
  maxPolls: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  listEvents: ListEvents;
  getRunById: GetRunById;
  logStreamError: (info: { aiRunId: string; name: string }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEFAULT_CONFIG: SseRouteConfig = {
  pollMs: 1_500,
  heartbeatMs: 15_000,
  maxPolls: 32,
  sleep: defaultSleep,
  now: Date.now,
  listEvents: listAiRunEventsAfter as unknown as ListEvents,
  getRunById: getAiRunById as unknown as GetRunById,
  logStreamError: (info) => console.error('ai-run SSE failed', info),
};

// ── Public event mapper ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapToPublicEvent(eventType: string, dataJson: string): PublicAiRunEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(dataJson); } catch { return null; }
  if (!isRecord(parsed)) return null;

  const status = parsed.status;
  if (typeof status !== 'string' || !STATUS_ALLOW_LIST.has(status as AiRunStatus)) return null;

  const allowedStatuses = EVENT_TYPE_STATUS_MAP.get(eventType);
  if (!allowedStatuses || !allowedStatuses.has(status as AiRunStatus)) return null;

  if (status === 'completed') {
    const postIds = parsed.post_ids;
    if (!Array.isArray(postIds) || !postIds.every((id) => typeof id === 'string')) return null;
    return { status: 'completed', post_ids: postIds as string[] };
  }

  if (status === 'failed') {
    const raw = parsed.error_code;
    const errorCode: PublicAiErrorCode =
      typeof raw === 'string' && PUBLIC_AI_ERROR_CODE_SET.has(raw)
        ? (raw as PublicAiErrorCode)
        : 'AI_RUN_FAILED';
    return { status: 'failed', error_code: errorCode };
  }

  return { status: status as 'queued' | 'admitted' | 'generating' | 'repairing' };
}

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

export function createAiRunEventRoutes(overrides: Partial<SseRouteConfig> = {}) {
  const config: SseRouteConfig = { ...DEFAULT_CONFIG, ...overrides };
  const routes = new Hono<{ Bindings: Bindings }>();

  routes.get('/:aiRunId/events', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    const db = c.env.DB as unknown as Parameters<typeof getAiRunById>[0];

    const run = await config.getRunById(db, aiRunId);
    if (!run) return c.json({ error: 'ai_run not found' }, 404);

    const lastEventId = c.req.header('Last-Event-ID');
    const queryAfter = c.req.query('after');
    const rawAfter = lastEventId ?? queryAfter;
    const afterSequence = parseAfterParam(rawAfter);

    if (rawAfter !== undefined && rawAfter !== '' && afterSequence === null) {
      return c.json({ error: 'invalid after parameter: non-negative safe integer required' }, 400);
    }

    const cursor = afterSequence ?? 0;

    if (TERMINAL_STATUSES.has(run.status as AiRunStatus)) {
      const events = await config.listEvents(db, aiRunId, cursor);
      if (events.length === 0) return new Response(null, { status: 204 });
    }

    return streamSSE(c, async (stream) => {
      try {
        // abort promise: stream ごとに 1 個だけ作る
        const aborted = new Promise<void>((resolve) => {
          stream.onAbort(resolve);
          if (stream.aborted) resolve();
        });

        let currentCursor = cursor;
        let pollCount = 0;
        let lastHeartbeat = config.now();

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
              if (TERMINAL_STATUSES.has(publicEvent.status as AiRunStatus)) return;
            } else if (isTerminalEvent(event.event_type, event.data_json)) {
              await stream.writeSSE({
                event: 'ai-run',
                data: JSON.stringify({ status: 'failed', error_code: 'AI_EVENT_INVALID' } satisfies PublicAiRunEvent),
                id: String(event.sequence),
              });
              return;
            } else {
              await stream.write(`id: ${event.sequence}\n\n`);
            }

            currentCursor = event.sequence;
          }

          pollCount++;

          const now = config.now();
          if (now - lastHeartbeat >= config.heartbeatMs) {
            await stream.write(': heartbeat\n\n');
            lastHeartbeat = now;
          }

          if (pollCount < config.maxPolls) {
            await Promise.race([config.sleep(config.pollMs), aborted]);
            if (stream.aborted) return;
          }
        }
      } catch (error) {
        if (!stream.aborted) {
          config.logStreamError({
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

export { mapToPublicEvent };
