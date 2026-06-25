import type { PublicAiRunEvent } from '@bs-job-board/contracts';

// ── Stream port ─────────────────────────────────────────

export type StreamPort = {
  readonly aborted: boolean;
  onAbort(listener: () => void): void;
  write(chunk: string): Promise<unknown>;
  writeSSE(message: { event?: string; data: string; id?: string }): Promise<unknown>;
};

// ── Event row ───────────────────────────────────────────

export type AiRunEventRow = {
  id: string;
  ai_run_id: string;
  sequence: number;
  event_type: string;
  data_json: string;
  created_at: string;
};

// ── Pump options ────────────────────────────────────────

export type PumpOptions = {
  aiRunId: string;
  startCursor: number;
  pollMs: number;
  heartbeatMs: number;
  maxPolls: number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  listEventsAfter: (aiRunId: string, afterSequence: number) => Promise<AiRunEventRow[]>;
  mapToPublicEvent: (eventType: string, dataJson: string) => PublicAiRunEvent | null;
  isTerminalEvent: (eventType: string, dataJson: string) => boolean;
  logStreamError: (info: { aiRunId: string; name: string }) => void;
};

// ── Pump ────────────────────────────────────────────────

export async function pumpAiRunEvents(stream: StreamPort, options: PumpOptions): Promise<void> {
  const ac = new AbortController();
  stream.onAbort(() => ac.abort());
  if (stream.aborted) ac.abort();

  let currentCursor = options.startCursor;
  let pollCount = 0;
  let lastHeartbeat = options.now();

  try {
    while (pollCount < options.maxPolls) {
      if (stream.aborted || ac.signal.aborted) return;

      const rows = await options.listEventsAfter(options.aiRunId, currentCursor);

      for (const row of rows) {
        if (stream.aborted || ac.signal.aborted) return;

        const publicEvent = options.mapToPublicEvent(row.event_type, row.data_json);
        if (publicEvent) {
          await stream.writeSSE({
            event: 'ai-run',
            data: JSON.stringify(publicEvent),
            id: String(row.sequence),
          });
          currentCursor = row.sequence;
          if (publicEvent.status === 'completed' || publicEvent.status === 'failed') return;
          continue;
        }

        if (options.isTerminalEvent(row.event_type, row.data_json)) {
          await stream.writeSSE({
            event: 'ai-run',
            data: JSON.stringify({ status: 'failed', error_code: 'AI_EVENT_INVALID' } satisfies PublicAiRunEvent),
            id: String(row.sequence),
          });
          return;
        }

        await stream.write(`id: ${row.sequence}\n\n`);
        currentCursor = row.sequence;
      }

      pollCount++;

      const now = options.now();
      if (now - lastHeartbeat >= options.heartbeatMs) {
        await stream.write(': heartbeat\n\n');
        lastHeartbeat = now;
      }

      if (pollCount < options.maxPolls) {
        await options.sleep(options.pollMs, ac.signal);
        if (stream.aborted || ac.signal.aborted) return;
      }
    }
  } catch (error) {
    if (!stream.aborted && !ac.signal.aborted) {
      options.logStreamError({
        aiRunId: options.aiRunId,
        name: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}

// ── AbortSignal-aware sleep ─────────────────────────────

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
