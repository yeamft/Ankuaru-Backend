-- Permissions each configurable staff role holds. Super admins are not stored:
-- they always hold every permission, so administration can never be locked out.
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission),
  CONSTRAINT role_permissions_role_check
    CHECK (role IN ('moderator', 'content_manager', 'platform_admin'))
);

INSERT INTO role_permissions (role, permission)
VALUES
  ('moderator', 'console.view'),
  ('moderator', 'moderation.manage'),
  ('moderator', 'kyc.review'),
  ('content_manager', 'console.view'),
  ('content_manager', 'content.manage'),
  ('platform_admin', 'console.view'),
  ('platform_admin', 'moderation.manage'),
  ('platform_admin', 'kyc.review'),
  ('platform_admin', 'content.manage'),
  ('platform_admin', 'users.manage'),
  ('platform_admin', 'settings.manage')
ON CONFLICT DO NOTHING;
