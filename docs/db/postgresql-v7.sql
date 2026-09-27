BEGIN;
ALTER TABLE requirement_assistant.project_materials
  DROP CONSTRAINT IF EXISTS project_materials_size_bytes_check;
ALTER TABLE requirement_assistant.project_materials
  ADD CONSTRAINT project_materials_size_bytes_check CHECK(size_bytes>0 AND size_bytes<=52428800);
COMMIT;
