-- Fixed procurement owner lists use creation time across all application states.
-- Existing shared task indexes already cover pending/handled assignee queries.
CREATE INDEX applications_purchase_applicant_created_idx
  ON applications(applicant_id, created_at DESC, id) WHERE type='purchase';
