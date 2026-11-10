-- Platform admins manage the product catalog by default; super admins always can.
INSERT INTO role_permissions (role, permission)
VALUES ('platform_admin', 'catalog.manage')
ON CONFLICT DO NOTHING;
