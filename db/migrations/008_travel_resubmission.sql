-- A fixed-travel retry chain. Each source has at most one surviving successor.
-- Deleting an unsubmitted successor frees the source; submitted history is retained.
ALTER TABLE applications ADD COLUMN resubmission_of UUID
  REFERENCES applications(id) ON DELETE RESTRICT;
ALTER TABLE applications ADD CONSTRAINT applications_resubmission_unique UNIQUE (resubmission_of);
ALTER TABLE applications ADD CONSTRAINT applications_resubmission_not_self CHECK (resubmission_of <> id);

CREATE FUNCTION preserve_travel_resubmission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source applications%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.resubmission_of IS DISTINCT FROM OLD.resubmission_of
      OR (OLD.resubmission_of IS NOT NULL AND
        (NEW.applicant_id <> OLD.applicant_id OR NEW.type <> OLD.type)) THEN
      RAISE EXCEPTION 'Resubmission provenance is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.resubmission_of IS NOT NULL THEN
    SELECT * INTO source FROM applications WHERE id=NEW.resubmission_of;
    IF NOT FOUND OR source.type <> 'travel' OR NEW.type <> 'travel'
      OR source.applicant_id <> NEW.applicant_id
      OR source.status NOT IN ('rejected','withdrawn') OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Invalid fixed travel resubmission source' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER applications_resubmission_guard BEFORE INSERT OR UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION preserve_travel_resubmission();
