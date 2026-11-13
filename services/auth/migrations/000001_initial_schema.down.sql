BEGIN;

DROP TABLE auth.contacts;
DROP TABLE auth.refresh_tokens;
DROP TABLE auth.users;
DROP SCHEMA auth;

COMMIT;
