const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const { isValidSwf } = require("./lib/validateSwf");
const { detectImageExt } = require("./lib/validateImage");
const { slugify } = require("./lib/slugify");
const auth = require("./lib/auth");
const flashpoint = require("./lib/flashpoint");
const swfAnalysis = require("./lib/swfAnalysis");
const backupArchive = require("./lib/backupArchive");
const profiles = require("./lib/profiles");
const favorites = require("./lib/favorites");
const paths = require("./lib/paths");
const { readJson, writeJson } = require("./lib/jsonStore");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 4000;
const MIB = 1024 * 1024;

function boundedNumberEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? Math.min(value, maximum) : fallback;
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= minimum ? Math.min(value, maximum) : fallback;
}

// Multer's memory storage buffers each file. Keep a hard ceiling on the
// aggregate file buffers accepted by one multipart request, then derive
// per-file limits so an env override cannot accidentally restore multi-GB
// requests.
const MAX_MULTIPART_TOTAL_BYTES = boundedNumberEnv(
  "MAX_MULTIPART_TOTAL_MB",
  512,
  1,
  512
) * MIB;
const MAX_MULTIPART_FIELDS = 10;
const MAX_MULTIPART_FIELD_BYTES = 16 * 1024;
const MAX_MULTIPART_FILE_BUDGET = Math.max(
  1,
  Math.floor(MAX_MULTIPART_TOTAL_BYTES - MAX_MULTIPART_FIELDS * MAX_MULTIPART_FIELD_BYTES)
);
const MAX_UPLOAD_FILE_BYTES = Math.min(
  boundedNumberEnv("MAX_UPLOAD_MB", 200, 0.01, 512) * MIB,
  Math.floor(MAX_MULTIPART_FILE_BUDGET / 2)
);
const MAX_COVER_FILE_BYTES = Math.min(
  boundedNumberEnv("MAX_COVER_MB", 16, 0.01, 512) * MIB,
  MAX_MULTIPART_FILE_BUDGET
);
const MAX_SIDECAR_FILES = boundedIntegerEnv("MAX_SIDECAR_FILES", 20, 1, 20);
const MAX_SIDECAR_FILE_BYTES = Math.min(
  boundedNumberEnv("MAX_SIDECAR_FILE_MB", 8, 0.01, 512) * MIB,
  Math.floor(MAX_MULTIPART_FILE_BUDGET / MAX_SIDECAR_FILES)
);
const GIB = 1024 * MIB;
const MAX_BACKUP_UPLOAD_BYTES = boundedNumberEnv("MAX_BACKUP_UPLOAD_GIB", 64, 1, 128) * GIB;
const MAX_BACKUP_EXPANDED_BYTES = boundedNumberEnv("MAX_BACKUP_EXPANDED_GIB", 64, 1, 128) * GIB;
const MAX_BACKUP_FILES = 50000;

const {
  DATA_DIR,
  GAMES_DIR,
  CATALOG_PATH,
  COLLECTIONS_PATH,
  SOURCES_PATH,
  FAVORITES_PATH,
  PROFILES_PATH,
  SAVES_DIR,
  GAME_ASSETS_DIR,
  COVERS_DIR,
  COLLECTION_COVERS_DIR,
  RUFFLE_DIR,
  PUBLIC_DIR,
} = paths;

const app = express();
app.use(express.json({ limit: "1mb" }));
let cachedCatalog = null;
let catalogSignature = "";
let backupRestoreInProgress = false;

// On a fresh install there's no admin account yet (no data/admin.json).
// Force every request straight to the setup wizard until one is created,
// instead of only gating /admin — otherwise a freshly installed instance
// looks fully usable (public library, API, etc.) with no owner set up yet.
const SETUP_ALLOWED_PREFIXES = ["/setup", "/api/setup", "/api/status", "/css", "/js", "/images", "/fonts", "/ruffle"];
app.use((req, res, next) => {
  if (auth.isConfigured()) return next();
  const allowed = SETUP_ALLOWED_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + "/")
  );
  if (allowed) return next();
  if (req.method !== "GET") {
    return res.status(401).json({ error: "not_configured" });
  }
  return res.redirect("/setup");
});

// ---- Storage helpers ----

function loadCatalog() {
  let signature = "missing";
  try {
    const stat = fs.statSync(CATALOG_PATH);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch (err) {
    // The catalog is optional until the first game is imported.
  }
  if (cachedCatalog && signature === catalogSignature) return cachedCatalog;
  const catalog = readJson(CATALOG_PATH, [], Array.isArray);
  // Older entries may not have a tags array yet.
  for (const g of catalog) {
    if (!Array.isArray(g.tags)) g.tags = [];
  }
  cachedCatalog = catalog;
  catalogSignature = signature;
  return catalog;
}

function saveCatalog(catalog) {
  writeJson(CATALOG_PATH, catalog);
  cachedCatalog = catalog;
  const stat = fs.statSync(CATALOG_PATH);
  catalogSignature = `${stat.mtimeMs}:${stat.size}`;
}

function loadCollections() {
  return readJson(COLLECTIONS_PATH, [], Array.isArray);
}

function saveCollections(collections) {
  writeJson(COLLECTIONS_PATH, collections);
}

function loadSources() {
  return readJson(SOURCES_PATH, [], Array.isArray);
}

function saveSources(sources) {
  writeJson(SOURCES_PATH, sources);
}

const SOURCE_TYPES = new Set(["catalog", "playable", "direct-swf"]);

function parseSourceInput(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "source_name_required" };
  if (name.length > 100) return { error: "source_name_too_long" };

  const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
  if (!rawUrl || rawUrl.length > 2048) return { error: "source_url_invalid" };
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (error) {
    return { error: "source_url_invalid" };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    return { error: "source_url_invalid" };
  }

  const type = typeof body?.type === "string" ? body.type : "catalog";
  if (!SOURCE_TYPES.has(type)) return { error: "source_type_invalid" };

  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
  if (notes.length > 1000) return { error: "source_notes_too_long" };
  const rawTags = Array.isArray(body?.tags)
    ? body.tags
    : typeof body?.tags === "string"
      ? body.tags.split(",")
      : [];
  const tags = [...new Set(
    rawTags
      .map((tag) => String(tag).trim().toLocaleLowerCase().slice(0, 40))
      .filter(Boolean)
  )].slice(0, 20);

  return {
    value: {
      name,
      url: parsedUrl.toString(),
      type,
      notes,
      tags,
      active: typeof body.active === "boolean" ? body.active : true,
    },
  };
}

