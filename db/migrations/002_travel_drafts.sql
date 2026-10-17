-- Allocate once when a draft is created. Gaps after rollback/deletion are intentional.
CREATE SEQUENCE application_number_seq AS BIGINT NO CYCLE;

CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_no VARCHAR(32) NOT NULL UNIQUE DEFAULT ('APP-' || nextval('application_number_seq')::text),
  title VARCHAR(200) NOT NULL DEFAULT '',
  applicant_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  type VARCHAR(20) NOT NULL DEFAULT 'travel' CHECK (type = 'travel'),
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'withdrawn')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  CHECK ((status = 'draft' AND submitted_at IS NULL)
    OR (status <> 'draft' AND submitted_at IS NOT NULL))
);
ALTER SEQUENCE application_number_seq OWNED BY applications.app_no;
CREATE INDEX applications_applicant_drafts_idx
  ON applications(applicant_id, updated_at DESC, id) WHERE status = 'draft';

-- Only fixed travel data. Flow versions, tasks and custom fields are not implemented here.
CREATE TABLE travel_requests (
  app_id UUID PRIMARY KEY REFERENCES applications(id) ON DELETE RESTRICT,
  departure VARCHAR(200) NOT NULL DEFAULT '',
  destination VARCHAR(200) NOT NULL DEFAULT '',
  start_date DATE CHECK (start_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  end_date DATE CHECK (end_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  purpose VARCHAR(2000) NOT NULL DEFAULT '',
  companions VARCHAR(1000) NOT NULL DEFAULT '',
  transportation VARCHAR(100) NOT NULL DEFAULT '',
  budget NUMERIC(14,2) CHECK (budget BETWEEN 0 AND 999999999999.99),
  remarks VARCHAR(2000) NOT NULL DEFAULT '',
  duration_days INTEGER GENERATED ALWAYS AS (end_date - start_date + 1) STORED,
  CHECK (end_date >= start_date)
);
