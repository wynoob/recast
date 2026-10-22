ALTER TABLE occurrences ADD COLUMN position_key TEXT;
ALTER TABLE occurrences ADD COLUMN canonical_id TEXT REFERENCES occurrences(id) ON DELETE RESTRICT;

UPDATE occurrences SET position_key = CASE json_extract(locator_json, '$.kind')
  WHEN 'markdown' THEN json_array('markdown', json_extract(locator_json,'$.line'),
    json_extract(locator_json,'$.column'), json_extract(locator_json,'$.ordinal'), json_extract(locator_json,'$.rawTarget'))
  WHEN 'local_file' THEN json_array('local_file', json_extract(locator_json,'$.relativePath'))
  ELSE json_array(locator_json, occurrence_index) END;

CREATE TEMP TABLE occurrence_positions AS
  SELECT id, first_value(id) OVER (
    PARTITION BY source_version_id, position_key ORDER BY created_at, id
  ) AS canonical_id FROM occurrences;

UPDATE occurrences SET asset_id = COALESCE(asset_id, (
  SELECT other.asset_id FROM occurrences other JOIN occurrence_positions p ON p.id = other.id
  WHERE p.canonical_id = occurrences.id AND other.asset_id IS NOT NULL ORDER BY other.created_at, other.id LIMIT 1
)) WHERE id IN (SELECT canonical_id FROM occurrence_positions);
UPDATE occurrences SET media_status = 'available', media_error_code = NULL
  WHERE asset_id IS NOT NULL;

UPDATE occurrences SET canonical_id = (SELECT p.canonical_id FROM occurrence_positions p WHERE p.id = occurrences.id),
  position_key = NULL WHERE id IN (SELECT id FROM occurrence_positions WHERE id <> canonical_id);
DROP TABLE occurrence_positions;

CREATE UNIQUE INDEX idx_occurrence_position ON occurrences(source_version_id, position_key);
CREATE INDEX idx_occurrence_canonical ON occurrences(canonical_id);
CREATE VIEW canonical_occurrences AS SELECT * FROM occurrences WHERE canonical_id IS NULL;