function sourceUrlKey(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function hasDuplicateSourceUrl(sources, urlKey, exceptIndex = -1) {
  return sources.some((source, index) => {
    if (index === exceptIndex) return false;
    try {
      return sourceUrlKey(source.url) === urlKey;
    } catch (error) {
      return false;
    }
  });
}

function uniqueSlug(existingSlugs, baseSlug) {
  const existing = new Set(existingSlugs);
  if (!existing.has(baseSlug)) return baseSlug;
  let i = 2;
  while (existing.has(`${baseSlug}-${i}`)) i++;
  return `${baseSlug}-${i}`;
}

function removeExistingCovers(dir, slug) {
  for (const ext of ["jpg", "png", "webp"]) {
    const p = path.join(dir, `${slug}.${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function saveCover(dir, slug, buffer) {
  const ext = detectImageExt(buffer);
  if (!ext) return null;
  fs.mkdirSync(dir, { recursive: true });
  removeExistingCovers(dir, slug);
  fs.writeFileSync(path.join(dir, `${slug}.${ext}`), buffer);
  return ext;
}

function publicGame(g) {
  return {
    slug: g.slug,
    title: g.title,
    description: g.description,
    cover: g.cover || null,
    coverSource: g.coverSource || null,
    coverVersion: g.coverVersion || 0,
    tags: g.tags || [],
    source: g.source || null,
  };
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function findDuplicateSwf(catalog, buffer) {
  const digest = swfAnalysis.sha256(buffer);
  let catalogUpdated = false;
  for (const game of catalog) {
    if (game.sha256 && game.sha256 === digest) {
      if (catalogUpdated) saveCatalog(catalog);
      return { game, digest, catalogUpdated: false };
    }
    if (game.sha256 || !game.file || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.swf$/i.test(game.file)) continue;
    const existingPath = path.join(GAMES_DIR, game.file);
    try {
      const existingDigest = await sha256File(existingPath);
      game.sha256 = existingDigest;
      catalogUpdated = true;
      if (existingDigest === digest) {
        if (catalogUpdated) saveCatalog(catalog);
        return { game, digest, catalogUpdated: false };
      }
    } catch (error) {
      // A missing legacy file does not prevent new uploads from being added.
    }
  }
  if (catalogUpdated) saveCatalog(catalog);
  return { game: null, digest, catalogUpdated };
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  const expectedOrigin = `${req.protocol}://${req.get("host")}`;
  if (!origin || origin !== expectedOrigin || req.get("sec-fetch-site") === "cross-site") {
    return res.status(403).json({ error: "same_origin_required" });
  }
  next();
}

function rejectOversizedMultipart(req, res, next) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_TOTAL_BYTES) {
    return res.status(413).json({ error: "upload_too_large" });
  }
  next();
}

function createMultipartUpload(maxFileBytes, maxFiles) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileBytes,
      files: maxFiles,
      fields: MAX_MULTIPART_FIELDS,
      fieldSize: MAX_MULTIPART_FIELD_BYTES,
      parts: maxFiles + MAX_MULTIPART_FIELDS,
      headerPairs: 100,
    },
  });
}

function uploadErrorStatus(error) {
  return error && error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
}

function collectBackupTree(root, archivePrefix, entries) {
  if (!fs.existsSync(root)) return;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const sourcePath = path.join(root, item.name);
    const archivePath = `${archivePrefix}/${item.name}`;
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) collectBackupTree(sourcePath, archivePath, entries);
    else if (item.isFile() && isAllowedBackupPath(archivePath)) entries.push({ sourcePath, archivePath });
  }
}

function makeBackupEntries() {
  const entries = [];
  const stateFiles = [
    [CATALOG_PATH, "data/catalog.json", loadCatalog],
    [COLLECTIONS_PATH, "data/collections.json", loadCollections],
    [SOURCES_PATH, "data/sources.json", loadSources],
    [FAVORITES_PATH, "data/favorites.json", favorites.listFavorites],
    [PROFILES_PATH, "data/profiles.json", profiles.loadProfiles],
  ];
  for (const [filePath, archivePath, load] of stateFiles) {
    if (fs.existsSync(filePath)) entries.push({ sourcePath: filePath, archivePath });
    else entries.push({ buffer: Buffer.from(`${JSON.stringify(load(), null, 2)}\n`), archivePath });
  }
  collectBackupTree(GAMES_DIR, "games", entries);
  collectBackupTree(COVERS_DIR, "data/covers", entries);
  collectBackupTree(GAME_ASSETS_DIR, "data/game-assets", entries);
  collectBackupTree(SAVES_DIR, "data/saves", entries);
  return entries;
}

function isAllowedBackupPath(name) {
  if ([
    "manifest.json",
    "data/catalog.json",
    "data/collections.json",
    "data/sources.json",
    "data/favorites.json",
    "data/profiles.json",
  ].includes(name)) return true;
  if (/^games\/[a-z0-9]+(?:-[a-z0-9]+)*\.swf$/i.test(name)) return true;
  if (/^data\/covers\/(?:collections\/)?[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|png|webp)$/i.test(name)) return true;
  if (/^data\/game-assets\/[a-z0-9]+(?:-[a-z0-9]+)*\/[\w.-]{1,120}$/i.test(name)) return true;
  if (/^data\/saves\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/i.test(name)) return true;
  return false;
}

function validateBackupJson(stageDir, relativePath, validator) {
  const filePath = path.join(stageDir, ...relativePath.split("/"));
  if (fs.statSync(filePath).size > 256 * MIB) throw new Error(`Backup ${relativePath} exceeds the JSON size limit`);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!validator(value)) throw new Error(`Backup contains invalid ${relativePath}`);
  return value;
}

function commitBackupTargets(stageDir) {
  const id = crypto.randomUUID();
  const directoryTargets = [
    [path.join(stageDir, "games"), GAMES_DIR],
    [path.join(stageDir, "data", "covers"), COVERS_DIR],
    [path.join(stageDir, "data", "game-assets"), GAME_ASSETS_DIR],
    [path.join(stageDir, "data", "saves"), SAVES_DIR],
  ];
  const fileTargets = [
    [path.join(stageDir, "data", "catalog.json"), CATALOG_PATH],
    [path.join(stageDir, "data", "collections.json"), COLLECTIONS_PATH],
    [path.join(stageDir, "data", "sources.json"), SOURCES_PATH],
    [path.join(stageDir, "data", "favorites.json"), FAVORITES_PATH],
    [path.join(stageDir, "data", "profiles.json"), PROFILES_PATH],
  ];
  const targets = [
    ...directoryTargets.map(([staged, target]) => ({ staged, target, directory: true })),
    ...fileTargets.map(([staged, target]) => ({ staged, target, directory: false })),
  ];
  const normalizedTargets = targets.map(({ target }) => path.resolve(target));
  for (const target of normalizedTargets) {
    const relativeData = path.relative(target, DATA_DIR);
    if (relativeData === "" || (!relativeData.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeData))) {
      throw new Error("Configured storage paths overlap the account data folder; restore was stopped");
    }
  }
  for (let i = 0; i < normalizedTargets.length; i++) {
    for (let j = i + 1; j < normalizedTargets.length; j++) {
      const a = normalizedTargets[i];
      const b = normalizedTargets[j];
      const aContainsB = path.relative(a, b);
      const bContainsA = path.relative(b, a);
      if (
        aContainsB === "" || bContainsA === "" ||
        (!aContainsB.startsWith(`..${path.sep}`) && !path.isAbsolute(aContainsB)) ||
        (!bContainsA.startsWith(`..${path.sep}`) && !path.isAbsolute(bContainsA))
      ) throw new Error("Configured storage paths overlap each other; restore was stopped");
    }
  }

  const swaps = [];
  try {
    for (const item of targets) {
      const { staged, target, directory } = item;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (directory) fs.mkdirSync(staged, { recursive: true });
      else if (!fs.existsSync(staged)) throw new Error(`Backup is missing ${path.basename(target)}`);
      const prepared = `${target}.restore-stage-${id}`;
      const previous = `${target}.restore-old-${id}`;
      fs.rmSync(prepared, { recursive: true, force: true });
      if (directory) fs.cpSync(staged, prepared, { recursive: true, dereference: false });
      else fs.copyFileSync(staged, prepared);
      const hadPrevious = fs.existsSync(target);
      if (hadPrevious) fs.renameSync(target, previous);
      try {
        fs.renameSync(prepared, target);
      } catch (error) {
        if (hadPrevious) fs.renameSync(previous, target);
        throw error;
      }
      swaps.push({ target, previous, hadPrevious });
    }
  } catch (error) {
    for (const swap of swaps.reverse()) {
      try {
        fs.rmSync(swap.target, { recursive: true, force: true });
        if (swap.hadPrevious && fs.existsSync(swap.previous)) fs.renameSync(swap.previous, swap.target);
      } catch (rollbackError) {
        console.error(`Backup restore rollback failed for ${swap.target}: ${rollbackError.message}`);
      }
    }
    throw error;
  }

  for (const swap of swaps) {
    if (swap.hadPrevious) {
      try { fs.rmSync(swap.previous, { recursive: true, force: true }); }
      catch (error) { console.warn(`Could not remove previous restore data at ${swap.previous}: ${error.message}`); }
    }
  }
  for (const filePath of [CATALOG_PATH, COLLECTIONS_PATH, SOURCES_PATH, FAVORITES_PATH, PROFILES_PATH]) {
    try { fs.rmSync(`${filePath}.bak`, { force: true }); } catch (error) { /* stale backup cleanup is best effort */ }
  }
  cachedCatalog = null;
  catalogSignature = "";
}

