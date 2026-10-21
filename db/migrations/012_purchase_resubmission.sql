-- Extend the existing immutable retry chain to fixed purchase only.
-- Preserve the function/trigger identity and all existing travel links.
CREATE OR REPLACE FUNCTION preserve_travel_resubmission() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NOT FOUND OR source.type NOT IN ('travel','purchase') OR NEW.type <> source.type
      OR source.applicant_id <> NEW.applicant_id
      OR source.status NOT IN ('rejected','withdrawn') OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Invalid fixed business resubmission source' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
