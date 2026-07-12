#!/bin/sh
set -eu

# This runs only while PostgreSQL initialises an empty data volume.
# Runtime and persistence tests must never share a database because the test
# suite truncates all application tables before each run.
psql -v ON_ERROR_STOP=1 --set=db_password="$MINUTKA_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE minutka_runtime LOGIN PASSWORD :'db_password';
  CREATE DATABASE minutka OWNER minutka_runtime;
  CREATE DATABASE minutka_test OWNER minutka_runtime;
SQL
