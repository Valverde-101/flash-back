// Storage for household "profiles" (no password, just a name — think
// Netflix/Steam Family profile picker) and per-profile game saves.
//
// Implemented today as flat JSON files, matching the rest of the project.
// Every function here is intentionally the only place that touches the
// filesystem, so swapping this for SQLite/MariaDB later (for password-
// protected multi-user accounts) only means rewriting this one module —
// the API routes and frontend never touch the storage layer directly.
const fs = require("fs");
const path = require("path");
const { slugify } = require("./slugify");
const { PROFILES_PATH, SAVES_DIR } = require("./paths");
const { readJson, writeJson } = require("./jsonStore");

const isProfileList = (value) => Array.isArray(value);
const isValidId = (value) => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

function loadProfiles() {
  return readJson(PROFILES_PATH, [], isProfileList);
}

function saveProfiles(profiles) {
  writeJson(PROFILES_PATH, profiles);
}

function uniqueId(existingIds, baseId) {
  const existing = new Set(existingIds);
  if (!existing.has(baseId)) return baseId;
  let i = 2;
  while (existing.has(`${baseId}-${i}`)) i++;
  return `${baseId}-${i}`;
}

function createProfile(name) {
  const profiles = loadProfiles();
  const baseId = slugify(name) || "player";
  const id = uniqueId(
    profiles.map((p) => p.id),
    baseId
  );
  const profile = { id, name };
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

function deleteProfile(id) {
  if (!isValidId(id)) return false;
  const profiles = loadProfiles();
  const index = profiles.findIndex((p) => p.id === id);
  if (index === -1) return false;
  profiles.splice(index, 1);
  saveProfiles(profiles);
  const dir = path.join(SAVES_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function profileExists(id) {
  if (!isValidId(id)) return false;
  return loadProfiles().some((p) => p.id === id);
}

function savePath(profileId, gameSlug) {
  if (!isValidId(profileId) || !isValidId(gameSlug)) {
    throw new Error("Invalid profile or game identifier");
  }
  return path.join(SAVES_DIR, profileId, `${gameSlug}.json`);
}

// A save is just an opaque bag of localStorage key/value pairs (everything
// Ruffle wrote for that game's SharedObject data) — we don't parse or
// understand the contents, just round-trip them.
function getSave(profileId, gameSlug) {
  const file = savePath(profileId, gameSlug);
  if (!fs.existsSync(file)) return null;
  return readJson(file, null, (value) => value && typeof value === "object" && !Array.isArray(value));
}

function putSave(profileId, gameSlug, data) {
  const file = savePath(profileId, gameSlug);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid save data");
  }
  writeJson(file, data);
}

module.exports = {
  loadProfiles,
  createProfile,
  deleteProfile,
  profileExists,
  getSave,
  putSave,
};
