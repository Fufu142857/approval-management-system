-- Fixed travel list access paths. Preserve existing data and immutable snapshots.
CREATE INDEX applications_applicant_created_idx
  ON applications(applicant_id, created_at DESC, id) WHERE type='travel';
-- Activated time, rather than creation time, determines when a sequential task becomes pending.
DROP INDEX approval_tasks_assignee_idx;
CREATE INDEX approval_tasks_assignee_pending_idx
  ON approval_tasks(approver_id, activated_at DESC, id) WHERE status='pending';
CREATE INDEX approval_tasks_assignee_handled_idx
  ON approval_tasks(approver_id, finished_at DESC, id) WHERE status IN ('approved','rejected');
