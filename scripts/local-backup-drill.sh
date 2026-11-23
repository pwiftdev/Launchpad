#!/usr/bin/env bash
# Isolated test database only. No production URL, password or database argument is accepted.
set -euo pipefail
if [ "$(id -un)" != postgres ]; then
  echo 'Run as the isolated VM postgres OS user' >&2
  exit 1
fi
source_db=rinsed_local
transport=local-peer
if [ "${RINSED_BACKUP_TLS:-false}" = true ]; then
  if [ "${PGHOST:-}" != 127.0.0.1 ] || [ "${PGPORT:-}" != 5432 ] || [ "${PGUSER:-}" != rinsed_local ] ||
     [ "${PGSSLMODE:-}" != verify-full ] || [ "${PGSSLROOTCERT:-}" != /var/lib/postgresql/rinsed-server.crt ]; then
    echo 'TLS drill accepts only the pinned isolated local database and CA' >&2; exit 1
  fi
  transport=tls-verify-full
fi
restore_db="rinsed_restore_$(date -u +%Y%m%d_%H%M%S)"
case "$restore_db" in rinsed_restore_[0-9]*_[0-9]*) ;; *) exit 1 ;; esac
drill_dir="/var/lib/postgresql/rinsed-drills/$restore_db"
if [ -e "$drill_dir" ] || [ "$(psql -X -qAt -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='$restore_db'")" != 0 ]; then
  echo 'Restore database or evidence directory already exists; refusing overwrite' >&2
  exit 1
fi
mkdir -p /var/lib/postgresql/rinsed-drills
mkdir "$drill_dir"
chmod 700 "$drill_dir"
cat > "$drill_dir/inventory.sql" <<'SQL'
CREATE FUNCTION pg_temp.drill_inventory() RETURNS jsonb LANGUAGE plpgsql AS $body$
DECLARE
  table_item record;
  table_rows bigint;
  table_hash text;
  tables jsonb := '{}'::jsonb;
BEGIN
  FOR table_item IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
    EXECUTE format(
      'SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E''\n'' ORDER BY to_jsonb(x)::text), ''''), ''UTF8'')), ''hex'') FROM public.%I x',
      table_item.tablename) INTO table_rows, table_hash;
    tables := tables || jsonb_build_object(table_item.tablename,jsonb_build_object('rows',table_rows,'sha256',table_hash));
  END LOOP;
  RETURN jsonb_build_object('tables',tables,
    'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text,conname),'[]'::jsonb) FROM pg_constraint WHERE connamespace='public'::regnamespace),
    'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef) ORDER BY tablename,indexname),'[]'::jsonb) FROM pg_indexes WHERE schemaname='public'),
    'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgrelid::regclass::text,tgname),'[]'::jsonb) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)),
    'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'definition',pg_get_functiondef(oid)) ORDER BY oid::regprocedure::text),'[]'::jsonb) FROM pg_proc WHERE pronamespace='public'::regnamespace));
END
$body$;
SQL

# Keep one exporting transaction open while pg_dump reads exactly the same MVCC snapshot.
coproc SOURCE_SNAPSHOT { psql -X -qAt -v ON_ERROR_STOP=1 -d "$source_db"; }
snapshot_pid=$SOURCE_SNAPSHOT_PID
exec {snapshot_in}>&"${SOURCE_SNAPSHOT[1]}"
exec {snapshot_out}<&"${SOURCE_SNAPSHOT[0]}"
printf '\\i %s\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' "$drill_dir/inventory.sql" >&"$snapshot_in"
IFS= read -r snapshot_id <&"$snapshot_out"
[[ "$snapshot_id" =~ ^[A-Fa-f0-9-]+$ ]] || { echo 'Unexpected snapshot identifier' >&2; exit 1; }
printf '%s\n' "$snapshot_id" > "$drill_dir/exported-snapshot.txt"
pg_dump --dbname "$source_db" --snapshot "$snapshot_id" --format custom --file "$drill_dir/database.dump"
printf 'SELECT pg_temp.drill_inventory();\n' >&"$snapshot_in"
IFS= read -r source_inventory <&"$snapshot_out"
printf '%s\n' "$source_inventory" > "$drill_dir/source-inventory.json"
printf 'ROLLBACK;\n\\q\n' >&"$snapshot_in"
exec {snapshot_in}>&-
exec {snapshot_out}<&-
wait "$snapshot_pid"

if [ "$transport" = tls-verify-full ]; then
  psql -X -qAt -d "$source_db" -c "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()" > "$drill_dir/source-tls.txt"
  grep -qx t "$drill_dir/source-tls.txt"
  PGSSLMODE=disable createdb --host /var/run/postgresql --port 5432 --username postgres --template template0 --owner rinsed_local "$restore_db"
else
  createdb --template template0 "$restore_db"
fi
pg_restore --dbname "$restore_db" --exit-on-error "$drill_dir/database.dump"
{ cat "$drill_dir/inventory.sql"; printf '\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_temp.drill_inventory();\nROLLBACK;\n'; } |
  psql -X -qAt -v ON_ERROR_STOP=1 -d "$restore_db" > "$drill_dir/restored-inventory.json"
cmp "$drill_dir/source-inventory.json" "$drill_dir/restored-inventory.json"
if [ "$transport" = tls-verify-full ]; then
  psql -X -qAt -d "$restore_db" -c "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()" > "$drill_dir/restored-tls.txt"
  grep -qx t "$drill_dir/restored-tls.txt"
fi
sha256sum "$drill_dir/database.dump" > "$drill_dir/dump.sha256"
printf '{"sourceDatabase":"%s","restoredDatabase":"%s","snapshot":"%s","transport":"%s","inventoryMatched":true,"evidenceDirectory":"%s"}\n' "$source_db" "$restore_db" "$snapshot_id" "$transport" "$drill_dir" | tee "$drill_dir/result.json"
