CREATE TABLE export_jobs (
  export_id TEXT PRIMARY KEY NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  format TEXT NOT NULL CHECK (format IN ('html_zip', 'pdf', 'project_bundle', 'feishu_doc')),
  speaker_notes INTEGER NOT NULL DEFAULT 0 CHECK (speaker_notes IN (0, 1)),
  renderer_version TEXT NOT NULL,
  title TEXT NOT NULL,
  media_summary_json TEXT NOT NULL CHECK (json_valid(media_summary_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE export_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  export_id TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('html_zip', 'pdf', 'project_bundle', 'feishu_receipt', 'preview')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  storage_relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE project_bundle_imports (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  bundle_sha256 TEXT NOT NULL CHECK (length(bundle_sha256) = 64),
  bundle_relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  original_title TEXT,
  content_id TEXT REFERENCES contents(id) ON DELETE RESTRICT,
  rendition_id TEXT REFERENCES renditions(id) ON DELETE RESTRICT,
  revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE output_job_decisions (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feishu_pull_jobs (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  pull_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES feishu_bindings(id) ON DELETE RESTRICT,
  expected_local_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'preview', 'accepted', 'rejected', 'failed')),
  diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_export_jobs_content ON export_jobs(content_id, created_at DESC, export_id DESC);
CREATE INDEX idx_export_jobs_rendition ON export_jobs(rendition_id, created_at DESC, export_id DESC);
CREATE INDEX idx_export_artifacts_export ON export_artifacts(export_id, created_at, id);
CREATE INDEX idx_project_bundle_imports_status ON project_bundle_imports(status, created_at, id);
CREATE INDEX idx_feishu_pull_jobs_binding ON feishu_pull_jobs(binding_id, created_at DESC);
