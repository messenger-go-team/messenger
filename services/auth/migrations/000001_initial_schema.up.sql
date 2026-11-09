BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(32) NOT NULL,
    username_normalized VARCHAR(32) COLLATE "C" NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_username_format_chk
        CHECK (username COLLATE "C" ~ '^[A-Za-z0-9_]{3,32}$'),
    CONSTRAINT users_username_normalized_chk
        CHECK (username_normalized = translate(username,
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))
);

CREATE UNIQUE INDEX users_username_normalized_uq
    ON auth.users (username_normalized);

CREATE TABLE auth.refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_token_hash_uq
    ON auth.refresh_tokens (token_hash);

CREATE INDEX refresh_tokens_user_expires_idx
    ON auth.refresh_tokens (user_id, expires_at);

CREATE TABLE auth.contacts (
    user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, contact_id),
    CONSTRAINT contacts_not_self_chk CHECK (user_id <> contact_id)
);

COMMIT;
