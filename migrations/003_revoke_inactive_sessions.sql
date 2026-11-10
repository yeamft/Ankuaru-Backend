-- A restored trader must sign in again. Merely filtering suspended accounts
-- during authentication would make their old tokens valid after restoration.
CREATE FUNCTION revoke_inactive_trader_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'Active' THEN
    -- Login locks the trader first, then the account, in the same order.
    PERFORM id FROM accounts WHERE id = NEW.id FOR UPDATE;
    DELETE FROM account_sessions WHERE account_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER traders_revoke_sessions
AFTER UPDATE OF status ON traders
FOR EACH ROW EXECUTE FUNCTION revoke_inactive_trader_sessions();

-- Apply the invariant to any accounts suspended before this migration.
DELETE FROM account_sessions s
USING traders t WHERE s.account_id = t.id AND t.status <> 'Active';
