-- Staff roles replace the single "admin" role. Existing administrators keep
-- full access as super admins.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_account_role_check;
UPDATE accounts SET account_role = 'super_admin' WHERE account_role = 'admin';
ALTER TABLE accounts ADD CONSTRAINT accounts_account_role_check
  CHECK (account_role IN ('user', 'moderator', 'content_manager', 'platform_admin', 'super_admin'));
