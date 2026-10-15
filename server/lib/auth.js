const crypto = require("crypto");
const fs = require("fs");
const { ADMIN_PATH, SESSIONS_PATH } = require("./paths");
const { writeJson } = require("./jsonStore");

const SESSION_COOKIE = "fgs_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Persist only hashes of session tokens. The browser keeps the random token in
// its HttpOnly cookie; a copy of the local data file cannot be used to sign in.
const sessions = new Map();

function tokenDigest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function persistSessions() {
  const records = [...sessions].map(([tokenHash, session]) => ({
    tokenHash,
    createdAt: session.createdAt,
  }));
  // Session data has no backup: restoring an older copy could revive a token
  // that the administrator already logged out from.
  writeJson(SESSIONS_PATH, records, { backup: false });
}

function loadPersistedSessions() {
  if (!fs.existsSync(SESSIONS_PATH)) return;
  try {
    const records = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
    if (!Array.isArray(records)) throw new Error("Session store must be an array");
    const now = Date.now();
    for (const record of records) {
      if (
        typeof record?.tokenHash === "string" &&
        /^[a-f0-9]{64}$/.test(record.tokenHash) &&
        Number.isFinite(record.createdAt) &&
        record.createdAt <= now &&
        now - record.createdAt <= SESSION_TTL_MS
      ) {
        sessions.set(record.tokenHash, { createdAt: record.createdAt });
      }
    }
    if (sessions.size !== records.length) persistSessions();
  } catch (error) {
    // A damaged session file should sign users out, not prevent FlashBack
    // from starting. The next successful login creates a clean store.
    sessions.clear();
    console.error(`Could not load persisted sessions: ${error.message}`);
  }
}

loadPersistedSessions();

// RESET_ADMIN=true wipes the stored account on startup and forces the setup
// wizard again. Meant to be toggled from Portainer's env var editor (no
// terminal/SSH needed) when the admin forgets their password.
if (process.env.RESET_ADMIN === "true" && fs.existsSync(ADMIN_PATH)) {
  fs.unlinkSync(ADMIN_PATH);
  sessions.clear();
  for (const sessionFile of [SESSIONS_PATH, `${SESSIONS_PATH}.bak`]) {
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  }
  console.log("");
  console.log("========================================");
  console.log(" RESET_ADMIN=true — admin account cleared.");
  console.log(" Visit /setup to create a new account, then unset");
  console.log(" RESET_ADMIN (or set it back to false) and restart.");
  console.log("========================================");
  console.log("");
}

function isConfigured() {
  return fs.existsSync(ADMIN_PATH);
}

function loadAdmin() {
  if (!isConfigured()) return null;
  return JSON.parse(fs.readFileSync(ADMIN_PATH, "utf-8"));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createAdmin(username, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);

  writeJson(ADMIN_PATH, { username, salt, passwordHash });
}

function verifyLogin(username, password) {
  const admin = loadAdmin();
  if (!admin) return false;

  const usernameMatches =
    Buffer.byteLength(username) === Buffer.byteLength(admin.username) &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(admin.username));

  if (!usernameMatches) return false;

  const candidateHash = hashPassword(password, admin.salt);
  const storedHash = Buffer.from(admin.passwordHash, "hex");
  const candidateBuf = Buffer.from(candidateHash, "hex");

  if (storedHash.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(storedHash, candidateBuf);
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = tokenDigest(token);
  sessions.set(tokenHash, { createdAt: Date.now() });
  try {
    persistSessions();
  } catch (error) {
    sessions.delete(tokenHash);
    throw error;
  }
  return token;
}

function destroySession(token) {
  if (!token) return;
  if (sessions.delete(tokenDigest(token))) persistSessions();
}

function isValidSession(token) {
  if (typeof token !== "string" || !token) return false;
  const tokenHash = tokenDigest(token);
  const session = sessions.get(tokenHash);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(tokenHash);
    persistSessions();
    return false;
  }
  return true;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

// Protects /admin and page-like GET requests: redirects to the right page
// instead of returning a bare 401, since these are browser navigations,
// not API calls.
function requireAdminPage(req, res, next) {
  if (!isConfigured()) return res.redirect("/setup");
  const token = getSessionToken(req);
  if (token && isValidSession(token)) return next();
  return res.redirect("/login");
}

// Protects /api/admin/* — these are fetch() calls from already-loaded pages,
// so a JSON 401 (handled by the frontend) is more appropriate than a redirect.
function requireAdminApi(req, res, next) {
  if (!isConfigured()) return res.status(401).json({ error: "not_configured" });
  const token = getSessionToken(req);
  if (token && isValidSession(token)) return next();
  return res.status(401).json({ error: "unauthenticated" });
}

module.exports = {
  isConfigured,
  createAdmin,
  verifyLogin,
  createSession,
  destroySession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
  requireAdminPage,
  requireAdminApi,
};
