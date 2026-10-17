-- Fixed travel execution only: no editable templates, dynamic fields or rule interpreter.
CREATE TABLE approval_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL UNIQUE REFERENCES applications(id) ON DELETE RESTRICT,
  rule_version VARCHAR(40) NOT NULL,
  submitted_version INTEGER NOT NULL CHECK (submitted_version > 1),
  route_snapshot JSONB NOT NULL CHECK (jsonb_typeof(route_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE approval_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES approval_instances(id) ON DELETE RESTRICT,
  seq_no INTEGER NOT NULL CHECK (seq_no > 0),
  step_name VARCHAR(80) NOT NULL,
  approver_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL CHECK (status IN ('blocked','pending','approved','rejected','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(instance_id, seq_no),
  UNIQUE(id, instance_id)
);
CREATE UNIQUE INDEX approval_tasks_one_pending_idx ON approval_tasks(instance_id) WHERE status='pending';
CREATE INDEX approval_tasks_assignee_idx ON approval_tasks(approver_id, created_at, id) WHERE status='pending';

CREATE TABLE approval_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES approval_instances(id) ON DELETE RESTRICT,
  task_id UUID,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action VARCHAR(20) NOT NULL CHECK (action IN ('submitted','approved','rejected','withdrawn')),
  opinion VARCHAR(2000) NOT NULL DEFAULT '',
  result VARCHAR(20) NOT NULL CHECK (result IN ('pending','approved','rejected','withdrawn')),
  application_version INTEGER NOT NULL CHECK (application_version > 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(task_id, instance_id) REFERENCES approval_tasks(id, instance_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX approval_logs_submission_idx ON approval_logs(instance_id) WHERE action='submitted';

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  app_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  event_key VARCHAR(100) NOT NULL,
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('approval.pending','application.approved','application.rejected','application.withdrawn')),
  title VARCHAR(240) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ,
  UNIQUE(recipient_id, event_key)
);
CREATE INDEX notifications_recipient_idx ON notifications(recipient_id, created_at DESC, id);

-- Execution snapshot and history are append-only, even when organization roles change.
CREATE FUNCTION preserve_approval_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approval history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER approval_instances_immutable BEFORE UPDATE OR DELETE ON approval_instances
  FOR EACH ROW EXECUTE FUNCTION preserve_approval_history();
CREATE TRIGGER approval_logs_immutable BEFORE UPDATE OR DELETE ON approval_logs
  FOR EACH ROW EXECUTE FUNCTION preserve_approval_history();
