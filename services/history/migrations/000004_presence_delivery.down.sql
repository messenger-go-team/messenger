BEGIN;

-- Drain grants that committed before these tables were locked.
LOCK TABLE history.chats, history.chat_members IN ACCESS EXCLUSIVE MODE;
SELECT history.wait_presence_deliveries(NULL);

DROP TRIGGER presence_guard_member_truncate ON history.chat_members;
DROP TRIGGER presence_guard_chat_type ON history.chats;
DROP TRIGGER presence_guard_member_move ON history.chat_members;
DROP TRIGGER presence_guard_member_delete ON history.chat_members;
DROP TRIGGER presence_guard_member_insert ON history.chat_members;
DROP FUNCTION history.guard_presence_truncate();
DROP FUNCTION history.guard_presence_chat_type();
DROP FUNCTION history.guard_presence_member_move();
DROP FUNCTION history.guard_presence_members();
DROP FUNCTION history.lock_presence_delivery(uuid[]);
DROP FUNCTION history.wait_presence_deliveries(uuid[]);
DROP TABLE history.presence_deliveries;

COMMIT;