const gameUpload = createMultipartUpload(MAX_UPLOAD_FILE_BYTES, 2);
const singleCoverUpload = createMultipartUpload(MAX_COVER_FILE_BYTES, 1);
const sidecarUpload = createMultipartUpload(MAX_SIDECAR_FILE_BYTES, MAX_SIDECAR_FILES);
const backupUploadDir = path.join(DATA_DIR, ".backup-imports");
const backupUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      try {
        fs.mkdirSync(backupUploadDir, { recursive: true });
        callback(null, backupUploadDir);
      } catch (error) {
        callback(error);
      }
    },
    filename(req, file, callback) {
      callback(null, `${crypto.randomUUID()}.tar.gz`);
    },
  }),
  limits: { fileSize: MAX_BACKUP_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
});

// ---- Public API ----

app.get("/api/games", (req, res) => {
  const q = (typeof req.query.q === "string" ? req.query.q : "").toLocaleLowerCase().trim();
  const tag = (typeof req.query.tag === "string" ? req.query.tag : "").toLowerCase().trim();
  let games = loadCatalog();
  if (q) {
    games = games.filter((g) =>
      [g.title, g.description, ...(g.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(q))
    );
  }
  if (tag) {
    games = games.filter((g) => (g.tags || []).some((t) => t.toLowerCase() === tag));
  }

  if (req.query.page !== undefined || req.query.limit !== undefined) {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 60));
    const total = games.length;
    const items = games.slice((page - 1) * limit, page * limit).map(publicGame);
    return res.json({ items, total, page, limit, hasMore: page * limit < total });
  }
  res.json(games.map(publicGame));
});

app.get("/api/status", (req, res) => {
  const ruffleReady = fs.existsSync(path.join(RUFFLE_DIR, "ruffle.js"));
  let ruffleVersion = "";
  try {
    ruffleVersion = fs.readFileSync(path.join(RUFFLE_DIR, "VERSION"), "utf-8").trim();
  } catch (err) {
    // A missing version marker is reported as an incomplete installation.
  }
  res.json({
    ok: true,
    configured: auth.isConfigured(),
    ruffleReady,
    ruffleVersion,
    storageConfigured: Boolean(process.env.FLASHBACK_DATA_DIR),
  });
});

app.get("/api/favorites", (req, res) => {
  const favoriteSlugs = favorites.listFavorites();
  const gamesBySlug = new Map(loadCatalog().map((game) => [game.slug, game]));
  res.json({
    slugs: favoriteSlugs,
    items: favoriteSlugs.map((slug) => gamesBySlug.get(slug)).filter(Boolean).map(publicGame),
  });
});

app.post("/api/favorites/:slug", requireSameOrigin, (req, res) => {
  const slug = req.params.slug;
  if (!loadCatalog().some((game) => game.slug === slug)) {
    return res.status(404).json({ error: "game_not_found" });
  }
  res.json({ ok: true, slugs: favorites.addFavorite(slug) });
});

app.delete("/api/favorites/:slug", requireSameOrigin, (req, res) => {
  res.json({ ok: true, slugs: favorites.removeFavorite(req.params.slug) });
});

app.get("/api/games/:slug", (req, res) => {
  const games = loadCatalog();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  res.json(game);
});

app.get("/api/games/:slug/download", (req, res) => {
  const game = loadCatalog().find((entry) => entry.slug === req.params.slug);
  if (!game || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.swf$/i.test(game.file || "")) {
    return res.status(404).json({ error: "game_not_found" });
  }

  const filePath = path.resolve(GAMES_DIR, game.file);
  const gamesRoot = path.resolve(GAMES_DIR);
  let actualPath;
  try {
    actualPath = fs.realpathSync(filePath);
  } catch (err) {
    return res.status(404).json({ error: "game_file_not_found" });
  }
  const relativePath = path.relative(gamesRoot, actualPath);
  if (relativePath.startsWith(`..${path.sep}`) || relativePath === ".." || path.isAbsolute(relativePath)) {
    return res.status(404).json({ error: "game_file_not_found" });
  }

  res.download(filePath, path.basename(game.file), (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "game_file_not_found" });
  });
});

app.get("/api/tags", (req, res) => {
  const games = loadCatalog();
  const counts = new Map();
  for (const g of games) {
    for (const t of g.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  res.json(tags);
});

// ---- Profiles & saves ----
// No password: a lightweight household profile picker (think Netflix/Steam
// Family), so game saves can follow a person across every device in the
// house instead of being stuck in one browser's localStorage. See
// server/lib/profiles.js for the storage layer.

app.get("/api/profiles", (req, res) => {
  res.json(profiles.loadProfiles());
});

app.post("/api/profiles", requireSameOrigin, (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  if (name.length > 40) return res.status(400).json({ error: "name_too_long" });
  res.status(201).json(profiles.createProfile(name));
});

app.get("/api/profiles/:profileId/saves/:gameSlug", (req, res) => {
  const { profileId, gameSlug } = req.params;
  if (!profiles.profileExists(profileId) || !loadCatalog().some((game) => game.slug === gameSlug)) {
    return res.status(404).json({ error: "profile_not_found" });
  }
  try {
    const data = profiles.getSave(profileId, gameSlug);
    if (!data) return res.status(404).json({ error: "no_save" });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: "save_unavailable" });
  }
});

app.post("/api/profiles/:profileId/saves/:gameSlug", requireSameOrigin, (req, res) => {
  const { profileId, gameSlug } = req.params;
  if (!profiles.profileExists(profileId) || !loadCatalog().some((game) => game.slug === gameSlug)) {
    return res.status(404).json({ error: "profile_not_found" });
  }
  const data = req.body.data;
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "data_required" });
  }
  try {
    profiles.putSave(profileId, gameSlug, data);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "invalid_save" });
  }
});

app.delete("/api/admin/profiles/:profileId", requireSameOrigin, auth.requireAdminApi, (req, res) => {
  const removed = profiles.deleteProfile(req.params.profileId);
  if (!removed) return res.status(404).json({ error: "profile_not_found" });
  res.json({ ok: true });
});

app.get("/api/collections", (req, res) => {
  const collections = loadCollections();
  res.json(
    collections.map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      cover: c.cover || null,
      coverVersion: c.coverVersion || 0,
      count: c.games.length,
    }))
  );
});

