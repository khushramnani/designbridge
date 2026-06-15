# Supabase migrations

These mirror the **canonical** relay schema at `apps/relay/migrations/0001_init.sql` (which the relay
applies at boot via `runMigrations`, and tests run against pg-mem). The copy here lets the Supabase
CLI (`supabase db push`) provision the same schema on the remote project before either the relay or
the web app connects.

**Source of truth = `apps/relay/migrations/`.** When you change the schema there, re-copy it here with
the next timestamp (e.g. `cp apps/relay/migrations/000X_*.sql supabase/migrations/<ts>_<name>.sql`).
The DDL is idempotent (`create table if not exists`; the relay's runner ignores "already exists"), so
the CLI and the relay can both apply it without conflict.
