BEGIN;
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS soul text NOT NULL DEFAULT '';
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS boundaries text NOT NULL DEFAULT '';
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 0;
ALTER TABLE requirement_assistant.projects ADD COLUMN IF NOT EXISTS config_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS requirement_assistant.project_materials (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES requirement_assistant.projects(id),
  name text NOT NULL, extension text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760),
  sha256 text NOT NULL, excerpt text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  replaces_id uuid REFERENCES requirement_assistant.project_materials(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_materials_project ON requirement_assistant.project_materials(project_id,created_at);
COMMIT;
