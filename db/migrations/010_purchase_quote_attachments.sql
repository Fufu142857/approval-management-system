-- Purchase quotation evidence. Existing travel files keep a null quote reference.
ALTER TABLE attachments ADD COLUMN supplier_quote_id UUID;
ALTER TABLE attachments ADD CONSTRAINT attachments_purchase_quote_fk
  FOREIGN KEY (supplier_quote_id, app_id) REFERENCES supplier_quotes(id, app_id) ON DELETE RESTRICT;
CREATE INDEX attachments_supplier_quote_idx ON attachments(supplier_quote_id) WHERE supplier_quote_id IS NOT NULL;

CREATE FUNCTION guard_purchase_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent applications%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.supplier_quote_id IS NOT NULL OR NEW.supplier_quote_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Purchase attachment metadata is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO parent FROM applications
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.app_id ELSE NEW.app_id END FOR UPDATE;
  IF parent.type='purchase' THEN
    IF TG_OP='UPDATE' OR parent.status<>'draft' THEN
      RAISE EXCEPTION 'Purchase attachments require a draft' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' AND (NEW.supplier_quote_id IS NULL OR NEW.uploader_id<>parent.applicant_id) THEN
      RAISE EXCEPTION 'Purchase attachments require a quote and applicant uploader' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP<>'DELETE' AND NEW.supplier_quote_id IS NOT NULL THEN
    RAISE EXCEPTION 'Quote attachments require purchase type' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachments_purchase_guard BEFORE INSERT OR UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_purchase_attachment();
