CREATE DATABASE api_auth;
CREATE DATABASE api_history;
CREATE ROLE api_auth_runtime LOGIN PASSWORD 'api-auth-runtime-only';
CREATE ROLE api_history_runtime LOGIN PASSWORD 'api-history-runtime-only';
