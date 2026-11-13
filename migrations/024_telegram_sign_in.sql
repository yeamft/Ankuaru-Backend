-- Telegram sign-in: an account may sign in with Telegram instead of an email and password.
ALTER TABLE accounts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
-- Email and password still come together: an account has both or (Telegram-only) neither.
ALTER TABLE accounts ADD CONSTRAINT accounts_email_password_check
  CHECK ((email IS NULL) = (password_hash IS NULL));

-- One Telegram user per account and one account per Telegram user.
CREATE TABLE telegram_identities (
  telegram_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  username TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
