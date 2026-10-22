CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  original_uri TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(sha256) = 64),
  relative_path TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE source_versions (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  snapshot_blob_hash TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  remote_revision TEXT,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, fingerprint)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  blob_hash TEXT NOT NULL UNIQUE REFERENCES blobs(sha256) ON DELETE RESTRICT,
  media_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  human_fields_json TEXT NOT NULL CHECK (json_valid(human_fields_json)),
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version)
);

CREATE TABLE occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  occurrence_index INTEGER NOT NULL DEFAULT 0,
  heading_path TEXT NOT NULL,
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  media_status TEXT NOT NULL CHECK (media_status IN ('discovered', 'available', 'missing', 'unsupported')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_version_id, locator_json, occurrence_index)
);

CREATE TABLE derivatives (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  recipe_json TEXT NOT NULL CHECK (json_valid(recipe_json)),
  recipe_hash TEXT NOT NULL CHECK (length(recipe_hash) = 64),
  blob_hash TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, recipe_hash)
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  derivative_id TEXT REFERENCES derivatives(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY NOT NULL,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  occurrence_id TEXT REFERENCES occurrences(id) ON DELETE RESTRICT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fact_versions (
  id TEXT PRIMARY KEY NOT NULL,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE RESTRICT,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  unit TEXT NOT NULL,
  merchant_id TEXT,
  period_json TEXT CHECK (period_json IS NULL OR json_valid(period_json)),
  kind TEXT NOT NULL CHECK (kind IN ('measured', 'estimated', 'user_assertion')),
  source_locator_json TEXT NOT NULL CHECK (json_valid(source_locator_json)),
  status TEXT NOT NULL CHECK (status IN ('unverified', 'confirmed', 'obsolete')),
  created_at TEXT NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE TABLE asset_groups (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE group_items (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES asset_groups(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  segment_id TEXT REFERENCES segments(id) ON DELETE RESTRICT,
  occurrence_id TEXT REFERENCES occurrences(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  explanation TEXT NOT NULL,
  UNIQUE (group_id, position)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feishu_doc', 'html_deck')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('feishu_doc', 'html_deck')),
  narrative_json TEXT NOT NULL CHECK (json_valid(narrative_json)),
  layout_json TEXT NOT NULL CHECK (json_valid(layout_json)),
  theme_json TEXT NOT NULL CHECK (json_valid(theme_json)),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'archived')),
  created_at TEXT NOT NULL,
  UNIQUE (template_id, version)
);

CREATE TABLE contents (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  brief_json TEXT NOT NULL CHECK (json_valid(brief_json)),
  merchant_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'archived')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE renditions (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('feishu_doc', 'html_deck')),
  label TEXT NOT NULL,
  root_node_id TEXT NOT NULL,
  current_revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  derived_from_revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (content_id, kind, label)
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY NOT NULL,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE RESTRICT,
  parent_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  template_version_id TEXT REFERENCES template_versions(id) ON DELETE RESTRICT,
  ast_json TEXT NOT NULL CHECK (json_valid(ast_json)),
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'ai_accepted', 'feishu_pull', 'restore', 'import')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE revision_refs (
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  PRIMARY KEY (revision_id, ref_type, ref_id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  rendition_id TEXT REFERENCES renditions(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  text TEXT NOT NULL,
  target_node_ids_json TEXT NOT NULL CHECK (json_valid(target_node_ids_json)),
  candidate_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE RESTRICT,
  base_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'conflicted')),
  model_run_id TEXT,
  applied_revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_input', 'succeeded', 'partial', 'failed', 'cancelled')),
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_until TEXT,
  next_run_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('progress', 'item_result', 'warning', 'needs_input', 'completed', 'error')),
  phase TEXT NOT NULL,
  done INTEGER CHECK (done IS NULL OR done >= 0),
  total INTEGER CHECK (total IS NULL OR total >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY NOT NULL,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  format TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  status TEXT NOT NULL,
  output_blob_hash TEXT REFERENCES blobs(sha256) ON DELETE RESTRICT,
  warning_json TEXT CHECK (warning_json IS NULL OR json_valid(warning_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feishu_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE RESTRICT,
  exported_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  remote_document_id TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  block_map_json TEXT NOT NULL CHECK (json_valid(block_map_json)),
  media_map_json TEXT NOT NULL CHECK (json_valid(media_map_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (rendition_id, exported_revision_id, remote_document_id)
);

CREATE TABLE remote_operations (
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'confirmed', 'unknown')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  remote_client_token TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, attempt, lease_generation)
);

CREATE TABLE pulls (
  id TEXT PRIMARY KEY NOT NULL,
  binding_id TEXT NOT NULL REFERENCES feishu_bindings(id) ON DELETE RESTRICT,
  remote_source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  base_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  observed_current_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  ast_json TEXT NOT NULL CHECK (json_valid(ast_json)),
  status TEXT NOT NULL CHECK (status IN ('preview', 'accepted', 'rejected')),
  accepted_rendition_id TEXT REFERENCES renditions(id) ON DELETE RESTRICT,
  accepted_revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_configs (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('text', 'embedding', 'vision', 'asr')),
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  keychain_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE embedding_namespaces (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  version TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  created_at TEXT NOT NULL,
  UNIQUE (provider, model, version, dimension)
);

CREATE TABLE embeddings (
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  namespace_id TEXT NOT NULL REFERENCES embedding_namespaces(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, namespace_id)
);

CREATE TABLE idempotency_keys (
  route_scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status_code INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  result_ref TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (route_scope, key)
);

CREATE TABLE local_sessions (
  id_hash TEXT PRIMARY KEY NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_sources_status ON sources(status, updated_at DESC);
CREATE INDEX idx_source_versions_source ON source_versions(source_id, captured_at DESC);
CREATE INDEX idx_assets_kind ON assets(media_kind, created_at DESC);
CREATE INDEX idx_asset_versions_asset ON asset_versions(asset_id, version DESC);
CREATE INDEX idx_occurrences_source_version ON occurrences(source_version_id, occurrence_index);
CREATE INDEX idx_occurrences_asset ON occurrences(asset_id);
CREATE INDEX idx_derivatives_asset ON derivatives(asset_id, kind);
CREATE INDEX idx_segments_asset ON segments(asset_id, start_ms);
CREATE INDEX idx_chunks_source_version ON chunks(source_version_id);
CREATE INDEX idx_chunks_occurrence ON chunks(occurrence_id);
CREATE INDEX idx_fact_versions_fact ON fact_versions(fact_id, created_at DESC);
CREATE INDEX idx_templates_kind ON templates(kind, updated_at DESC);
CREATE INDEX idx_template_versions_status ON template_versions(template_id, status, version DESC);
CREATE INDEX idx_contents_status_updated ON contents(status, updated_at DESC, id DESC);
CREATE INDEX idx_renditions_content ON renditions(content_id, kind, created_at);
CREATE INDEX idx_revisions_rendition_created ON revisions(rendition_id, created_at DESC, id DESC);
CREATE INDEX idx_revisions_parent ON revisions(parent_id);
CREATE INDEX idx_revision_refs_ref ON revision_refs(ref_type, ref_id);
CREATE INDEX idx_conversations_content ON conversations(content_id, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at ASC);
CREATE INDEX idx_ai_candidates_rendition ON ai_candidates(rendition_id, status, created_at DESC);
CREATE INDEX idx_jobs_state_next ON jobs(state, next_run_at, created_at);
CREATE INDEX idx_jobs_lease ON jobs(lease_owner, lease_until);
CREATE INDEX idx_job_events_job_seq ON job_events(job_id, seq);
CREATE INDEX idx_exports_rendition ON exports(rendition_id, created_at DESC);
CREATE INDEX idx_feishu_bindings_rendition ON feishu_bindings(rendition_id, created_at DESC);
CREATE INDEX idx_remote_operations_job ON remote_operations(job_id, state);
CREATE INDEX idx_pulls_binding ON pulls(binding_id, created_at DESC);
CREATE INDEX idx_embeddings_namespace ON embeddings(namespace_id, chunk_id);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TRIGGER revisions_immutable_update
BEFORE UPDATE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER revisions_immutable_delete
BEFORE DELETE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER source_versions_immutable_update
BEFORE UPDATE ON source_versions
BEGIN
  SELECT RAISE(ABORT, 'source_versions are immutable');
END;

CREATE TRIGGER source_versions_immutable_delete
BEFORE DELETE ON source_versions
BEGIN
  SELECT RAISE(ABORT, 'source_versions are immutable');
END;

CREATE TRIGGER asset_versions_immutable_update
BEFORE UPDATE ON asset_versions
BEGIN
  SELECT RAISE(ABORT, 'asset_versions are immutable');
END;

CREATE TRIGGER asset_versions_immutable_delete
BEFORE DELETE ON asset_versions
BEGIN
  SELECT RAISE(ABORT, 'asset_versions are immutable');
END;
