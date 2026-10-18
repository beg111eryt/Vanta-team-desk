"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3002);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const PRODUCTION = process.env.NODE_ENV === "production";
const app = express();

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
}
if (!DATABASE_URL) {
  throw new Error("Set DATABASE_URL to your PostgreSQL connection string.");
}

if (PRODUCTION) app.set("trust proxy", 1);

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", error => {
  console.error("Unexpected PostgreSQL pool error:", error);
});
const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({
  pool,
  createTableIfMissing: true,
  tableName: "team_desk_sessions"
});
const scrypt = promisify(crypto.scrypt);
const clientPath = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const authAttempts = new Map();

function desktopDownloadUrl() {
  const configuredUrl = process.env.DESKTOP_DOWNLOAD_URL;
  if (!configuredUrl) return null;
  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("DESKTOP_DOWNLOAD_URL must be a public HTTPS URL.");
    }
    return url.href;
  } catch (error) {
    console.error("Invalid desktop download link:", error.message);
    return null;
  }
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) req.body = {};
  next();
});
app.use(session({
  name: "vanta.teamdesk",
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: PRODUCTION,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) {
        return res.status(403).json({ message: "Cross-origin requests are not allowed." });
      }
    } catch {
      return res.status(403).json({ message: "Invalid request origin." });
    }
  }
  next();
}

function limitAuthAttempts(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  let attempt = authAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
    attempt = { startedAt: now, count: 0 };
    authAttempts.set(key, attempt);
  }
  if (attempt.count >= 10) {
    const retryAfter = Math.ceil((attempt.startedAt + 15 * 60 * 1000 - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ message: "Too many sign-in or registration attempts. Try again in 15 minutes." });
  }
  attempt.count++;
  next();
}

function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ message: "Sign in to continue." });
  next();
}