app.get("/api/collections/:slug", (req, res) => {
  const collections = loadCollections();
  const collection = collections.find((c) => c.slug === req.params.slug);
  if (!collection) return res.status(404).json({ error: "collection_not_found" });

  const catalog = loadCatalog();
  const gamesBySlug = new Map(catalog.map((g) => [g.slug, g]));
  const games = collection.games
    .map((slug) => gamesBySlug.get(slug))
    .filter(Boolean)
    .map(publicGame);

  res.json({
    slug: collection.slug,
    name: collection.name,
    description: collection.description,
    cover: collection.cover || null,
    games,
  });
});

// ---- Admin API (protected) ----

// Lightweight "am I logged in as admin?" check, used by public pages (e.g.
// play.html) to decide whether to show admin-only controls like the cover
// capture button.
app.get("/api/admin/session", auth.requireAdminApi, (req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/backup", auth.requireAdminApi, (req, res) => {
  const entries = makeBackupEntries();
  const manifest = {
    format: "flashback-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    fileCount: entries.length + 1,
    includes: ["game files", "covers", "sidecar files", "game saves", "catalog", "collections", "sources", "favorites", "profiles"],
    excludes: ["admin account", "login sessions", "Ruffle runtime"],
  };
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", 'attachment; filename="flashback-backup.tar.gz"');
  const archive = backupArchive.createTarGzipStream(entries, manifest);
  archive.on("error", (error) => {
    console.error(`FlashBack backup export failed: ${error.message}`);
    if (res.headersSent) res.destroy(error);
    else res.status(500).json({ error: "backup_export_failed" });
  });
  archive.pipe(res);
});

app.post(
  "/api/admin/backup/restore",
  requireSameOrigin,
  auth.requireAdminApi,
  (req, res, next) => {
    if (backupRestoreInProgress) return res.status(409).json({ error: "backup_restore_busy" });
    backupRestoreInProgress = true;
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_UPLOAD_BYTES) {
      backupRestoreInProgress = false;
      return res.status(413).json({ error: "backup_too_large" });
    }
    backupUpload.single("backup")(req, res, (error) => {
      if (error) {
        backupRestoreInProgress = false;
        return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "backup_too_large" : "backup_invalid" });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      backupRestoreInProgress = false;
      return res.status(400).json({ error: "backup_file_required" });
    }
    let stageDir = null;
    try {
      stageDir = fs.mkdtempSync(path.join(DATA_DIR, ".restore-"));
      const extraction = await backupArchive.extractTarGzipFile(req.file.path, stageDir, {
        allowPath: isAllowedBackupPath,
        maxFiles: MAX_BACKUP_FILES,
        maxBytes: MAX_BACKUP_EXPANDED_BYTES,
      });
      const requiredFiles = [
        "manifest.json",
        "data/catalog.json",
        "data/collections.json",
        "data/sources.json",
        "data/favorites.json",
        "data/profiles.json",
      ];
      if (requiredFiles.some((name) => !extraction.files.has(name))) {
        throw new Error("Backup is missing required catalog data");
      }
      const manifestPath = path.join(stageDir, "manifest.json");
      if (fs.statSync(manifestPath).size > MIB) throw new Error("Backup manifest is too large");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.format !== "flashback-backup" || manifest.version !== 1) {
        throw new Error("Backup format is not supported");
      }
      if (manifest.fileCount !== extraction.fileCount) throw new Error("Backup file count does not match its manifest");
      const catalog = validateBackupJson(stageDir, "data/catalog.json", Array.isArray);
      const savedCollections = validateBackupJson(stageDir, "data/collections.json", (value) =>
        Array.isArray(value) && value.every((collection) =>
          collection && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(collection.slug || "") &&
          typeof collection.name === "string" && Array.isArray(collection.games) &&
          collection.games.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug))
        )
      );
      const sources = validateBackupJson(stageDir, "data/sources.json", Array.isArray);
      const favoritesList = validateBackupJson(stageDir, "data/favorites.json", (value) =>
        Array.isArray(value) && value.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      );
      const savedProfiles = validateBackupJson(stageDir, "data/profiles.json", Array.isArray);
      if (!Array.isArray(favoritesList) || !Array.isArray(savedProfiles)) throw new Error("Backup catalog data is invalid");
      for (const profile of savedProfiles) {
        if (!profile || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(profile.id || "") || typeof profile.name !== "string") {
          throw new Error("Backup contains invalid profile data");
        }
      }
      for (const collection of savedCollections) {
        if (!collection.games.every((slug) => catalog.some((game) => game.slug === slug))) {
          throw new Error("Backup collection refers to a missing game");
        }
      }
      for (const source of sources) {
        if (!source || typeof source.id !== "string" || parseSourceInput(source).error) {
          throw new Error("Backup contains invalid saved source data");
        }
      }
      for (const game of catalog) {
        if (
          !game || typeof game.title !== "string" || !game.title.trim() ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(game.slug || "") ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*\.swf$/i.test(game.file || "") ||
          !extraction.files.has(`games/${game.file}`)
        ) throw new Error("Backup contains invalid or missing game files");
        const gamePath = path.join(stageDir, "games", game.file);
        const gameStat = fs.statSync(gamePath);
        if (gameStat.size > MAX_UPLOAD_FILE_BYTES) throw new Error(`Backup game exceeds the file limit: ${game.file}`);
        const header = Buffer.alloc(8);
        const descriptor = fs.openSync(gamePath, "r");
        try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
        if (!isValidSwf(header)) throw new Error(`Backup contains an invalid SWF: ${game.file}`);
        if (typeof game.sha256 === "string" && game.sha256 !== await sha256File(gamePath)) {
          throw new Error(`Backup game checksum does not match: ${game.file}`);
        }
      }
      for (const archivePath of extraction.files) {
        if (archivePath.startsWith("data/covers/")) {
          const filePath = path.join(stageDir, ...archivePath.split("/"));
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_COVER_FILE_BYTES) throw new Error("Backup cover exceeds the image size limit");
          const ext = path.extname(filePath).slice(1).toLowerCase();
          if (detectImageExt(fs.readFileSync(filePath)) !== ext) throw new Error("Backup contains an invalid cover image");
        } else if (archivePath.startsWith("data/game-assets/")) {
          if (fs.statSync(path.join(stageDir, ...archivePath.split("/"))).size > MAX_SIDECAR_FILE_BYTES) {
            throw new Error("Backup sidecar exceeds the file size limit");
          }
        } else if (archivePath.startsWith("data/saves/")) {
          const savePath = path.join(stageDir, ...archivePath.split("/"));
          if (fs.statSync(savePath).size > 5 * MIB) throw new Error("Backup save file exceeds the size limit");
          const saveData = JSON.parse(fs.readFileSync(savePath, "utf8"));
          if (!saveData || typeof saveData !== "object" || Array.isArray(saveData)) throw new Error("Backup contains an invalid game save");
        } else if (archivePath.startsWith("data/") && archivePath.endsWith(".json")) {
          if (fs.statSync(path.join(stageDir, ...archivePath.split("/"))).size > 256 * MIB) {
            throw new Error("Backup JSON file exceeds the size limit");
          }
        }
      }
      commitBackupTargets(stageDir);
      res.json({
        ok: true,
        games: catalog.length,
        files: extraction.fileCount,
        bytes: extraction.totalBytes,
        keepsAdminAccount: true,
      });
    } catch (error) {
      const message = error.message || "";
      console.warn(`FlashBack backup restore rejected: ${message}`);
      const conflict = message.includes("Configured storage paths overlap");
      res.status(conflict ? 409 : 400).json({ error: conflict ? "backup_storage_paths_overlap" : "backup_invalid" });
    } finally {
      if (stageDir) {
        try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (error) { /* cleanup is best effort */ }
      }
      try { fs.rmSync(req.file.path, { force: true }); } catch (error) { /* cleanup is best effort */ }
      try { fs.rmdirSync(backupUploadDir); } catch (error) { /* leave directory while another restore is running */ }
      backupRestoreInProgress = false;
    }
  }
);

