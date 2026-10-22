-- Each receipt record belongs to exactly one item of the same reimbursement.
ALTER TABLE attachments ADD COLUMN reimbursement_item_id UUID;
ALTER TABLE attachments ADD COLUMN receipt_number VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE attachments ADD CONSTRAINT attachments_reimbursement_item_fk
  FOREIGN KEY (reimbursement_item_id, app_id) REFERENCES reimbursement_items(id, app_id) ON DELETE RESTRICT;
ALTER TABLE attachments ADD CONSTRAINT attachments_receipt_number_check
  CHECK (receipt_number = btrim(receipt_number) AND receipt_number !~ '[[:cntrl:]]');
CREATE INDEX attachments_reimbursement_item_idx ON attachments(reimbursement_item_id) WHERE reimbursement_item_id IS NOT NULL;

CREATE FUNCTION guard_reimbursement_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent applications%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.reimbursement_item_id IS NOT NULL OR NEW.reimbursement_item_id IS NOT NULL
    OR OLD.receipt_number<>'' OR NEW.receipt_number<>'') THEN
    RAISE EXCEPTION 'Receipt attachment metadata is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO parent FROM applications
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.app_id ELSE NEW.app_id END FOR UPDATE;
  IF parent.type='reimbursement' THEN
    IF TG_OP='UPDATE' OR parent.status<>'draft' THEN
      RAISE EXCEPTION 'Receipt attachments require a draft' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' AND (NEW.reimbursement_item_id IS NULL OR NEW.supplier_quote_id IS NOT NULL
      OR NEW.uploader_id<>parent.applicant_id) THEN
      RAISE EXCEPTION 'Receipt attachments require an item and applicant uploader' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP<>'DELETE' AND (NEW.reimbursement_item_id IS NOT NULL OR NEW.receipt_number<>'') THEN
    RAISE EXCEPTION 'Receipt attachments require reimbursement type' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachments_reimbursement_guard BEFORE INSERT OR UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_reimbursement_attachment();
