const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.resolve(process.env.FLASHBACK_DATA_DIR || path.join(ROOT_DIR, "data"));

// Keep the original repository layout when no external data directory is
// configured. AndroidBuild can point mutable data at State without making
// the app dependent on an AndroidBuild-specific path.
const GAMES_DIR = path.resolve(
  process.env.FLASHBACK_GAMES_DIR ||
    (process.env.FLASHBACK_DATA_DIR ? path.join(DATA_DIR, "games") : path.join(ROOT_DIR, "games"))
);
const CATALOG_PATH = path.join(DATA_DIR, "catalog.json");
const COLLECTIONS_PATH = path.join(DATA_DIR, "collections.json");
const SOURCES_PATH = path.join(DATA_DIR, "sources.json");
const FAVORITES_PATH = path.join(DATA_DIR, "favorites.json");
const ADMIN_PATH = path.join(DATA_DIR, "admin.json");
const PROFILES_PATH = path.join(DATA_DIR, "profiles.json");
const SAVES_DIR = path.join(DATA_DIR, "saves");
const GAME_ASSETS_DIR = path.join(DATA_DIR, "game-assets");
const COVERS_DIR = path.join(DATA_DIR, "covers");
const COLLECTION_COVERS_DIR = path.join(COVERS_DIR, "collections");
const RUFFLE_DIR = path.resolve(
  process.env.FLASHBACK_RUFFLE_DIR || path.join(ROOT_DIR, "public", "ruffle")
);
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  GAMES_DIR,
  CATALOG_PATH,
  COLLECTIONS_PATH,
  SOURCES_PATH,
  FAVORITES_PATH,
  ADMIN_PATH,
  PROFILES_PATH,
  SAVES_DIR,
  GAME_ASSETS_DIR,
  COVERS_DIR,
  COLLECTION_COVERS_DIR,
  RUFFLE_DIR,
  PUBLIC_DIR,
};
