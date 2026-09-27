BEGIN;
-- NULL project_id explicitly denotes administrator-managed global reference material.
-- Existing project links and files remain unchanged.
ALTER TABLE requirement_assistant.project_materials ALTER COLUMN project_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS project_materials_global ON requirement_assistant.project_materials(created_at) WHERE project_id IS NULL;
COMMIT;
