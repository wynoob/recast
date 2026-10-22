CREATE TABLE asset_map_entries (
  id TEXT PRIMARY KEY NOT NULL,
  import_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL REFERENCES import_scans(id) ON DELETE CASCADE,
  mapping_scan_item_id TEXT NOT NULL REFERENCES scan_items(id) ON DELETE RESTRICT,
  mapping_source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  map_index INTEGER NOT NULL CHECK (map_index BETWEEN 0 AND 2),
  table_index INTEGER NOT NULL CHECK (table_index >= 0),
  row_index INTEGER NOT NULL CHECK (row_index >= 0),
  row_key TEXT NOT NULL,
  section_heading TEXT NOT NULL,
  file_cell TEXT NOT NULL CHECK (length(trim(file_cell)) > 0 AND length(CAST(file_cell AS BLOB)) <= 16384),
  normalized_relative_path TEXT NOT NULL CHECK (length(normalized_relative_path) > 0),
  title_text TEXT CHECK (title_text IS NULL OR length(title_text) BETWEEN 1 AND 200),
  usage_markdown TEXT NOT NULL CHECK (length(CAST(usage_markdown AS BLOB)) BETWEEN 1 AND 16384),
  usage_text TEXT NOT NULL CHECK (length(CAST(usage_text AS BLOB)) BETWEEN 1 AND 16384),
  line_start INTEGER NOT NULL CHECK (line_start >= 1),
  line_end INTEGER NOT NULL CHECK (line_end >= line_start),
  parser_version TEXT NOT NULL CHECK (parser_version = 'dcw-asset-map/1'),
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (import_job_id, mapping_source_version_id, row_key)
);

CREATE INDEX idx_asset_map_entries_link ON asset_map_entries(import_job_id, normalized_relative_path);
CREATE INDEX idx_asset_map_entries_asset ON asset_map_entries(asset_id, map_index, table_index, row_index);
CREATE INDEX idx_asset_map_entries_source ON asset_map_entries(mapping_scan_item_id);
CREATE INDEX idx_asset_map_entries_job ON asset_map_entries(import_job_id, mapping_source_version_id);
CREATE INDEX idx_sources_kind_created ON sources(kind, created_at DESC, id DESC);
CREATE INDEX idx_source_versions_current ON source_versions(source_id, captured_at DESC, id DESC);
