BEGIN;

ALTER TABLE history.chat_members
    ADD COLUMN public_last_delivered_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN public_last_read_seq BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT chat_members_public_receipts_chk
        CHECK (0 <= public_last_read_seq
            AND public_last_read_seq <= public_last_delivered_seq
            AND public_last_delivered_seq <= 9007199254740991);

COMMIT;
