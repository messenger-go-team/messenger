BEGIN;

ALTER TABLE history.chat_members
    DROP COLUMN public_last_delivered_seq,
    DROP COLUMN public_last_read_seq;

COMMIT;
