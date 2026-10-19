-- Fixed purchase drafts only; no workflow templates or dynamic fields.
ALTER TABLE applications DROP CONSTRAINT applications_type_check;
ALTER TABLE applications ADD CONSTRAINT applications_type_check CHECK (type IN ('travel','purchase'));

CREATE TABLE purchase_requests (
  app_id UUID PRIMARY KEY REFERENCES applications(id) ON DELETE RESTRICT,
  reason VARCHAR(2000) NOT NULL DEFAULT '',
  expected_date DATE CHECK (expected_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  project VARCHAR(200) NOT NULL DEFAULT '',
  budget_limit NUMERIC(14,2) CHECK (budget_limit BETWEEN 0 AND 999999999999.99),
  selection_reason VARCHAR(2000) NOT NULL DEFAULT '',
  single_source BOOLEAN NOT NULL DEFAULT false,
  single_source_reason VARCHAR(2000) NOT NULL DEFAULT '',
  remarks VARCHAR(2000) NOT NULL DEFAULT ''
);
CREATE TABLE purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES purchase_requests(app_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100),
  name VARCHAR(200) NOT NULL DEFAULT '',
  specification VARCHAR(500) NOT NULL DEFAULT '',
  quantity NUMERIC(12,3) CHECK (quantity > 0 AND quantity <= 999999999.999),
  unit VARCHAR(40) NOT NULL DEFAULT '',
  unit_price NUMERIC(14,2) CHECK (unit_price > 0 AND unit_price <= 999999999999.99),
  amount NUMERIC(14,2) GENERATED ALWAYS AS (round(quantity * unit_price,2)) STORED,
  UNIQUE(app_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, app_id)
);
CREATE TABLE supplier_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES purchase_requests(app_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
  supplier_name VARCHAR(200) NOT NULL DEFAULT '',
  quote_date DATE CHECK (quote_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  amount NUMERIC(14,2) CHECK (amount > 0 AND amount <= 999999999999.99),
  basis VARCHAR(2000) NOT NULL DEFAULT '',
  purchase_url VARCHAR(2000) NOT NULL DEFAULT '',
  is_online BOOLEAN NOT NULL DEFAULT false,
  selected BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(app_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id, app_id)
);
CREATE UNIQUE INDEX supplier_quotes_one_selected_idx ON supplier_quotes(app_id) WHERE selected;

-- Detail writes use the same application lock as draft updates and future submission.
CREATE FUNCTION guard_purchase_draft_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application_id UUID; application_type TEXT; application_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.app_id <> OLD.app_id OR
    (TG_TABLE_NAME <> 'purchase_requests' AND to_jsonb(NEW)->>'id' <> to_jsonb(OLD)->>'id')) THEN
    RAISE EXCEPTION 'Purchase detail identity is immutable' USING ERRCODE = '23514';
  END IF;
  application_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.app_id ELSE NEW.app_id END;
  SELECT type,status INTO application_type,application_status FROM applications WHERE id=application_id FOR UPDATE;
  IF application_type IS DISTINCT FROM 'purchase' OR application_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Purchase details require an owned purchase draft transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_requests_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_detail();
CREATE TRIGGER purchase_items_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_detail();
CREATE TRIGGER supplier_quotes_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_quotes
  FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_detail();
CREATE FUNCTION preserve_purchase_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type <> OLD.type AND (NEW.type='purchase' OR OLD.type='purchase') THEN
    RAISE EXCEPTION 'Purchase application type is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER applications_purchase_type_guard BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION preserve_purchase_type();
