PRAGMA foreign_keys = ON;
CREATE TABLE staff (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
  deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX staff_email_unique ON staff(email) WHERE email <> '';
CREATE TABLE washes (
  id TEXT PRIMARY KEY NOT NULL,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  washed_at INTEGER NOT NULL
);
CREATE INDEX washes_staff_time ON washes(staff_id, washed_at DESC);
CREATE INDEX washes_time ON washes(washed_at);
CREATE TABLE migration_state (
  key TEXT PRIMARY KEY NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  completed_at INTEGER
);
