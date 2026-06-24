PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  source_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK(stage IN ('initial', 'deep_dive')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued', 'admitted', 'generating', 'repairing', 'completing', 'completed', 'failed'
  )),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  flue_run_id TEXT UNIQUE,
  provider_request_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  result_hash TEXT,
  error_code TEXT,
  error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  admitted_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS ai_run_events (
  id TEXT PRIMARY KEY,
  ai_run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  event_type TEXT NOT NULL CHECK(event_type IN ('status', 'completed', 'failed')),
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(ai_run_id, sequence)
);

CREATE TABLE IF NOT EXISTS ai_run_posts (
  ai_run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4),
  PRIMARY KEY(ai_run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_thread_created
  ON ai_runs(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_source
  ON ai_runs(source_post_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_status_updated
  ON ai_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_run_events_stream
  ON ai_run_events(ai_run_id, sequence);
