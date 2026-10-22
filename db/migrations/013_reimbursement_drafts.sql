-- Fixed reimbursement drafts and links to owned, approved travel/purchase only.
ALTER TABLE applications DROP CONSTRAINT applications_type_check;
ALTER TABLE applications ADD CONSTRAINT applications_type_check
  CHECK (type IN ('travel','purchase','reimbursement'));

CREATE TABLE reimbursement_requests (
  app_id UUID PRIMARY KEY REFERENCES applications(id) ON DELETE RESTRICT,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  independent_reason VARCHAR(2000) NOT NULL DEFAULT '',
  remarks VARCHAR(2000) NOT NULL DEFAULT ''
);
CREATE TABLE reimbursement_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES reimbursement_requests(app_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100),
  category VARCHAR(20) CHECK (category IN ('transport','lodging','meals','office','other')),
  expense_date DATE CHECK (expense_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  purpose VARCHAR(2000) NOT NULL DEFAULT '',
  amount NUMERIC(14,2) CHECK (amount > 0 AND amount <= 999999999999.99),
  no_receipt BOOLEAN NOT NULL DEFAULT false,
  no_receipt_reason VARCHAR(2000) NOT NULL DEFAULT '',
  UNIQUE(app_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, app_id)
);
CREATE TABLE application_links (
  source_app_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  target_app_id UUID NOT NULL REFERENCES reimbursement_requests(app_id) ON DELETE RESTRICT,
  PRIMARY KEY (source_app_id, target_app_id),
  CHECK (source_app_id <> target_app_id)
);
CREATE INDEX application_links_target_idx ON application_links(target_app_id, source_app_id);

CREATE FUNCTION guard_reimbursement_draft_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application_id UUID; parent applications%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.app_id<>OLD.app_id OR
    (TG_TABLE_NAME='reimbursement_items' AND to_jsonb(NEW)->>'id'<>to_jsonb(OLD)->>'id')) THEN
    RAISE EXCEPTION 'Reimbursement detail identity is immutable' USING ERRCODE='23514';
  END IF;
  application_id := CASE WHEN TG_OP='DELETE' THEN OLD.app_id ELSE NEW.app_id END;
  SELECT * INTO parent FROM applications WHERE id=application_id FOR UPDATE;
  IF parent.type IS DISTINCT FROM 'reimbursement' OR parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Reimbursement details require a draft' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reimbursement_requests_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON reimbursement_requests
  FOR EACH ROW EXECUTE FUNCTION guard_reimbursement_draft_detail();
CREATE TRIGGER reimbursement_items_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON reimbursement_items
  FOR EACH ROW EXECUTE FUNCTION guard_reimbursement_draft_detail();

CREATE FUNCTION guard_reimbursement_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target applications%ROWTYPE; source applications%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Replace reimbursement links explicitly' USING ERRCODE='23514';
  END IF;
  SELECT * INTO target FROM applications
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.target_app_id ELSE NEW.target_app_id END FOR UPDATE;
  IF target.type IS DISTINCT FROM 'reimbursement' OR target.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Reimbursement links require a draft' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO source FROM applications WHERE id=NEW.source_app_id FOR SHARE;
  IF NOT FOUND OR source.type NOT IN ('travel','purchase') OR source.status<>'approved'
    OR source.applicant_id<>target.applicant_id THEN
    RAISE EXCEPTION 'Reimbursement source must be owned and approved' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_links_guard BEFORE INSERT OR UPDATE OR DELETE ON application_links
  FOR EACH ROW EXECUTE FUNCTION guard_reimbursement_link();

CREATE FUNCTION preserve_reimbursement_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.type<>OLD.type OR NEW.applicant_id<>OLD.applicant_id)
    AND (NEW.type='reimbursement' OR OLD.type='reimbursement') THEN
    RAISE EXCEPTION 'Reimbursement identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER applications_reimbursement_identity_guard BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION preserve_reimbursement_identity();