app.get("/api/admin/sources", auth.requireAdminApi, (req, res) => {
  const sources = loadSources().sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  res.json(sources);
});

app.post("/api/admin/sources", requireSameOrigin, auth.requireAdminApi, (req, res) => {
  const parsed = parseSourceInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const sources = loadSources();
  const urlKey = sourceUrlKey(parsed.value.url);
  if (hasDuplicateSourceUrl(sources, urlKey)) {
    return res.status(409).json({ error: "source_url_duplicate" });
  }

  const now = new Date().toISOString();
  const source = {
    id: crypto.randomUUID(),
    ...parsed.value,
    healthStatus: "unchecked",
    healthCheckedAt: null,
    healthHttpStatus: null,
    createdAt: now,
    updatedAt: now,
  };
  sources.push(source);
  saveSources(sources);
  res.status(201).json(source);
});

app.put("/api/admin/sources/:id", requireSameOrigin, auth.requireAdminApi, (req, res) => {
  const sources = loadSources();
  const index = sources.findIndex((source) => source.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "source_not_found" });

  const parsed = parseSourceInput({ ...sources[index], ...req.body });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const urlKey = sourceUrlKey(parsed.value.url);
  if (hasDuplicateSourceUrl(sources, urlKey, index)) {
    return res.status(409).json({ error: "source_url_duplicate" });
  }

  const urlChanged = sourceUrlKey(sources[index].url) !== urlKey;
  sources[index] = {
    ...sources[index],
    ...parsed.value,
    ...(urlChanged ? { healthStatus: "unchecked", healthCheckedAt: null, healthHttpStatus: null } : {}),
    updatedAt: new Date().toISOString(),
  };
  saveSources(sources);
  res.json(sources[index]);
});

app.delete("/api/admin/sources/:id", requireSameOrigin, auth.requireAdminApi, (req, res) => {
  const sources = loadSources();
  const index = sources.findIndex((source) => source.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "source_not_found" });
  sources.splice(index, 1);
  saveSources(sources);
  res.json({ ok: true });
});

app.post("/api/admin/sources/:id/check", requireSameOrigin, auth.requireAdminApi, async (req, res) => {
  const sources = loadSources();
  const source = sources.find((item) => item.id === req.params.id);
  if (!source) return res.status(404).json({ error: "source_not_found" });

  const result = await flashpoint.checkPublicUrl(source.url);
  source.healthStatus = result.healthStatus;
  source.healthCheckedAt = new Date().toISOString();
  source.healthHttpStatus = result.httpStatus;
  source.updatedAt = source.healthCheckedAt;
  saveSources(sources);
  res.json(source);
});

app.get("/api/admin/games", auth.requireAdminApi, (req, res) => {
  res.json(loadCatalog());
});

app.get("/api/admin/games/:slug/diagnostics", auth.requireAdminApi, (req, res) => {
  const game = loadCatalog().find((entry) => entry.slug === req.params.slug);
  if (!game || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.swf$/i.test(game.file || "")) {
    return res.status(404).json({ error: "game_not_found" });
  }
  const filePath = path.join(GAMES_DIR, game.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "game_file_not_found" });
  const buffer = fs.readFileSync(filePath);
  const assetsDir = gameAssetsDir(game.slug);
  const installedSidecars = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((name) => isSafeAssetFilename(name)).sort()
    : [];
  const ruffleReady = fs.existsSync(path.join(RUFFLE_DIR, "ruffle.js"));
  let ruffleVersion = "";
  try {
    ruffleVersion = fs.readFileSync(path.join(RUFFLE_DIR, "VERSION"), "utf8").trim();
  } catch (error) {
    // A missing version file is reported as unavailable version metadata.
  }
  res.json({
    analysis: swfAnalysis.inspectSwf(buffer, { sha: game.sha256, installedSidecars }),
    ruffle: { ready: ruffleReady, version: ruffleVersion || null },
    renderer: game.renderer || "auto",
    source: game.source || null,
  });
});

app.post(
  "/api/admin/games",
  auth.requireAdminApi,
  rejectOversizedMultipart,
  (req, res, next) => {
    gameUpload.fields([{ name: "swf", maxCount: 1 }, { name: "cover", maxCount: 1 }])(req, res, (err) => {
      if (err) return res.status(uploadErrorStatus(err)).json({ error: err.code === "LIMIT_FILE_SIZE" ? "upload_too_large" : err.message });
      next();
    });
  },
  async (req, res) => {
    const file = req.files?.swf?.[0];
    const coverFile = req.files?.cover?.[0];
    const title = (req.body.title || "").trim();
    const description = (req.body.description || "").trim();
    const tags = [
      ...new Set(
        (req.body.tags || "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      ),
    ].sort();

    if (!file) {
      return res.status(400).json({ error: "no_file" });
    }
    if (!title) {
      return res.status(400).json({ error: "title_required" });
    }
    if (!isValidSwf(file.buffer)) {
      return res.status(400).json({
        error: "invalid_swf",
      });
    }
    if (coverFile && !detectImageExt(coverFile.buffer)) {
      return res.status(400).json({
        error: "invalid_cover",
      });
    }

    const catalog = loadCatalog();
    let source = null;
    const sourceId = typeof req.body.sourceId === "string" ? req.body.sourceId.trim() : "";
    if (sourceId) {
      const registeredSource = loadSources().find((item) => item.id === sourceId);
      if (!registeredSource) return res.status(400).json({ error: "source_not_found" });
      source = {
        id: registeredSource.id,
        name: registeredSource.name,
        url: registeredSource.url,
        importedAt: new Date().toISOString(),
        method: "manual-upload",
      };
    }
    const { game: duplicate, digest } = await findDuplicateSwf(catalog, file.buffer);
    if (duplicate) {
      return res.status(409).json({
        error: "duplicate_swf",
        existingGame: { slug: duplicate.slug, title: duplicate.title },
        sha256: digest,
      });
    }
    const slug = uniqueSlug(catalog.map((g) => g.slug), slugify(title));
    const filename = `${slug}.swf`;

    fs.mkdirSync(GAMES_DIR, { recursive: true });
    fs.writeFileSync(path.join(GAMES_DIR, filename), file.buffer);

    const coverExt = coverFile ? saveCover(COVERS_DIR, slug, coverFile.buffer) : null;

    const entry = {
      slug,
      title,
      description,
      file: filename,
      sizeBytes: file.buffer.length,
      cover: coverExt,
      coverVersion: coverExt ? Date.now() : 0,
      tags,
      sha256: digest,
      sidecarHints: swfAnalysis.sidecarHints(file.buffer),
      ...(source ? { source } : {}),
    };

    catalog.push(entry);
    catalog.sort((a, b) => a.title.localeCompare(b.title));
    saveCatalog(catalog);

    res.status(201).json(entry);
  }
);

// ---- Admin: import from Flashpoint Archive ----
//
// Manually triggered, one-game-at-a-time lookups against
// flashpointarchive.org — never a bulk/automatic scraper. See
// server/lib/flashpoint.js for the cooldown and sequential-request rules
// that keep this respectful of the site and of the original hosts a game's
// launch commands point to.

app.get("/api/admin/flashpoint/search", auth.requireAdminApi, async (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "query_required" });

  const wait = flashpoint.trySearchSlot();
  if (wait > 0) return res.status(429).json({ error: "too_many_requests", retryAfterMs: wait });

  try {
    const results = await flashpoint.search(query);
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: "flashpoint_unreachable" });
  }
});

