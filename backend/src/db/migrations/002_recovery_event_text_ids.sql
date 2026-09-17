-- The demo seed SQL uses recovery event ids such as
-- r1111111-1111-4111-8111-111111111111, which are intentionally readable
-- fixture ids but not valid UUID literals. Keep 001_initial_schema.sql intact
-- and relax only this primary key before seed SQL is applied during initdb.
ALTER TABLE recovery_events
  ALTER COLUMN id TYPE TEXT USING id::text;