function text(value, label, min, max) {
  if (typeof value !== "string") throw new HttpError(400, `${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, `${label} must be ${min} to ${max} characters.`);
  }
  return trimmed;
}

function validEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 64)).toString("hex");
}

async function signIn(req, userId) {
  await promisify(req.session.regenerate).bind(req.session)();
  req.session.userId = userId;
  await promisify(req.session.save).bind(req.session)();
}

async function membershipFor(userId) {
  const result = await pool.query(
    `SELECT m.team_id, m.role, m.status, t.name AS team_name, t.join_code
     FROM team_desk_memberships m
     JOIN team_desk_teams t ON t.id = m.team_id
     WHERE m.user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function requireApprovedMember(req, res, next) {
  try {
    const membership = await membershipFor(req.session.userId);
    if (!membership || membership.team_id !== req.params.teamId || membership.status !== "approved") {
      return res.status(403).json({ message: "You are not an approved member of this team." });
    }
    req.membership = membership;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireCaptain(req, res, next) {
  try {
    const membership = await membershipFor(req.session.userId);
    if (!membership || membership.team_id !== req.params.teamId ||
        membership.status !== "approved" || membership.role !== "captain") {
      return res.status(403).json({ message: "Only this team's captain can manage membership." });
    }
    req.membership = membership;
    next();
  } catch (error) {
    next(error);
  }
}

function validMapScore(format, own, opponent) {
  if (format === "Single map") return own <= 20 && opponent <= 20 && own !== opponent;
  if (format === "BO2") return own <= 2 && opponent <= 2 && own + opponent === 2;
  const match = /^BO(1|3|5)$/.exec(format);
  if (!match) return false;
  const mapsToWin = Math.floor(Number(match[1]) / 2) + 1;
  return own <= mapsToWin && opponent <= mapsToWin &&
    ((own === mapsToWin && opponent < mapsToWin) ||
      (opponent === mapsToWin && own < mapsToWin));
}

function validateWorkspace(body, rosterIds) {
  if (!body || !Array.isArray(body.matches) || !Array.isArray(body.plays) ||
      body.matches.length > 1000 || body.plays.length > 1000) {
    throw new HttpError(400, "Workspace data must contain valid match and play lists.");
  }
  const matchFormats = new Set(["Single map", "BO1", "BO2", "BO3", "BO5"]);
  for (const match of body.matches) {
    if (!match || typeof match.id !== "string" || match.id.length > 80 ||
        typeof match.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(match.date) ||
        typeof match.opponent !== "string" || match.opponent.length > 60 ||
        typeof match.map !== "string" || match.map.length > 100 ||
        !matchFormats.has(match.format) ||
        !Number.isInteger(match.scoreFor) || !Number.isInteger(match.scoreAgainst) ||
        !validMapScore(match.format, match.scoreFor, match.scoreAgainst) ||
        !["win", "loss", "draw"].includes(match.result) ||
        (match.result === "draw" && match.format !== "BO2") ||
        (match.result === "win" && match.scoreFor <= match.scoreAgainst) ||
        (match.result === "loss" && match.scoreFor >= match.scoreAgainst) ||
        typeof match.notes !== "string" || match.notes.length > 600 ||
        typeof match.focus !== "string" || typeof (match.side || "") !== "string" ||
        !Array.isArray(match.playerIds || []) ||
        (match.playerIds || []).some(id => !rosterIds.has(id))) {
      throw new HttpError(400, "A match contains invalid fields, a score, or a player outside this team.");
    }
  }
  for (const play of body.plays) {
    if (!play || typeof play.id !== "string" || play.id.length > 80 ||
        typeof play.title !== "string" || play.title.length > 60 ||
        typeof play.map !== "string" || play.map.length > 100 ||
        typeof play.side !== "string" || play.side.length > 20 ||
        typeof play.phase !== "string" || play.phase.length > 30 ||
        typeof play.agents !== "string" || play.agents.length > 100 ||
        typeof play.description !== "string" || play.description.length > 900) {
      throw new HttpError(400, "A play contains invalid or oversized fields.");
    }
  }
}

app.use("/api", requireSameOrigin);

app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.get("/api/app-config", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ configured: true, desktop: false, apiBaseUrl: "" });
});

app.get("/", (req, res) => {
  const downloadUrl = desktopDownloadUrl();
  const page = fs.readFileSync(path.join(clientPath, "download.html"), "utf8")
    .replaceAll("{{DOWNLOAD_CLASS}}", downloadUrl ? "" : "button-disabled")
    .replaceAll("{{DOWNLOAD_HREF}}", downloadUrl ? "/download" : "#")
    .replaceAll("{{DOWNLOAD_DISABLED}}", downloadUrl ? "" : "aria-disabled=\"true\"")
    .replaceAll("{{DOWNLOAD_NOTICE_CLASS}}", downloadUrl ? "" : "download-missing")
    .replaceAll("{{DOWNLOAD_NOTICE}}", downloadUrl
      ? "<strong>Need a team?</strong> The captain creates one in the app after connecting to the shared service."
      : "<strong>Download not published yet.</strong> The server owner must publish a Windows installer and set DESKTOP_DOWNLOAD_URL.");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("html").send(page);
});

app.get("/download", (req, res) => {
  const downloadUrl = desktopDownloadUrl();
  if (!downloadUrl) {
    return res.status(503).type("text").send("The Windows installer has not been published yet.");
  }
  res.redirect(302, downloadUrl);
});

app.post("/api/auth/register", limitAuthAttempts, asyncRoute(async (req, res) => {
  const displayName = text(req.body.displayName, "Display name", 2, 40);
  if (!validEmail(req.body.email)) throw new HttpError(400, "Enter a valid email address.");
  if (typeof req.body.password !== "string" || req.body.password.length < 10 || req.body.password.length > 128) {
    throw new HttpError(400, "Password must be 10 to 128 characters.");
  }
  const email = req.body.email.trim().toLowerCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(req.body.password, salt);
  const id = crypto.randomUUID();
  try {
    await pool.query(
      "INSERT INTO team_desk_users (id, display_name, email, password_salt, password_hash) VALUES ($1, $2, $3, $4, $5)",
      [id, displayName, email, salt, passwordHash]
    );
  } catch (error) {
    if (error.code === "23505") throw new HttpError(409, "An account with that email already exists.");
    throw error;
  }
  await signIn(req, id);
  res.status(201).json({ user: { id, displayName, email } });
}));

app.post("/api/auth/login", limitAuthAttempts, asyncRoute(async (req, res) => {
  if (!validEmail(req.body.email) || typeof req.body.password !== "string") {
    throw new HttpError(400, "Enter your email and password.");
  }
  const email = req.body.email.trim().toLowerCase();
  const result = await pool.query(
    "SELECT id, display_name, email, password_salt, password_hash FROM team_desk_users WHERE email = $1",
    [email]
  );
  const user = result.rows[0];
  if (!user) throw new HttpError(401, "Email or password is incorrect.");
  const candidate = Buffer.from(await hashPassword(req.body.password, user.password_salt), "hex");
  const expected = Buffer.from(user.password_hash, "hex");
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
    throw new HttpError(401, "Email or password is incorrect.");
  }
  authAttempts.delete(req.ip);
  await signIn(req, user.id);
  res.json({ user: { id: user.id, displayName: user.display_name, email: user.email } });
}));

