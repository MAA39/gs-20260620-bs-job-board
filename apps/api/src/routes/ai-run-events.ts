import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getAiRunById, listAiRunEventsAfter } from '@bs-job-board/db/ai-pipeline';
import type { PublicAiRunEvent, PublicAiErrorCode } from '@bs-job-board/contracts';
import { isPublicAiErrorCode } from '@bs-job-board/contracts';
import { pumpAiRunEvents, sleepWithAbort } from './pump-ai-run-events.ts';

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

// ── DB adapter types ────────────────────────────────────

type DbClient = Parameters<typeof getAiRunById>[0];

export type ListEvents = (db: DbClient, aiRunId: string, afterSequence: number) => Promise<Array<{ id: string; ai_run_id: string; sequence: number; event_type: string; data_json: string; created_at: string }>>;
export type GetRunById = (db: DbClient, aiRunId: string) => Promise<{ id: string; status: string; [k: string]: unknown } | null>;

// ── Route config ────────────────────────────────────────

export type SseRouteConfig = {
  pollMs: number;
  heartbeatMs: number;
  maxPolls: number;
  now: () => number;
  listEvents: ListEvents;
  getRunById: GetRunById;
  logStreamError: (info: { aiRunId: string; name: string }) => void;
};

const DEFAULT_CONFIG: SseRouteConfig = {
  pollMs: 1_500,
  heartbeatMs: 15_000,
  maxPolls: 32,
  now: Date.now,
  listEvents: listAiRunEventsAfter as unknown as ListEvents,
  getRunById: getAiRunById as unknown as GetRunById,
  logStreamError: (info) => console.error('ai-run SSE failed', info),
};

// ── Public event mapper ─────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mapToPublicEvent(eventType: string, dataJson: string): PublicAiRunEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(dataJson); } catch { return null; }
  if (!isRecord(parsed)) return null;

  const status = parsed.status;
  if (typeof status !== 'string' || !STATUS_ALLOW_LIST.has(status as AiRunStatus)) return null;

  const allowed = EVENT_TYPE_STATUS_MAP.get(eventType);
  if (!allowed || !allowed.has(status as AiRunStatus)) return null;

  if (status === 'completed') {
    const ids = parsed.post_ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
    return { status: 'completed', post_ids: ids as string[] };
  }

  if (status === 'failed') {
    const errorCode: PublicAiErrorCode = isPublicAiErrorCode(parsed.error_code)
      ? parsed.error_code
      : 'AI_RUN_FAILED';
    return { status: 'failed', error_code: errorCode };
  }

  return { status: status as 'queued' | 'admitted' | 'generating' | 'repairing' };
}

export function isTerminalEvent(eventType: string, dataJson: string): boolean {
  if (eventType === 'completed' || eventType === 'failed') return true;
  try {
    const p = JSON.parse(dataJson);
    if (isRecord(p) && typeof p.status === 'string') return TERMINAL_STATUSES.has(p.status as AiRunStatus);
  } catch { /* noop */ }
  return false;
}

// ── Helpers ─────────────────────────────────────────────

function parseAfterParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

// ── Route factory ───────────────────────────────────────

export function createAiRunEventRoutes(overrides: Partial<SseRouteConfig> = {}) {
  const config: SseRouteConfig = { ...DEFAULT_CONFIG, ...overrides };
  const routes = new Hono<{ Bindings: Bindings }>();

  routes.get('/:aiRunId/events', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    const db = c.env.DB as unknown as DbClient;

    // ── pre-stream validation (HTTP boundary) ──
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

    // ── stream: pump handles polling ──
    return streamSSE(c, async (stream) => {
      await pumpAiRunEvents(stream, {
        aiRunId,
        startCursor: cursor,
        pollMs: config.pollMs,
        heartbeatMs: config.heartbeatMs,
        maxPolls: config.maxPolls,
        now: config.now,
        sleep: sleepWithAbort,
        listEventsAfter: (id, after) => config.listEvents(db, id, after),
        mapToPublicEvent,
        isTerminalEvent,
        logStreamError: config.logStreamError,
      });
    });
  });

  return routes;
}

export const aiRunEventRoutes = createAiRunEventRoutes();
