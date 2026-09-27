BEGIN;
CREATE TABLE IF NOT EXISTS requirement_assistant.enterprises (
  id text PRIMARY KEY, name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requirement_assistant.enterprise_apps (
  app_id text PRIMARY KEY, enterprise_id text NOT NULL REFERENCES requirement_assistant.enterprises(id)
);
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS enterprise_id text REFERENCES requirement_assistant.enterprises(id);
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS assistant_prompt text NOT NULL DEFAULT '';
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS shared_notes text NOT NULL DEFAULT '';
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_project_name ON requirement_assistant.projects(enterprise_id,lower(name)) WHERE enterprise_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS requirement_assistant.project_members (
  project_id text NOT NULL REFERENCES requirement_assistant.projects(id),
  user_id uuid NOT NULL REFERENCES requirement_assistant.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,user_id)
);
CREATE TABLE IF NOT EXISTS requirement_assistant.enterprise_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requirement_assistant.project_legacy_conversations (
  conversation_id uuid PRIMARY KEY REFERENCES requirement_assistant.conversations(id),
  project_id text NOT NULL REFERENCES requirement_assistant.projects(id)
);
COMMIT;
