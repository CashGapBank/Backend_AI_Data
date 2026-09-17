#!/usr/bin/env bash
set -euo pipefail

run_sql_dir() {
  local dir="$1"
  local label="$2"

  if [ ! -d "$dir" ]; then
    echo "Skipping ${label}: ${dir} does not exist"
    return
  fi

  shopt -s nullglob
  local files=("$dir"/*.sql)
  shopt -u nullglob

  if [ "${#files[@]}" -eq 0 ]; then
    echo "Skipping ${label}: no .sql files found in ${dir}"
    return
  fi

  echo "Running ${label} from ${dir}"
  for file in "${files[@]}"; do
    echo "Applying ${file}"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$file"
  done
}

run_sql_dir "/docker-entrypoint-initdb.d/001_migrations" "schema migrations"
run_sql_dir "/docker-entrypoint-initdb.d/002_seed" "seed SQL"
