ALTER TABLE template_versions ADD COLUMN package_json TEXT CHECK (
  package_json IS NULL OR json_valid(package_json)
);
ALTER TABLE template_versions ADD COLUMN package_hash TEXT CHECK (
  package_hash IS NULL OR length(package_hash) = 64
);
ALTER TABLE template_versions ADD COLUMN base_version_id TEXT REFERENCES template_versions(id) ON DELETE RESTRICT;
ALTER TABLE template_versions ADD COLUMN change_summary TEXT;
ALTER TABLE template_versions ADD COLUMN slots_json TEXT CHECK (
  slots_json IS NULL OR json_valid(slots_json)
);
ALTER TABLE template_versions ADD COLUMN renderer_version TEXT CHECK (
  renderer_version IS NULL OR renderer_version IN ('docx-1', 'deck-1')
);

CREATE TABLE template_validations (
  id TEXT PRIMARY KEY NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  package_hash TEXT NOT NULL CHECK (length(package_hash) = 64),
  ast_hash TEXT CHECK (ast_hash IS NULL OR length(ast_hash) = 64),
  sample_hash TEXT CHECK (sample_hash IS NULL OR length(sample_hash) = 64),
  pdf_relative_path TEXT,
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_template_validations_version
  ON template_validations(template_version_id, created_at DESC, id DESC);
CREATE INDEX idx_template_versions_template
  ON template_versions(template_id, version DESC);

CREATE TRIGGER template_versions_content_immutable
BEFORE UPDATE OF
  template_id, version, kind, narrative_json, layout_json, theme_json,
  capabilities_json, package_json, package_hash, base_version_id,
  change_summary, slots_json, renderer_version
ON template_versions
BEGIN
  SELECT RAISE(ABORT, 'template version content is immutable');
END;

CREATE TRIGGER template_versions_status_transition
BEFORE UPDATE OF status
ON template_versions
WHEN OLD.status = 'archived'
  OR (OLD.status = 'ready' AND NEW.status = 'draft')
  OR NEW.status = OLD.status
BEGIN
  SELECT RAISE(ABORT, 'invalid template version status transition');
END;
