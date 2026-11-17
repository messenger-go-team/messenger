BEGIN;

CREATE TABLE history.later_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    message_id UUID NOT NULL REFERENCES history.messages (id) ON DELETE CASCADE,
    due_at TIMESTAMPTZ,
    state TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT later_entries_state_chk CHECK (state IN ('active', 'done')),
    CONSTRAINT later_entries_due_at_chk CHECK (
        due_at IS NULL OR
        due_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00'
                   AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
    )
);

CREATE UNIQUE INDEX later_entries_active_uq
    ON history.later_entries (user_id, message_id) WHERE state = 'active';

-- Supports the unpaginated owner's active list in contract order, including nulls.
CREATE INDEX later_entries_active_list_idx
    ON history.later_entries (user_id, due_at ASC NULLS LAST, created_at, id)
    WHERE state = 'active';

-- The partial owner index cannot efficiently serve message deletion cascades.
CREATE INDEX later_entries_message_idx ON history.later_entries (message_id);

COMMIT;
