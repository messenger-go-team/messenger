BEGIN;

CREATE TABLE history.presence_deliveries (
    chat_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    PRIMARY KEY (chat_id, grant_id)
);

CREATE INDEX presence_deliveries_grant_idx ON history.presence_deliveries (grant_id);

-- Locks are ordered by actual lock key. A mutation in progress should not
-- hold up unrelated authorizations in the same batch.
CREATE FUNCTION history.lock_presence_delivery(chat_ids uuid[]) RETURNS uuid[]
LANGUAGE plpgsql AS $$
DECLARE
    id uuid;
    locked uuid[] := '{}'::uuid[];
BEGIN
    FOR id IN
        SELECT candidate FROM (SELECT DISTINCT unnest(chat_ids) AS candidate) AS candidates
        ORDER BY hashtext(candidate::text), candidate
    LOOP
        IF pg_try_advisory_xact_lock_shared(132, hashtext(id::text)) THEN
            locked := array_append(locked, id);
        END IF;
    END LOOP;
    RETURN locked;
END;
$$;

-- Once the caller holds the exclusive chat locks (or the membership table
-- for TRUNCATE), no new grants for the affected chats can commit. A grant
-- finishes promptly on release. Waiting a complete 12 seconds also covers
-- process failure, lost releases and a transaction with a fixed snapshot.
CREATE FUNCTION history.wait_presence_deliveries(chat_ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
        PERFORM pg_sleep(12);
        RETURN;
    END IF;
    FOR attempt IN 1..240 LOOP
        IF NOT EXISTS (
            SELECT 1 FROM history.presence_deliveries
            WHERE chat_ids IS NULL OR chat_id = ANY(chat_ids)
        ) THEN
            RETURN;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
    DELETE FROM history.presence_deliveries
    WHERE chat_ids IS NULL OR chat_id = ANY(chat_ids);
END;
$$;

CREATE FUNCTION history.guard_presence_members() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(132, lock_key)
    FROM (
        SELECT DISTINCT hashtext(chat_id::text) AS lock_key
        FROM affected_members
        ORDER BY lock_key
    ) AS keys;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Under READ COMMITTED this check sees changes committed while waiting
    -- for the exclusive locks. An insert leaving at most two members cannot
    -- revoke a two-person authorization. Repeatable snapshots must wait.
    IF TG_OP = 'DELETE' OR current_setting('transaction_isolation') <> 'read committed'
       OR EXISTS (
           SELECT 1 FROM history.chat_members
           WHERE chat_id IN (SELECT chat_id FROM affected_members)
           GROUP BY chat_id
           HAVING count(*) > 2
       ) THEN
        PERFORM history.wait_presence_deliveries(ARRAY(SELECT DISTINCT chat_id FROM affected_members));
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER presence_guard_member_insert
AFTER INSERT ON history.chat_members
REFERENCING NEW TABLE AS affected_members
FOR EACH STATEMENT EXECUTE FUNCTION history.guard_presence_members();

CREATE TRIGGER presence_guard_member_delete
AFTER DELETE ON history.chat_members
REFERENCING OLD TABLE AS affected_members
FOR EACH STATEMENT EXECUTE FUNCTION history.guard_presence_members();

CREATE FUNCTION history.guard_presence_member_move() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(132, lock_key)
    FROM (
        SELECT DISTINCT hashtext(id::text) AS lock_key
        FROM (VALUES (OLD.chat_id), (NEW.chat_id)) AS ids(id)
        ORDER BY lock_key
    ) AS keys;
    PERFORM history.wait_presence_deliveries(ARRAY[OLD.chat_id, NEW.chat_id]);
    RETURN NULL;
END;
$$;

CREATE TRIGGER presence_guard_member_move
AFTER UPDATE OF chat_id, user_id ON history.chat_members
FOR EACH ROW
WHEN (OLD.chat_id IS DISTINCT FROM NEW.chat_id OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION history.guard_presence_member_move();

CREATE FUNCTION history.guard_presence_chat_type() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(132, hashtext(OLD.id::text));
    PERFORM history.wait_presence_deliveries(ARRAY[OLD.id]);
    RETURN NULL;
END;
$$;

CREATE TRIGGER presence_guard_chat_type
AFTER UPDATE OF type ON history.chats
FOR EACH ROW
WHEN (OLD.type = 'personal' AND NEW.type <> 'personal')
EXECUTE FUNCTION history.guard_presence_chat_type();

CREATE FUNCTION history.guard_presence_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- TRUNCATE holds ACCESS EXCLUSIVE until commit. Any existing authorizing
    -- transaction must already have finished before this statement can run.
    PERFORM history.wait_presence_deliveries(NULL);
    RETURN NULL;
END;
$$;

CREATE TRIGGER presence_guard_member_truncate
AFTER TRUNCATE ON history.chat_members
FOR EACH STATEMENT EXECUTE FUNCTION history.guard_presence_truncate();

COMMIT;
