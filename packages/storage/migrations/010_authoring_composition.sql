CREATE TABLE authoring_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  based_on_version INTEGER NOT NULL CHECK (based_on_version >= 0),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  proposal_hash TEXT NOT NULL CHECK (length(proposal_hash) = 64),
  recommend_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(content_id, based_on_version)
);
CREATE TRIGGER authoring_proposals_immutable_update BEFORE UPDATE ON authoring_proposals
BEGIN SELECT RAISE(ABORT, 'proposal is immutable'); END;
CREATE TRIGGER authoring_proposals_immutable_delete BEFORE DELETE ON authoring_proposals
BEGIN SELECT RAISE(ABORT, 'proposal is immutable'); END;
ALTER TABLE authoring_confirmations ADD COLUMN proposal_id TEXT REFERENCES authoring_proposals(id) ON DELETE RESTRICT;
ALTER TABLE authoring_confirmations ADD COLUMN composition_snapshot_json TEXT CHECK (composition_snapshot_json IS NULL OR json_valid(composition_snapshot_json));
ALTER TABLE authoring_confirmations ADD COLUMN composition_snapshot_hash TEXT CHECK (composition_snapshot_hash IS NULL OR length(composition_snapshot_hash) = 64);
CREATE UNIQUE INDEX idx_composition_confirmation_proposal ON authoring_confirmations(proposal_id) WHERE proposal_id IS NOT NULL;
CREATE UNIQUE INDEX idx_composition_confirmation_content ON authoring_confirmations(content_id) WHERE proposal_id IS NOT NULL;
ALTER TABLE jobs ADD COLUMN business_key TEXT;
CREATE UNIQUE INDEX idx_jobs_business_key ON jobs(business_key) WHERE business_key IS NOT NULL;
ALTER TABLE exports ADD COLUMN business_key TEXT;
ALTER TABLE exports ADD COLUMN composition_request_hash TEXT CHECK (composition_request_hash IS NULL OR length(composition_request_hash) = 64);
CREATE UNIQUE INDEX idx_exports_business_key ON exports(business_key) WHERE business_key IS NOT NULL;
ALTER TABLE output_job_decisions ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0 CHECK (decision_version >= 0);
ALTER TABLE generation_inputs ADD COLUMN composition_snapshot_hash TEXT CHECK (composition_snapshot_hash IS NULL OR length(composition_snapshot_hash) = 64);
