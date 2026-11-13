BEGIN;

DROP TABLE history.messages;
DROP TABLE history.personal_chat_pairs;
DROP TABLE history.chat_members;
DROP TABLE history.chats;
DROP SCHEMA history;

COMMIT;
