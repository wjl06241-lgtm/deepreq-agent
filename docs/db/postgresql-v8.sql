BEGIN;
CREATE TABLE IF NOT EXISTS requirement_assistant.assistant_settings (
  id integer PRIMARY KEY CHECK(id=1),
  prompt text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz,
  updated_by text
);
INSERT INTO requirement_assistant.assistant_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
