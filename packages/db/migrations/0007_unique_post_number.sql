-- post_number重複防止（race condition対策）
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_post_number ON posts(thread_id, post_number);
