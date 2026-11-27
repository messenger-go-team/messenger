\getenv auth_password QA_AUTH_DB_PASSWORD
\getenv history_password QA_HISTORY_DB_PASSWORD

BEGIN;
SELECT 'CREATE ROLE qa_auth LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qa_auth') \gexec
SELECT 'CREATE ROLE qa_history LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qa_history') \gexec
ALTER ROLE qa_auth PASSWORD :'auth_password';
ALTER ROLE qa_history PASSWORD :'history_password';

GRANT USAGE ON SCHEMA auth TO qa_auth;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA auth TO qa_auth;
GRANT UPDATE ON auth.refresh_tokens TO qa_auth;
GRANT DELETE ON auth.contacts TO qa_auth;

GRANT USAGE ON SCHEMA history TO qa_history;
GRANT SELECT, INSERT ON history.chats, history.chat_members, history.personal_chat_pairs,
    history.messages, history.later_entries, history.presence_deliveries TO qa_history;
GRANT DELETE ON history.presence_deliveries TO qa_history;
GRANT UPDATE (last_seq) ON history.chats TO qa_history;
GRANT UPDATE (last_read_seq, last_delivered_seq, public_last_read_seq, public_last_delivered_seq)
    ON history.chat_members TO qa_history;
GRANT UPDATE (id) ON history.messages TO qa_history;
GRANT UPDATE (due_at, state, updated_at) ON history.later_entries TO qa_history;

CREATE SCHEMA IF NOT EXISTS qa_control;
CREATE TABLE IF NOT EXISTS qa_control.gates (
    operation text NOT NULL CHECK (operation IN ('save', 'read')),
    chat_id uuid NOT NULL,
    mode text NOT NULL CHECK (mode IN ('hold', 'reject')),
    until_at timestamptz NOT NULL,
    PRIMARY KEY (operation, chat_id)
);

-- Runs within the transaction, after acquisition of the chat row lock.
-- A volatile function sees each separately committed release at READ COMMITTED.
CREATE OR REPLACE FUNCTION qa_control.before_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    active_mode text;
    deadline timestamptz;
    announced boolean := false;
    save_hold_until timestamptz;
BEGIN
    LOOP
        SELECT mode, until_at INTO active_mode, deadline
        FROM qa_control.gates
        WHERE operation = TG_ARGV[0] AND chat_id = NEW.chat_id
            AND until_at > clock_timestamp();
        IF NOT FOUND OR clock_timestamp() >= save_hold_until THEN
            IF announced THEN
                RAISE LOG 'QA_GATE released % %', TG_ARGV[0], NEW.chat_id;
            END IF;
            RETURN NEW;
        END IF;
        IF active_mode = 'reject' THEN
            RAISE LOG 'QA_GATE rejected % %', TG_ARGV[0], NEW.chat_id;
            RAISE EXCEPTION SQLSTATE '08006' USING MESSAGE = 'QA staging forced rollback';
        END IF;
        IF NOT announced THEN
            RAISE LOG 'QA_GATE held % %', TG_ARGV[0], NEW.chat_id;
            announced := true;
            IF TG_ARGV[0] = 'save' THEN
                -- Chat's RPC deadline is 3s. Leave enough time to finish the real commit.
                save_hold_until := clock_timestamp() + interval '1200 milliseconds';
            END IF;
        END IF;
        PERFORM pg_sleep(least(0.05, greatest(0, extract(epoch FROM deadline - clock_timestamp()))));
    END LOOP;
END;
$$;

CREATE OR REPLACE TRIGGER qa_before_save BEFORE INSERT ON history.messages
    FOR EACH ROW EXECUTE FUNCTION qa_control.before_write('save');
CREATE OR REPLACE TRIGGER qa_before_read BEFORE UPDATE OF last_read_seq ON history.chat_members
    FOR EACH ROW EXECUTE FUNCTION qa_control.before_write('read');
COMMIT;
