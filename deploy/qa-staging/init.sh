#!/bin/sh
set -eu

if [ "$POSTGRES_HOST/$POSTGRES_DB/$POSTGRES_USER" != "postgres/messenger_qa/postgres" ]; then
    echo 'QA initializer requires its private PostgreSQL' >&2
    exit 1
fi

migrate -service=all -direction=up
export PGPASSWORD="$POSTGRES_PASSWORD"
exec psql -X -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -f /opt/qa/init.sql
