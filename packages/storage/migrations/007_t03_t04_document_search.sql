ALTER TABLE source_versions ADD COLUMN processor_version TEXT NOT NULL DEFAULT 'dcw-legacy/1';
ALTER TABLE source_versions ADD COLUMN extraction_snapshot_json TEXT
  CHECK (extraction_snapshot_json IS NULL OR json_valid(extraction_snapshot_json));
ALTER TABLE source_versions ADD COLUMN source_relative_path TEXT;

ALTER TABLE import_items ADD COLUMN planned_source_version_id TEXT;

CREATE TABLE document_sections (
  id TEXT PRIMARY KEY NOT NULL,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  adapter_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  title TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  text TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_version_id, adapter_id),
  UNIQUE (source_version_id, ordinal)
);

CREATE TABLE document_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  section_id TEXT NOT NULL REFERENCES document_sections(id) ON DELETE RESTRICT,
  adapter_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  text TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  created_at TEXT NOT NULL,
  UNIQUE (source_version_id, adapter_id),
  UNIQUE (section_id, ordinal)
);

CREATE TABLE adapter_local_ids (
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  processor_internal_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('section', 'block', 'media', 'occurrence')),
  business_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_version_id, processor_internal_id, entity_type)
);

ALTER TABLE occurrences ADD COLUMN section_id TEXT REFERENCES document_sections(id) ON DELETE RESTRICT;

CREATE TABLE import_staged_files (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scan_item_id TEXT NOT NULL REFERENCES scan_items(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  batch_count INTEGER NOT NULL CHECK (batch_count > 0 AND batch_index < batch_count),
  adapter_id TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  media_status TEXT NOT NULL CHECK (media_status = 'extracted'),
  source_internal_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mime TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('document_media', 'page_image')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, scan_item_id, adapter_id)
);

CREATE TABLE index_generations (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'superseded', 'failed')),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT
);

CREATE TABLE index_generation_chunks (
  index_generation_id TEXT NOT NULL REFERENCES index_generations(id) ON DELETE RESTRICT,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (index_generation_id, chunk_id)
);

ALTER TABLE chunks ADD COLUMN section_id TEXT REFERENCES document_sections(id) ON DELETE RESTRICT;
ALTER TABLE chunks ADD COLUMN block_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(block_ids_json));
ALTER TABLE chunks ADD COLUMN locators_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(locators_json));
ALTER TABLE chunks ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json));
ALTER TABLE chunks ADD COLUMN chunk_kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chunks ADD COLUMN ref_type TEXT NOT NULL DEFAULT 'chunk'
  CHECK (ref_type IN ('chunk', 'fact'));
ALTER TABLE chunks ADD COLUMN fact_version_id TEXT REFERENCES fact_versions(id) ON DELETE RESTRICT;

CREATE TABLE selection_handles (
  id TEXT PRIMARY KEY NOT NULL,
  index_generation_id TEXT NOT NULL REFERENCES index_generations(id) ON DELETE RESTRICT,
  ref_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('source_version', 'fact')),
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE RESTRICT,
  source_id TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  source_version_id TEXT REFERENCES source_versions(id) ON DELETE RESTRICT,
  occurrence_id TEXT REFERENCES occurrences(id) ON DELETE RESTRICT,
  section_id TEXT REFERENCES document_sections(id) ON DELETE RESTRICT,
  fact_id TEXT REFERENCES facts(id) ON DELETE RESTRICT,
  fact_version_id TEXT REFERENCES fact_versions(id) ON DELETE RESTRICT,
  block_ids_json TEXT NOT NULL CHECK (json_valid(block_ids_json)),
  locators_json TEXT NOT NULL CHECK (json_valid(locators_json)),
  created_at TEXT NOT NULL
);

ALTER TABLE facts ADD COLUMN current_version_id TEXT REFERENCES fact_versions(id) ON DELETE RESTRICT;

ALTER TABLE fact_versions ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1
  CHECK (version_number > 0);
ALTER TABLE fact_versions ADD COLUMN source_version_id TEXT REFERENCES source_versions(id) ON DELETE RESTRICT;
ALTER TABLE fact_versions ADD COLUMN index_text TEXT;

CREATE INDEX idx_document_sections_version ON document_sections(source_version_id, ordinal);
CREATE INDEX idx_document_blocks_section ON document_blocks(section_id, ordinal);
CREATE INDEX idx_document_blocks_version ON document_blocks(source_version_id, ordinal);
CREATE INDEX idx_adapter_local_ids_business ON adapter_local_ids(business_id);
CREATE INDEX idx_import_staged_files_item ON import_staged_files(job_id, scan_item_id, batch_index);
CREATE INDEX idx_index_generations_status ON index_generations(status, created_at DESC);
CREATE INDEX idx_index_generation_chunks_chunk ON index_generation_chunks(chunk_id);
CREATE INDEX idx_selection_handles_generation ON selection_handles(index_generation_id, created_at DESC);
CREATE INDEX idx_chunks_ref_type ON chunks(ref_type, fact_version_id);
CREATE INDEX idx_fact_versions_source ON fact_versions(source_version_id, created_at DESC);

CREATE TRIGGER document_sections_immutable_update
BEFORE UPDATE ON document_sections
BEGIN
  SELECT RAISE(ABORT, 'document sections are immutable');
END;

CREATE TRIGGER document_sections_immutable_delete
BEFORE DELETE ON document_sections
BEGIN
  SELECT RAISE(ABORT, 'document sections are immutable');
END;

CREATE TRIGGER document_blocks_immutable_update
BEFORE UPDATE ON document_blocks
BEGIN
  SELECT RAISE(ABORT, 'document blocks are immutable');
END;

CREATE TRIGGER document_blocks_immutable_delete
BEFORE DELETE ON document_blocks
BEGIN
  SELECT RAISE(ABORT, 'document blocks are immutable');
END;

CREATE TRIGGER fact_versions_immutable_update
BEFORE UPDATE ON fact_versions
BEGIN
  SELECT RAISE(ABORT, 'fact versions are immutable');
END;

CREATE TRIGGER fact_versions_immutable_delete
BEFORE DELETE ON fact_versions
BEGIN
  SELECT RAISE(ABORT, 'fact versions are immutable');
END;
