-- Naqiwha schema (idempotent, runs on every boot). Only ADD after first deploy; never rename or drop.
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  first_name  TEXT,
  last_name   TEXT,
  qr_code     TEXT NOT NULL UNIQUE,
  xp          INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  coins       INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  level       SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  address          TEXT,
  starts_at        TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','cleaned')),
  before_image_id  UUID NOT NULL REFERENCES images(id),
  after_image_id   UUID REFERENCES images(id),
  ai_before        JSONB,
  ai_verdict       JSONB,
  verify_attempts  SMALLINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleaned_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_status_idx ON events (status, created_at DESC);
-- false = solo cleanup: the organizer cleans alone, nobody can join or be checked in.
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS participants (
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('organizer','member')),
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_at  TIMESTAMPTZ,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS participants_user_idx ON participants (user_id);

CREATE TABLE IF NOT EXISTS vouchers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  partner     TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  cost        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS vouchers_user_idx ON vouchers (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('cleanup','level_up','purchase')),
  event_id     UUID REFERENCES events(id) ON DELETE SET NULL,
  voucher_id   UUID REFERENCES vouchers(id) ON DELETE SET NULL,
  xp_delta     INTEGER NOT NULL DEFAULT 0,
  coins_delta  INTEGER NOT NULL DEFAULT 0,
  level_after  SMALLINT,
  seen_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger (user_id, created_at DESC);

-- Strict AI gate: the analysis is stored with the photo, and POST /events trusts only this copy.
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_analysis JSONB;
-- Solo spots are anonymous unless the organizer opts in.
ALTER TABLE events ADD COLUMN IF NOT EXISTS show_name BOOLEAN NOT NULL DEFAULT false;
-- Moderation: closed spots are hidden from the map and frozen; an admin can reopen them.
ALTER TABLE events ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS admin_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    UUID,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at DESC);
