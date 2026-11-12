BEGIN;

CREATE SCHEMA history;

CREATE TABLE history.chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seq BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT chats_type_chk CHECK (type IN ('personal', 'group')),
    CONSTRAINT chats_last_seq_chk CHECK (last_seq BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE history.chat_members (
    chat_id UUID NOT NULL REFERENCES history.chats (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    role TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_delivered_seq BIGINT NOT NULL DEFAULT 0,
    last_read_seq BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id),
    CONSTRAINT chat_members_role_chk CHECK (role IN ('owner', 'member')),
    CONSTRAINT chat_members_last_delivered_seq_chk
        CHECK (last_delivered_seq BETWEEN 0 AND 9007199254740991),
    CONSTRAINT chat_members_last_read_seq_chk
        CHECK (last_read_seq BETWEEN 0 AND 9007199254740991),
    CONSTRAINT chat_members_read_before_delivered_chk
        CHECK (last_read_seq <= last_delivered_seq)
);

CREATE INDEX chat_members_user_chat_idx
    ON history.chat_members (user_id, chat_id);

CREATE TABLE history.personal_chat_pairs (
    user_low_id UUID NOT NULL,
    user_high_id UUID NOT NULL,
    chat_id UUID NOT NULL UNIQUE REFERENCES history.chats (id) ON DELETE CASCADE,
    PRIMARY KEY (user_low_id, user_high_id),
    CONSTRAINT personal_chat_pairs_order_chk CHECK (user_low_id < user_high_id)
);

CREATE TABLE history.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES history.chats (id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    sender_id UUID NOT NULL,
    client_msg_id UUID NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messages_seq_chk CHECK (seq BETWEEN 1 AND 9007199254740991),
    CONSTRAINT messages_body_length_chk CHECK (char_length(body) BETWEEN 1 AND 4096),
    CONSTRAINT messages_sender_membership_fk
        FOREIGN KEY (chat_id, sender_id)
        REFERENCES history.chat_members (chat_id, user_id)
);

CREATE UNIQUE INDEX messages_chat_seq_uq
    ON history.messages (chat_id, seq DESC);

CREATE UNIQUE INDEX messages_idempotency_uq
    ON history.messages (chat_id, sender_id, client_msg_id);

COMMIT;
