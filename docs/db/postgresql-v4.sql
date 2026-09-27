BEGIN;
ALTER TABLE requirement_assistant.users ADD COLUMN IF NOT EXISTS registration jsonb NOT NULL DEFAULT '{}';
COMMIT;
