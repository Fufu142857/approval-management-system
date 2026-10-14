CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(32) NOT NULL CHECK (username ~ '^[a-z][a-z0-9_]{2,31}$'),
  full_name VARCHAR(80) NOT NULL CHECK (length(trim(full_name)) > 0),
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  requested_department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  department_id UUID REFERENCES departments(id) ON DELETE RESTRICT,
  registration_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (registration_status IN ('pending', 'active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (registration_status <> 'active' OR department_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_unique ON users (lower(username));
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code VARCHAR(32) NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  operation VARCHAR(80) NOT NULL,
  target_id UUID,
  before_data JSONB,
  after_data JSONB,
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_logs_created_idx ON admin_audit_logs(created_at DESC, id);

CREATE TABLE auth_rate_limits (
  bucket CHAR(64) PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles (code, name) VALUES
  ('employee', '普通员工'),
  ('department_head', '部门负责人'),
  ('finance_approver', '财务审批人'),
  ('company_head', '企业负责人'),
  ('system_admin', '系统管理员');