app.post("/api/admin/flashpoint/import", auth.requireAdminApi, async (req, res) => {
  const id = (req.body.id || "").trim();
  if (!id) return res.status(400).json({ error: "id_required" });
  if (!flashpoint.isFlashpointId(id)) return res.status(400).json({ error: "invalid_flashpoint_id" });

  const wait = flashpoint.tryImportSlot();
  if (wait > 0) return res.status(429).json({ error: "too_many_requests", retryAfterMs: wait });

  let entry;
  try {
    entry = await flashpoint.getEntry(id);
  } catch (err) {
    return res.status(502).json({ error: "flashpoint_unreachable" });
  }

  if (entry.platform !== "Flash") {
    return res.status(400).json({ error: "not_a_flash_game" });
  }

  const catalog = loadCatalog();
  const alreadyImported = catalog.find((game) => game.flashpointId === id);
  if (alreadyImported) {
    return res.status(409).json({
      error: "duplicate_flashpoint_entry",
      existingGame: { slug: alreadyImported.slug, title: alreadyImported.title },
    });
  }

  let found = await flashpoint.fetchFirstValidSwf(entry.launchCommands);
  if (!found && entry.archiveAvailable !== false) {
    try {
      found = await flashpoint.fetchGameZipSwf(id, entry.archiveLaunchCommand);
    } catch (err) {
      const knownErrors = new Set([
        "ERR_INVALID_GAMEZIP",
        "ERR_GAMEZIP_SWF_NOT_FOUND",
        "ERR_GAMEZIP_SWF_AMBIGUOUS",
        "ERR_INVALID_GAMEZIP_SWF",
      ]);
      if (knownErrors.has(err.code)) {
        return res.status(422).json({ error: err.code.toLowerCase().replace(/^err_/, "") });
      }
      console.error("Flashpoint GameZIP import failed:", err);
    }
  }
  if (!found) {
    return res.status(404).json({ error: "flashpoint_backup_unavailable" });
  }

  const title = entry.title || "Untitled";
  const { game: duplicate, digest } = await findDuplicateSwf(catalog, found.buffer);
  if (duplicate) {
    return res.status(409).json({
      error: "duplicate_swf",
      existingGame: { slug: duplicate.slug, title: duplicate.title },
      sha256: digest,
    });
  }
  const slug = uniqueSlug(catalog.map((g) => g.slug), slugify(title));
  const filename = `${slug}.swf`;

  fs.mkdirSync(GAMES_DIR, { recursive: true });
  fs.writeFileSync(path.join(GAMES_DIR, filename), found.buffer);

  let coverBuffer = await flashpoint.fetchScreenshot(id);
  let coverSource = coverBuffer && detectImageExt(coverBuffer) ? "flashpoint-screenshot" : null;
  if (!coverSource) {
    coverBuffer = await flashpoint.fetchLogo(id);
    coverSource = coverBuffer && detectImageExt(coverBuffer) ? "flashpoint-logo" : null;
  }
  const coverExt = coverSource ? saveCover(COVERS_DIR, slug, coverBuffer) : null;

  // Best-effort: some games need a sidecar file (XML config, level list...)
  // fetched from the same directory as their .swf at runtime. A missing one
  // never blocks the import — it just means the admin may need to add it
  // by hand later via "Extra files" if the game turns out to need it.
  let sidecarAssets = found.sidecarAssets || [];
  if (!found.fromGameZip) {
    try {
      sidecarAssets = await flashpoint.fetchSidecarAssets(found.buffer, found.sourceUrl);
    } catch (err) {
      // Non-fatal — proceed without any sidecar assets.
    }
  }
  if (sidecarAssets.length > 0) {
    const assetsDir = gameAssetsDir(slug);
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const asset of sidecarAssets) {
      fs.writeFileSync(path.join(assetsDir, asset.filename), asset.buffer);
    }
  }

  const newEntry = {
    slug,
    title,
    description: entry.description || "",
    file: filename,
    sizeBytes: found.buffer.length,
    cover: coverExt,
    coverSource,
    coverVersion: coverExt ? Date.now() : 0,
    flashpointId: id,
    sha256: digest,
    sidecarHints: swfAnalysis.sidecarHints(found.buffer),
    source: {
      id: `flashpoint:${id}`,
      name: "Flashpoint Archive",
      url: "https://flashpointarchive.org/",
      importedAt: new Date().toISOString(),
      method: found.fromGameZip ? "flashpoint-gamezip" : "original-link",
      referenceId: id,
    },
    tags: [],
  };

  catalog.push(newEntry);
  catalog.sort((a, b) => a.title.localeCompare(b.title));
  saveCatalog(catalog);

  res.status(201).json({ ...newEntry, sidecarAssets: sidecarAssets.map((a) => a.filename) });
});

app.post(
  "/api/admin/games/:slug/cover",
  auth.requireAdminApi,
  rejectOversizedMultipart,
  (req, res, next) => {
    singleCoverUpload.single("cover")(req, res, (err) => {
      if (err) return res.status(uploadErrorStatus(err)).json({ error: err.code === "LIMIT_FILE_SIZE" ? "upload_too_large" : err.message });
      next();
    });
  },
  (req, res) => {
    const catalog = loadCatalog();
    const game = catalog.find((g) => g.slug === req.params.slug);
    if (!game) return res.status(404).json({ error: "game_not_found" });

    if (!req.file) {
      return res.status(400).json({ error: "no_image" });
    }

    const ext = detectImageExt(req.file.buffer);
    if (!ext) {
      return res.status(400).json({
        error: "invalid_cover",
      });
    }

    game.cover = saveCover(COVERS_DIR, game.slug, req.file.buffer);
    game.coverSource = req.body?.source === "game-capture" ? "game-capture" : "upload";
    game.coverVersion = Date.now();
    saveCatalog(catalog);
    res.json(game);
  }
);

app.post("/api/admin/games/:slug/flashpoint-cover", auth.requireAdminApi, async (req, res) => {
  const catalog = loadCatalog();
  const game = catalog.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).json({ error: "game_not_found" });

  const kind = req.body.kind;
  if (kind !== "screenshot" && kind !== "logo") {
    return res.status(400).json({ error: "invalid_cover_source" });
  }
  if (!flashpoint.isFlashpointId(game.flashpointId)) {
    return res.status(409).json({ error: "flashpoint_source_missing" });
  }

  const image = kind === "screenshot"
    ? await flashpoint.fetchScreenshot(game.flashpointId)
    : await flashpoint.fetchLogo(game.flashpointId);
  const ext = image && detectImageExt(image);
  if (!ext) return res.status(404).json({ error: "flashpoint_cover_unavailable" });

  game.cover = saveCover(COVERS_DIR, game.slug, image);
  game.coverSource = `flashpoint-${kind}`;
  game.coverVersion = Date.now();
  saveCatalog(catalog);
  res.json(game);
});

