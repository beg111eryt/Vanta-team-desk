CREATE TABLE IF NOT EXISTS team_desk_users (
  id text PRIMARY KEY,
  display_name varchar(40) NOT NULL,
  email varchar(254) NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_desk_teams (
  id text PRIMARY KEY,
  name varchar(32) NOT NULL,
  join_code varchar(12) NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES team_desk_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_desk_memberships (
  team_id text NOT NULL REFERENCES team_desk_teams(id) ON DELETE CASCADE,
  user_id text NOT NULL UNIQUE REFERENCES team_desk_users(id) ON DELETE CASCADE,
  role varchar(12) NOT NULL CHECK (role IN ('captain', 'player')),
  status varchar(12) NOT NULL CHECK (status IN ('pending', 'approved')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_desk_memberships_team_status
  ON team_desk_memberships(team_id, status);

CREATE TABLE IF NOT EXISTS team_desk_workspace (
  team_id text PRIMARY KEY REFERENCES team_desk_teams(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  plays jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
