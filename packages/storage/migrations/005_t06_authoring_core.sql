CREATE TABLE authoring_confirmations (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  content_version INTEGER NOT NULL CHECK (content_version >= 0),
  brief_json TEXT NOT NULL CHECK (json_valid(brief_json)),
  outline_json TEXT NOT NULL CHECK (json_valid(outline_json)),
  question_decisions_json TEXT NOT NULL CHECK (json_valid(question_decisions_json)),
  confirmed_by_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE generation_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE RESTRICT,
  base_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  root_node_id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL REFERENCES authoring_confirmations(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('feishu_doc', 'html_deck')),
  target_node_ids_json TEXT NOT NULL CHECK (json_valid(target_node_ids_json)),
  template_version_id TEXT NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
  template_package_json TEXT NOT NULL CHECK (json_valid(template_package_json)),
  template_hash TEXT NOT NULL CHECK (length(template_hash) = 64),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  unplaced_owner_map_json TEXT NOT NULL CHECK (json_valid(unplaced_owner_map_json)),
  provider_config_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE revision_evidence (
  revision_id TEXT PRIMARY KEY NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  direct_refs_json TEXT NOT NULL CHECK (json_valid(direct_refs_json)),
  transitive_refs_json TEXT NOT NULL CHECK (json_valid(transitive_refs_json)),
  blob_hashes_json TEXT NOT NULL CHECK (json_valid(blob_hashes_json)),
  bindings_json TEXT NOT NULL CHECK (json_valid(bindings_json)),
  binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64),
  created_at TEXT NOT NULL
);

ALTER TABLE messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'historical'
  CHECK (mode IN ('plan', 'revise', 'note', 'confirm_outline', 'historical'));
ALTER TABLE messages ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT;
ALTER TABLE messages ADD COLUMN plan_id TEXT;
ALTER TABLE messages ADD COLUMN transcript_id TEXT;

ALTER TABLE ai_candidates ADD COLUMN input_id TEXT REFERENCES generation_inputs(id) ON DELETE RESTRICT;
ALTER TABLE ai_candidates ADD COLUMN confirmation_id TEXT REFERENCES authoring_confirmations(id) ON DELETE RESTRICT;
ALTER TABLE ai_candidates ADD COLUMN template_version_id TEXT REFERENCES template_versions(id) ON DELETE RESTRICT;
ALTER TABLE ai_candidates ADD COLUMN target_node_ids_json TEXT CHECK (
  target_node_ids_json IS NULL OR json_valid(target_node_ids_json)
);
ALTER TABLE ai_candidates ADD COLUMN content_version_at_plan INTEGER;
ALTER TABLE ai_candidates ADD COLUMN plan_hash TEXT;
ALTER TABLE ai_candidates ADD COLUMN payload_hash TEXT;
ALTER TABLE ai_candidates ADD COLUMN decisions_json TEXT;
ALTER TABLE ai_candidates ADD COLUMN acceptance_hash TEXT;
ALTER TABLE ai_candidates ADD COLUMN accepted_decisions_json TEXT;
ALTER TABLE ai_candidates ADD COLUMN accepted_at TEXT;

CREATE TABLE worker_receipts (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  receipt_key TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, receipt_key)
);

CREATE INDEX idx_authoring_confirmations_content
  ON authoring_confirmations(content_id, created_at DESC, id DESC);
CREATE INDEX idx_generation_inputs_content
  ON generation_inputs(content_id, created_at DESC, id DESC);
CREATE INDEX idx_generation_inputs_rendition
  ON generation_inputs(rendition_id, created_at DESC, id DESC);
CREATE INDEX idx_revision_evidence_hash
  ON revision_evidence(binding_hash);
CREATE INDEX idx_messages_content_mode
  ON messages(conversation_id, mode, created_at, id);
CREATE INDEX idx_ai_candidates_input
  ON ai_candidates(input_id);

CREATE TRIGGER authoring_confirmations_immutable_update
BEFORE UPDATE ON authoring_confirmations
BEGIN
  SELECT RAISE(ABORT, 'authoring confirmations are immutable');
END;

CREATE TRIGGER authoring_confirmations_immutable_delete
BEFORE DELETE ON authoring_confirmations
BEGIN
  SELECT RAISE(ABORT, 'authoring confirmations are immutable');
END;

CREATE TRIGGER generation_inputs_immutable_update
BEFORE UPDATE ON generation_inputs
BEGIN
  SELECT RAISE(ABORT, 'generation inputs are immutable');
END;

CREATE TRIGGER generation_inputs_immutable_delete
BEFORE DELETE ON generation_inputs
BEGIN
  SELECT RAISE(ABORT, 'generation inputs are immutable');
END;

CREATE TRIGGER revision_evidence_immutable_update
BEFORE UPDATE ON revision_evidence
BEGIN
  SELECT RAISE(ABORT, 'revision evidence is immutable');
END;

CREATE TRIGGER revision_evidence_immutable_delete
BEFORE DELETE ON revision_evidence
BEGIN
  SELECT RAISE(ABORT, 'revision evidence is immutable');
END;

INSERT INTO revision_evidence(
  revision_id,
  schema_version,
  direct_refs_json,
  transitive_refs_json,
  blob_hashes_json,
  bindings_json,
  binding_hash,
  created_at
)
SELECT
  r.id,
  1,
  '[]',
  '[]',
  '[]',
  '[]',
  '5c00daa83b222b01e61d7b1f67756be84f4694acc080d0d0aaf44c42435558ad',
  r.created_at
FROM revisions r
WHERE r.template_version_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM revision_refs rr WHERE rr.revision_id = r.id)
  AND (
    (
      json_extract(r.ast_json, '$.kind') = 'feishu_doc'
      AND json_array_length(json_extract(r.ast_json, '$.sections')) = 0
    )
    OR
    (
      json_extract(r.ast_json, '$.kind') = 'html_deck'
      AND json_array_length(json_extract(r.ast_json, '$.slides')) = 0
    )
  );
