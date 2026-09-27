-- 私有项目资料包与待绑定身份。重复执行安全。
BEGIN;
ALTER TABLE requirement_assistant.projects
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES requirement_assistant.users(id);

CREATE TABLE IF NOT EXISTS requirement_assistant.user_packages (
  id text PRIMARY KEY,
  expected_owner_name text NOT NULL,
  user_id uuid REFERENCES requirement_assistant.users(id),
  project_id text NOT NULL REFERENCES requirement_assistant.projects(id),
  source_key text NOT NULL,
  local_materials_path text NOT NULL,
  prompt_relative_path text NOT NULL,
  materials_manifest jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending_identity'
    CHECK (status IN ('pending_identity','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  bound_at timestamptz,
  UNIQUE(source_key)
);
COMMIT;