app.put("/api/admin/games/:slug/tags", auth.requireAdminApi, (req, res) => {
  const catalog = loadCatalog();
  const game = catalog.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).json({ error: "game_not_found" });

  const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
  game.tags = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();

  saveCatalog(catalog);
  res.json(game);
});

app.put("/api/admin/games/:slug", auth.requireAdminApi, (req, res) => {
  const catalog = loadCatalog();
  const game = catalog.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).json({ error: "game_not_found" });

  if (typeof req.body.title === "string") {
    const title = req.body.title.trim();
    if (!title) return res.status(400).json({ error: "title_required" });
    if (title.length > 100) return res.status(400).json({ error: "title_too_long" });
    game.title = title;
  }
  if (typeof req.body.description === "string") {
    const description = req.body.description.trim();
    if (description.length > 500) return res.status(400).json({ error: "description_too_long" });
    game.description = description;
  }
  if (req.body.renderer === "auto" || req.body.renderer === "canvas") {
    game.renderer = req.body.renderer;
  }

  saveCatalog(catalog);
  res.json(game);
});

app.delete("/api/admin/games/:slug", auth.requireAdminApi, (req, res) => {
  const originalCatalog = loadCatalog().slice();
  const removed = originalCatalog.find((game) => game.slug === req.params.slug);
  if (!removed) return res.status(404).json({ error: "game_not_found" });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(removed.slug || "")) {
    return res.status(400).json({ error: "invalid_game_entry" });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.swf$/i.test(removed.file || "")) {
    return res.status(400).json({ error: "invalid_game_entry" });
  }

  let gamePath;
  let assetsPath;
  try {
    gamePath = resolveManagedPath(GAMES_DIR, removed.file);
    assetsPath = resolveManagedPath(GAME_ASSETS_DIR, removed.slug);
  } catch (error) {
    return res.status(400).json({ error: "invalid_game_entry" });
  }

  const originalFavorites = favorites.listFavorites();
  const originalCollections = loadCollections();
  const nextCatalog = originalCatalog.filter((game) => game.slug !== removed.slug);
  const nextFavorites = originalFavorites.filter((slug) => slug !== removed.slug);
  const nextCollections = originalCollections.map((collection) => ({
    ...collection,
    games: Array.isArray(collection.games)
      ? collection.games.filter((slug) => slug !== removed.slug)
      : [],
  }));
  const affectedCollections = originalCollections
    .filter((collection) => Array.isArray(collection.games) && collection.games.includes(removed.slug))
    .map((collection) => collection.slug);
  const quarantineId = crypto.randomUUID();
  const moves = [];
  let catalogWriteAttempted = false;
  let favoritesWriteAttempted = false;
  let collectionsWriteAttempted = false;

  try {
    // Persist all references first. If moving an asset fails below, restore
    // these snapshots and move every already-quarantined item back.
    catalogWriteAttempted = true;
    saveCatalog(nextCatalog);
    favoritesWriteAttempted = true;
    writeJson(FAVORITES_PATH, nextFavorites);
    collectionsWriteAttempted = true;
    saveCollections(nextCollections);

    const quarantinedGame = moveToQuarantine(GAMES_DIR, gamePath, quarantineId);
    if (quarantinedGame) moves.push(quarantinedGame);

    for (const extension of ["jpg", "png", "webp"]) {
      const coverPath = resolveManagedPath(COVERS_DIR, `${removed.slug}.${extension}`);
      const quarantinedCover = moveToQuarantine(COVERS_DIR, coverPath, quarantineId);
      if (quarantinedCover) moves.push(quarantinedCover);
    }

    const quarantinedAssets = moveToQuarantine(GAME_ASSETS_DIR, assetsPath, quarantineId);
    if (quarantinedAssets) moves.push(quarantinedAssets);

    const manifestPath = path.join(DATA_DIR, "quarantine", "deleted-games", `${quarantineId}.json`);
    writeJson(manifestPath, {
      id: quarantineId,
      deletedAt: new Date().toISOString(),
      game: removed,
      wasFavorite: originalFavorites.includes(removed.slug),
      collectionSlugs: affectedCollections,
      files: moves,
    });
  } catch (error) {
    const rollbackErrors = rollbackQuarantineMoves(moves);
    if (catalogWriteAttempted) {
      try {
        saveCatalog(originalCatalog);
      } catch (rollbackError) {
        cachedCatalog = originalCatalog;
        catalogSignature = "";
        rollbackErrors.push(rollbackError);
      }
    }
    if (favoritesWriteAttempted) {
      try {
        writeJson(FAVORITES_PATH, originalFavorites);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (collectionsWriteAttempted) {
      try {
        saveCollections(originalCollections);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      console.error("FlashBack game deletion rollback was incomplete:", rollbackErrors);
    }
    console.error("FlashBack game deletion failed:", error);
    return res.status(500).json({
      error: "game_delete_failed",
      rollbackComplete: rollbackErrors.length === 0,
    });
  }

  res.json({ ok: true, quarantineId });
});

// ---- Admin: extra game assets ----
// Some Flash games load sidecar files at runtime (an XML config, a level
// list, ...) via a relative URL next to the .swf — same-directory sibling
// files, not embedded in the movie itself. Our importer only ever grabs
// the single .swf, so those games break with the sidecar file missing
// until an admin finds and uploads it here by hand. Served under
// /game-assets/<slug>/ and pointed at via Ruffle's `base` load option
// (see public/js/play.js), so relative loads inside the movie resolve to
// this folder instead of colliding with any other game's same-named file.

function gameAssetsDir(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || "")) {
    throw new Error("Invalid game slug");
  }
  return resolveManagedPath(GAME_ASSETS_DIR, slug);
}

function requireGameAssetTarget(req, res, next) {
  const { slug } = req.params;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || "")) {
    return res.status(400).json({ error: "invalid_game_slug" });
  }
  const game = loadCatalog().find((item) => item.slug === slug);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  next();
}

function isSafeAssetFilename(filename) {
  return typeof filename === "string" &&
    filename !== "." &&
    filename !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(filename);
}

function resolveManagedPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid managed path");
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const insidePath = path.relative(resolvedRoot, resolvedPath);
  if (
    !insidePath ||
    insidePath === ".." ||
    insidePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(insidePath)
  ) {
    throw new Error("Managed path escapes its storage directory");
  }
  return resolvedPath;
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function moveToQuarantine(root, sourcePath, quarantineId) {
  const resolvedRoot = path.resolve(root);
  const resolvedSource = path.resolve(sourcePath);
  const relativePath = path.relative(resolvedRoot, resolvedSource);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Quarantine source escapes its storage directory");
  }
  if (!pathExists(resolvedSource)) return null;

  const quarantinedPath = path.join(
    resolvedRoot,
    ".flashback-quarantine",
    quarantineId,
    relativePath
  );
  fs.mkdirSync(path.dirname(quarantinedPath), { recursive: true });
  fs.renameSync(resolvedSource, quarantinedPath);
  return { source: resolvedSource, quarantined: quarantinedPath };
}

