-- Activation distinguishes a cancelled current task from a never-visible future task.
ALTER TABLE approval_tasks ADD COLUMN activated_at TIMESTAMPTZ;
ALTER TABLE approval_tasks ADD COLUMN finished_at TIMESTAMPTZ;
UPDATE approval_tasks SET activated_at=created_at WHERE status='pending';
ALTER TABLE approval_tasks ADD CONSTRAINT approval_tasks_times CHECK (
  (status='blocked' AND activated_at IS NULL AND finished_at IS NULL) OR
  (status='pending' AND activated_at IS NOT NULL AND finished_at IS NULL) OR
  (status IN ('approved','rejected') AND activated_at IS NOT NULL AND finished_at IS NOT NULL) OR
  (status='cancelled' AND finished_at IS NOT NULL)
);
CREATE UNIQUE INDEX approval_logs_version_idx ON approval_logs(instance_id, application_version);
CREATE UNIQUE INDEX approval_logs_task_decision_idx ON approval_logs(task_id)
  WHERE action IN ('approved','rejected');