app.get("/api/auth/me", requireUser, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT id, display_name, email FROM team_desk_users WHERE id = $1",
    [req.session.userId]
  );
  if (!result.rowCount) throw new HttpError(401, "Account not found. Sign in again.");
  const user = result.rows[0];
  const membership = await membershipFor(user.id);
  res.json({
    user: { id: user.id, displayName: user.display_name, email: user.email },
    membership: membership ? {
      teamId: membership.team_id,
      teamName: membership.team_name,
      role: membership.role,
      status: membership.status
    } : null
  });
}));

app.post("/api/auth/logout", requireUser, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie("vanta.teamdesk", { httpOnly: true, sameSite: "strict", secure: PRODUCTION });
    res.status(204).end();
  });
});

app.post("/api/teams", requireUser, asyncRoute(async (req, res) => {
  const name = text(req.body.name, "Team name", 2, 32);
  if (await membershipFor(req.session.userId)) {
    throw new HttpError(409, "You already have a team membership or pending request.");
  }
  const teamId = crypto.randomUUID();
  const joinCode = crypto.randomBytes(5).toString("hex").toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO team_desk_teams (id, name, join_code, created_by) VALUES ($1, $2, $3, $4)",
      [teamId, name, joinCode, req.session.userId]
    );
    await client.query(
      "INSERT INTO team_desk_memberships (team_id, user_id, role, status, approved_at) VALUES ($1, $2, 'captain', 'approved', now())",
      [teamId, req.session.userId]
    );
    await client.query("INSERT INTO team_desk_workspace (team_id) VALUES ($1)", [teamId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.status(201).json({ team: { id: teamId, name, joinCode } });
}));

app.post("/api/teams/join", requireUser, asyncRoute(async (req, res) => {
  const joinCode = text(req.body.joinCode, "Team code", 8, 12).toUpperCase();
  const existing = await membershipFor(req.session.userId);
  if (existing) throw new HttpError(409, "You already have a team membership or pending request.");
  const teamResult = await pool.query(
    "SELECT id, name FROM team_desk_teams WHERE join_code = $1",
    [joinCode]
  );
  const team = teamResult.rows[0];
  if (!team) throw new HttpError(404, "That team code wasn't found. Check it with your captain.");
  await pool.query(
    "INSERT INTO team_desk_memberships (team_id, user_id, role, status) VALUES ($1, $2, 'player', 'pending')",
    [team.id, req.session.userId]
  );
  res.status(201).json({ message: `Request sent to ${team.name}'s captain.` });
}));

app.get("/api/teams/:teamId", requireUser, requireApprovedMember, asyncRoute(async (req, res) => {
  const team = await pool.query(
    "SELECT id, name, join_code FROM team_desk_teams WHERE id = $1",
    [req.params.teamId]
  );
  if (!team.rowCount) throw new HttpError(404, "Team not found.");
  const roster = await pool.query(
    `SELECT u.id, u.display_name AS "displayName", m.role
     FROM team_desk_memberships m
     JOIN team_desk_users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND m.status = 'approved'
     ORDER BY CASE WHEN m.role = 'captain' THEN 0 ELSE 1 END, u.display_name`,
    [req.params.teamId]
  );
  const requests = req.membership.role === "captain"
    ? await pool.query(
      `SELECT u.id, u.display_name AS "displayName", u.email, m.requested_at AS "requestedAt"
       FROM team_desk_memberships m
       JOIN team_desk_users u ON u.id = m.user_id
       WHERE m.team_id = $1 AND m.status = 'pending'
       ORDER BY m.requested_at`,
      [req.params.teamId]
    )
    : { rows: [] };
  res.json({
    team: { id: team.rows[0].id, name: team.rows[0].name, joinCode: req.membership.role === "captain" ? team.rows[0].join_code : null },
    roster: roster.rows,
    requests: requests.rows
  });
}));

app.post("/api/teams/:teamId/requests/:userId/approve", requireUser, requireCaptain, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE team_desk_memberships SET status = 'approved', approved_at = now()
     WHERE team_id = $1 AND user_id = $2 AND role = 'player' AND status = 'pending'
     RETURNING user_id`,
    [req.params.teamId, req.params.userId]
  );
  if (!result.rowCount) throw new HttpError(404, "Pending team request not found.");
  res.json({ approved: true });
}));

app.delete("/api/teams/:teamId/requests/:userId", requireUser, requireCaptain, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "DELETE FROM team_desk_memberships WHERE team_id = $1 AND user_id = $2 AND role = 'player' AND status = 'pending' RETURNING user_id",
    [req.params.teamId, req.params.userId]
  );
  if (!result.rowCount) throw new HttpError(404, "Pending team request not found.");
  res.status(204).end();
}));

app.get("/api/teams/:teamId/workspace", requireUser, requireApprovedMember, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT revision, matches, plays FROM team_desk_workspace WHERE team_id = $1",
    [req.params.teamId]
  );
  if (!result.rowCount) throw new HttpError(404, "Team workspace not found.");
  res.json({
    revision: result.rows[0].revision,
    matches: result.rows[0].matches,
    plays: result.rows[0].plays
  });
}));

app.put("/api/teams/:teamId/workspace", requireUser, requireApprovedMember, asyncRoute(async (req, res) => {
  const expectedRevision = Number(req.body.revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new HttpError(400, "A workspace revision is required.");
  }
  const rosterResult = await pool.query(
    "SELECT user_id FROM team_desk_memberships WHERE team_id = $1 AND status = 'approved'",
    [req.params.teamId]
  );
  const rosterIds = new Set(rosterResult.rows.map(row => row.user_id));
  validateWorkspace(req.body, rosterIds);
  const result = await pool.query(
    `UPDATE team_desk_workspace SET matches = $1::jsonb, plays = $2::jsonb,
       revision = revision + 1, updated_at = now()
     WHERE team_id = $3 AND revision = $4
     RETURNING revision`,
    [JSON.stringify(req.body.matches), JSON.stringify(req.body.plays), req.params.teamId, expectedRevision]
  );
  if (!result.rowCount) throw new HttpError(409, "A teammate saved changes first. Refresh the workspace and retry your change.");
  res.json({ revision: result.rows[0].revision });
}));

app.use("/api", (req, res) => res.status(404).json({ message: "API route not found." }));
app.use((req, res) => res.status(404).type("text").send("Page not found."));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ message: "Request body must be valid JSON." });
  }
  if (error instanceof HttpError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error("Team Desk API error:", error);
  res.status(500).json({ message: "The server couldn't complete that request." });
});

async function start() {
  await pool.query(schema);
  app.listen(PORT, () => {
    console.log(`VANTA Team Desk running on http://localhost:${PORT}`);
  });
}

start().catch(error => {
  console.error("Unable to start VANTA Team Desk:", error);
  process.exitCode = 1;
});