function rollbackQuarantineMoves(moves) {
  const errors = [];
  for (const move of [...moves].reverse()) {
    try {
      if (!pathExists(move.quarantined)) continue;
      if (pathExists(move.source)) throw new Error(`Rollback target already exists: ${move.source}`);
      fs.mkdirSync(path.dirname(move.source), { recursive: true });
      fs.renameSync(move.quarantined, move.source);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

app.get("/api/admin/games/:slug/assets", auth.requireAdminApi, requireGameAssetTarget, (req, res) => {
  const dir = gameAssetsDir(req.params.slug);
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir).sort());
});

app.post(
  "/api/admin/games/:slug/assets",
  auth.requireAdminApi,
  requireGameAssetTarget,
  rejectOversizedMultipart,
  (req, res, next) => {
    sidecarUpload.array("files", MAX_SIDECAR_FILES)(req, res, (err) => {
      if (err) return res.status(uploadErrorStatus(err)).json({ error: err.code === "LIMIT_FILE_SIZE" ? "upload_too_large" : err.message });
      next();
    });
  },
  (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: "no_file" });

    const dir = gameAssetsDir(req.params.slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
      // originalname is admin-supplied (not end-user input) but still
      // sanitized: no path traversal, no nested directories.
      const safeName = path.basename(file.originalname).replace(/[^\w.\-]/g, "_");
      if (!safeName) continue;
      fs.writeFileSync(path.join(dir, safeName), file.buffer);
    }

    res.status(201).json(fs.readdirSync(dir).sort());
  }
);

app.delete("/api/admin/games/:slug/assets/:filename", auth.requireAdminApi, requireGameAssetTarget, (req, res) => {
  if (!isSafeAssetFilename(req.params.filename)) {
    return res.status(400).json({ error: "invalid_asset_filename" });
  }
  const dir = gameAssetsDir(req.params.slug);
  const filePath = path.join(dir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "asset_not_found" });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---- Admin: collections ----

app.get("/api/admin/collections", auth.requireAdminApi, (req, res) => {
  res.json(loadCollections());
});

app.post("/api/admin/collections", auth.requireAdminApi, (req, res) => {
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim();

  if (!name) {
    return res.status(400).json({ error: "collection_name_required" });
  }

  const collections = loadCollections();
  const slug = uniqueSlug(collections.map((c) => c.slug), slugify(name));

  const entry = { slug, name, description, games: [], cover: null };
  collections.push(entry);
  saveCollections(collections);

  res.status(201).json(entry);
});

app.put("/api/admin/collections/:slug", auth.requireAdminApi, (req, res) => {
  const collections = loadCollections();
  const collection = collections.find((c) => c.slug === req.params.slug);
  if (!collection) return res.status(404).json({ error: "collection_not_found" });

  if (typeof req.body.name === "string" && req.body.name.trim()) {
    collection.name = req.body.name.trim();
  }
  if (typeof req.body.description === "string") {
    collection.description = req.body.description.trim();
  }

  saveCollections(collections);
  res.json(collection);
});

app.delete("/api/admin/collections/:slug", auth.requireAdminApi, (req, res) => {
  const collections = loadCollections();
  const index = collections.findIndex((c) => c.slug === req.params.slug);
  if (index === -1) return res.status(404).json({ error: "collection_not_found" });

  const [removed] = collections.splice(index, 1);
  removeExistingCovers(COLLECTION_COVERS_DIR, removed.slug);
  saveCollections(collections);
  res.json({ ok: true });
});

app.post(
  "/api/admin/collections/:slug/cover",
  auth.requireAdminApi,
  rejectOversizedMultipart,
  (req, res, next) => {
    singleCoverUpload.single("cover")(req, res, (err) => {
      if (err) return res.status(uploadErrorStatus(err)).json({ error: err.code === "LIMIT_FILE_SIZE" ? "upload_too_large" : err.message });
      next();
    });
  },
  (req, res) => {
    const collections = loadCollections();
    const collection = collections.find((c) => c.slug === req.params.slug);
    if (!collection) return res.status(404).json({ error: "collection_not_found" });

    if (!req.file) {
      return res.status(400).json({ error: "no_image" });
    }

    const ext = detectImageExt(req.file.buffer);
    if (!ext) {
      return res.status(400).json({
        error: "invalid_cover",
      });
    }

    collection.cover = saveCover(COLLECTION_COVERS_DIR, collection.slug, req.file.buffer);
    collection.coverVersion = Date.now();
    saveCollections(collections);
    res.json(collection);
  }
);

app.post("/api/admin/collections/:slug/games", auth.requireAdminApi, (req, res) => {
  const collections = loadCollections();
  const collection = collections.find((c) => c.slug === req.params.slug);
  if (!collection) return res.status(404).json({ error: "collection_not_found" });

  const gameSlug = (req.body.gameSlug || "").trim();
  const catalog = loadCatalog();
  if (!catalog.some((g) => g.slug === gameSlug)) {
    return res.status(400).json({ error: "game_not_found" });
  }

  if (!collection.games.includes(gameSlug)) {
    collection.games.push(gameSlug);
    saveCollections(collections);
  }

  res.json(collection);
});

app.delete("/api/admin/collections/:slug/games/:gameSlug", auth.requireAdminApi, (req, res) => {
  const collections = loadCollections();
  const collection = collections.find((c) => c.slug === req.params.slug);
  if (!collection) return res.status(404).json({ error: "collection_not_found" });

  const idx = collection.games.indexOf(req.params.gameSlug);
  if (idx !== -1) {
    collection.games.splice(idx, 1);
    saveCollections(collections);
  }

  res.json(collection);
});

// ---- Auth pages/API ----

app.get("/api/setup/status", (req, res) => {
  res.json({ configured: auth.isConfigured() });
});

app.post("/api/setup", (req, res) => {
  if (auth.isConfigured()) {
    return res.status(400).json({ error: "already_configured" });
  }

  const username = (req.body.username || "").trim();
  const password = req.body.password || "";

  if (username.length < 3) {
    return res.status(400).json({ error: "username_too_short" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password_too_short" });
  }

  auth.createAdmin(username, password);
  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  res.status(201).json({ ok: true });
});

app.post("/api/login", (req, res) => {
  if (!auth.isConfigured()) {
    return res.status(400).json({ error: "not_configured" });
  }

  const username = (req.body.username || "").trim();
  const password = req.body.password || "";

  if (!auth.verifyLogin(username, password)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const token = auth.getSessionToken(req);
  if (token) auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- Clean URLs (no .html) ----

// Anyone hitting an old/bookmarked *.html URL gets redirected to the clean
// path. This also closes off direct access to admin.html/setup.html via
// static serving, since this runs before express.static below.
app.get(/\.html$/, (req, res) => {
  const clean = req.path.slice(0, -".html".length);
  const qs = req.originalUrl.slice(req.path.length);
  res.redirect(301, (clean === "/index" ? "/" : clean) + qs);
});

app.get("/setup", (req, res) => {
  if (auth.isConfigured()) return res.redirect("/login");
  res.sendFile(path.join(PUBLIC_DIR, "setup.html"));
});

app.get("/admin", auth.requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/sources", auth.requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "sources.html"));
});

const CLEAN_PAGES = {
  "/": "index.html",
  "/favorites": "favorites.html",
  "/collections": "collections.html",
  "/collection": "collection.html",
  "/play": "play.html",
  "/login": "login.html",
};

for (const [route, file] of Object.entries(CLEAN_PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
}

app.use("/games", express.static(GAMES_DIR, { fallthrough: false }));
app.use("/game-assets", express.static(GAME_ASSETS_DIR));
app.use("/covers", express.static(COVERS_DIR));
app.use("/ruffle", express.static(RUFFLE_DIR, { fallthrough: false }));
app.use(express.static(PUBLIC_DIR, { index: false }));

app.listen(PORT, HOST, () => {
  console.log(`flashback listening on http://${HOST}:${PORT}`);
});
