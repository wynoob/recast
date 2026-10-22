ALTER TABLE ai_candidates ADD COLUMN acceptance_binding_json TEXT
  CHECK (acceptance_binding_json IS NULL OR json_valid(acceptance_binding_json));
ALTER TABLE ai_candidates ADD COLUMN rejected_reason TEXT;
ALTER TABLE ai_candidates ADD COLUMN claims_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(claims_json));

CREATE TABLE revision_fixed_evidence (
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  evidence_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'fact', 'media', 'user_assertion')),
  entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
  entity_hash TEXT NOT NULL CHECK (length(entity_hash) = 64),
  index_text_hash TEXT CHECK (index_text_hash IS NULL OR length(index_text_hash) = 64),
  binding_hash TEXT CHECK (binding_hash IS NULL OR length(binding_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (revision_id, evidence_id)
);

CREATE TABLE authoring_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  selection_handle TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'fact', 'media', 'user_assertion')),
  entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
  entity_hash TEXT NOT NULL CHECK (length(entity_hash) = 64),
  index_text_hash TEXT CHECK (index_text_hash IS NULL OR length(index_text_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (content_id, selection_handle, kind)
);

CREATE TABLE provider_calls (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  logical_call_id TEXT NOT NULL CHECK (logical_call_id LIKE 'call1:%'),
  request_hash TEXT NOT NULL CHECK (request_hash LIKE 'rh1:%'),
  request_envelope_json TEXT NOT NULL CHECK (json_valid(request_envelope_json)),
  purpose TEXT NOT NULL,
  call_ordinal INTEGER NOT NULL CHECK (call_ordinal >= 0),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
  role TEXT NOT NULL CHECK (role IN ('text', 'embedding', 'vision', 'asr')),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  fence_attempt INTEGER NOT NULL CHECK (fence_attempt > 0),
  fence_lease_generation INTEGER NOT NULL CHECK (fence_lease_generation > 0),
  lease_owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'completed', 'cancelled', 'unknown', 'failed')),
  provider_request_id TEXT,
  response_hash TEXT CHECK (response_hash IS NULL OR response_hash LIKE 'resp1:%'),
  cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
  error_code TEXT,
  prepared_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, logical_call_id)
);

CREATE TABLE provider_call_payloads (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES provider_calls(attempt_id) ON DELETE RESTRICT,
  request_envelope_json TEXT NOT NULL CHECK (json_valid(request_envelope_json)),
  raw_response TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE provider_late_responses (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES provider_calls(attempt_id) ON DELETE RESTRICT,
  response_hash TEXT NOT NULL CHECK (response_hash LIKE 'resp1:%'),
  raw_response TEXT NOT NULL,
  provider_request_id TEXT,
  cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
  effective INTEGER NOT NULL CHECK (effective = 0),
  received_at TEXT NOT NULL
);

ALTER TABLE jobs ADD COLUMN recovery_policy TEXT NOT NULL DEFAULT 'local'
  CHECK (recovery_policy IN ('local', 'provider_fenced'));

CREATE INDEX idx_provider_configs_role ON provider_configs(role, updated_at DESC);
CREATE INDEX idx_provider_calls_job_state ON provider_calls(job_id, state, prepared_at);
CREATE INDEX idx_provider_calls_logical ON provider_calls(logical_call_id, attempt_ordinal);
CREATE INDEX idx_provider_calls_fence ON provider_calls(job_id, fence_attempt, fence_lease_generation);
CREATE INDEX idx_provider_late_attempt ON provider_late_responses(attempt_id, received_at);
CREATE INDEX idx_revision_fixed_evidence_hash ON revision_fixed_evidence(entity_hash);
CREATE INDEX idx_authoring_evidence_content ON authoring_evidence(content_id, created_at DESC);

CREATE TRIGGER revision_fixed_evidence_immutable_update
BEFORE UPDATE ON revision_fixed_evidence
BEGIN
  SELECT RAISE(ABORT, 'revision fixed evidence is immutable');
END;

CREATE TRIGGER revision_fixed_evidence_immutable_delete
BEFORE DELETE ON revision_fixed_evidence
BEGIN
  SELECT RAISE(ABORT, 'revision fixed evidence is immutable');
END;

CREATE TRIGGER provider_call_payloads_immutable_update
BEFORE UPDATE ON provider_call_payloads
BEGIN
  SELECT RAISE(ABORT, 'provider call payloads are immutable');
END;

CREATE TRIGGER provider_call_payloads_immutable_delete
BEFORE DELETE ON provider_call_payloads
BEGIN
  SELECT RAISE(ABORT, 'provider call payloads are immutable');
END;
