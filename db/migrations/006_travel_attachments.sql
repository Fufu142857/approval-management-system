-- Fixed travel supplemental files only. No dynamic fields or custom template attachments.
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_key UUID NOT NULL UNIQUE,
  original_name VARCHAR(180) NOT NULL,
  mime_type VARCHAR(30) NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','application/pdf')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX attachments_application_idx ON attachments(app_id, created_at, id);
