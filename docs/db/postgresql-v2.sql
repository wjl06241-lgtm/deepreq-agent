-- 运行同步与审计：重复执行安全，不修改旧业务数据。
BEGIN;
CREATE TABLE IF NOT EXISTS requirement_assistant.sync_events (
  id uuid PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requirement_assistant.records (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  app_id text NOT NULL,
  kind text NOT NULL,
  user_id uuid REFERENCES requirement_assistant.users(id),
  conversation_id uuid REFERENCES requirement_assistant.conversations(id),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS records_time ON requirement_assistant.records(occurred_at);
CREATE INDEX IF NOT EXISTS records_owner_time ON requirement_assistant.records(user_id, occurred_at);
COMMIT;
