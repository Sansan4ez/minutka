CREATE TABLE minutka_private.artifact_contents (
  user_id text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, content_digest),
  CONSTRAINT artifact_contents_owner_fk FOREIGN KEY (user_id)
    REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE
);

CREATE TABLE minutka_private.artifacts (
  artifact_id text NOT NULL,
  user_id text NOT NULL,
  delivery_key text NOT NULL,
  content_digest text NOT NULL,
  original_file_name text NOT NULL CHECK (length(btrim(original_file_name)) > 0),
  declared_media_type text,
  detected_media_type text,
  source jsonb NOT NULL,
  caption text,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, artifact_id),
  UNIQUE (user_id, delivery_key),
  CONSTRAINT artifacts_content_fk FOREIGN KEY (user_id, content_digest)
    REFERENCES minutka_private.artifact_contents(user_id, content_digest),
  CONSTRAINT artifacts_owner_fk FOREIGN KEY (user_id)
    REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  CHECK ((status = 'active' AND deleted_at IS NULL) OR (status = 'deleted' AND deleted_at IS NOT NULL))
);

CREATE INDEX artifacts_owner_status_created_idx
  ON minutka_private.artifacts(user_id, status, created_at, artifact_id);
CREATE INDEX artifacts_owner_digest_idx
  ON minutka_private.artifacts(user_id, content_digest);

GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.artifact_contents TO minutka_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON minutka_private.artifacts TO minutka_runtime;
