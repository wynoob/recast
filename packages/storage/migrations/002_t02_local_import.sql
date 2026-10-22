CREATE TABLE import_scans (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('local_directory', 'upload')),
  root_path TEXT,
  root_identity TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'scanning', 'ready', 'consumed', 'expired', 'failed', 'cancelled')),
  scanner_version TEXT NOT NULL,
  manifest_hash TEXT CHECK (manifest_hash IS NULL OR length(manifest_hash) = 64),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  exclusions_json TEXT NOT NULL CHECK (json_valid(exclusions_json)),
  selection_hash TEXT,
  import_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_items (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES import_scans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  relative_path TEXT NOT NULL,
  basename TEXT NOT NULL,
  media_kind_guess TEXT NOT NULL,
  mime_guess TEXT,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mtime_ms REAL NOT NULL CHECK (mtime_ms >= 0),
  device_id TEXT NOT NULL,
  inode TEXT NOT NULL,
  magic_prefix_hex TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'excluded', 'unsupported', 'unreadable')),
  exclusion_code TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (scan_id, relative_path)
);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes >= 0 AND declared_bytes <= 2147483648),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  next_chunk INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk >= 0),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'complete', 'scan_ready', 'expired', 'failed')),
  staging_relative_path TEXT NOT NULL,
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  mime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  scan_id TEXT REFERENCES import_scans(id) ON DELETE SET NULL
);

CREATE TABLE upload_chunks (
  session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, chunk_index)
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY NOT NULL,
  import_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scan_item_id TEXT NOT NULL REFERENCES scan_items(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'copying', 'probing', 'previewing', 'committed', 'failed', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  source_id TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  source_version_id TEXT REFERENCES source_versions(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  occurrence_id TEXT REFERENCES occurrences(id) ON DELETE RESTRICT,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (import_job_id, scan_item_id)
);

ALTER TABLE occurrences ADD COLUMN media_error_code TEXT;

CREATE INDEX idx_import_scans_job ON import_scans(job_id, created_at DESC);
CREATE INDEX idx_scan_items_scan_status ON scan_items(scan_id, status, ordinal);
CREATE INDEX idx_upload_sessions_status ON upload_sessions(status, updated_at);
CREATE INDEX idx_upload_sessions_scan ON upload_sessions(scan_id, relative_path);
CREATE INDEX idx_import_items_job_state ON import_items(import_job_id, state, created_at);
CREATE INDEX idx_import_items_asset ON import_items(asset_id);
