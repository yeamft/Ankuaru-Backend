-- Traders verify their phone with an SMS code once, then sign in with a PIN.
ALTER TABLE accounts ADD COLUMN pin_hash TEXT;
-- Wrong PINs in a row; at the limit the PIN stops working until an SMS code sign-in.
ALTER TABLE accounts ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD CONSTRAINT accounts_pin_failed_attempts_check CHECK (pin_failed_attempts >= 0);
