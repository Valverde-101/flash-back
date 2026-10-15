const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function launchServer(port, dataDir, gamesDir, ruffleDir, extraEnv = {}) {
  return spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      FLASHBACK_DATA_DIR: dataDir,
      FLASHBACK_GAMES_DIR: gamesDir,
      FLASHBACK_RUFFLE_DIR: ruffleDir,
      ...extraEnv,
    },
    stdio: "ignore",
  });
}

async function configureAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "temporary-test-password" }),
  });
  assert.equal(response.status, 201);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "setup should return the admin session cookie");
  return setCookie.split(";", 1)[0];
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`FlashBack exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return response.json();
    } catch (error) {
      // The server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("FlashBack did not start within 10 seconds");
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

test("local library search, favorites, downloads, origin checks, and restart persistence", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flashback-integration-"));
  const dataDir = path.join(temporaryRoot, "state");
  const gamesDir = path.join(temporaryRoot, "games");
  const ruffleDir = path.join(temporaryRoot, "ruffle-missing");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(gamesDir, { recursive: true });
    fs.writeFileSync(path.join(gamesDir, "demo-game.swf"), Buffer.from("FWS\x09\x08\x07\x06", "binary"));
    fs.writeFileSync(path.join(temporaryRoot, "secret.swf"), Buffer.from("outside"));
    const catalog = [
      { slug: "demo-game", title: "Demo Game", description: "Fast platform adventure", tags: ["platformer"], file: "demo-game.swf" },
      { slug: "bad-entry", title: "Invalid path", description: "", tags: [], file: "../secret.swf" },
    ];
    for (let index = 1; index <= 120; index++) {
      catalog.push({ slug: `sample-${index}`, title: `Sample Game ${index}`, description: "Pagination fixture", tags: ["sample"], file: `sample-${index}.swf` });
    }
    fs.writeFileSync(path.join(dataDir, "catalog.json"), JSON.stringify(catalog));

    child = launchServer(port, dataDir, gamesDir, ruffleDir);
    const status = await waitForServer(baseUrl, child);
    assert.equal(status.configured, false);
    assert.equal(status.ruffleReady, false);

    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "temporary-test-password" }),
    });
    assert.equal(setupResponse.status, 201);

    const searchResponse = await fetch(`${baseUrl}/api/games?q=platform&page=1&limit=1`);
    assert.equal(searchResponse.status, 200);
    const search = await searchResponse.json();
    assert.equal(search.total, 1);
    assert.equal(search.items[0].slug, "demo-game");
    assert.equal(search.hasMore, false);
    const firstPage = await (await fetch(`${baseUrl}/api/games?q=Sample&page=1&limit=60`)).json();
    assert.equal(firstPage.total, 120);
    assert.equal(firstPage.items.length, 60);
    assert.equal(firstPage.hasMore, true);
    const secondPage = await (await fetch(`${baseUrl}/api/games?q=Sample&page=2&limit=60`)).json();
    assert.equal(secondPage.items.length, 60);
    assert.equal(secondPage.hasMore, false);
    assert.ok(Array.isArray(await (await fetch(`${baseUrl}/api/games`)).json()), "legacy catalog API stays an array");

    const favoriteUrl = `${baseUrl}/api/favorites/demo-game`;
    const sameOriginHeaders = { Origin: baseUrl, "Content-Type": "application/json" };
    assert.equal((await fetch(favoriteUrl, { method: "POST", headers: sameOriginHeaders, body: "{}" })).status, 200);
    let favorites = await (await fetch(`${baseUrl}/api/favorites`)).json();
    assert.deepEqual(favorites.slugs, ["demo-game"]);
    assert.equal(favorites.items[0].title, "Demo Game");

    const crossOriginResponse = await fetch(favoriteUrl, {
      method: "DELETE",
      headers: { Origin: "https://attacker.invalid" },
    });
    assert.equal(crossOriginResponse.status, 403);
    assert.equal((await fetch(favoriteUrl, { method: "DELETE" })).status, 403, "writes without an Origin header are rejected");

    const downloadResponse = await fetch(`${baseUrl}/api/games/demo-game/download`);
    assert.equal(downloadResponse.status, 200);
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), Buffer.from("FWS\x09\x08\x07\x06", "binary"));
    assert.equal((await fetch(`${baseUrl}/api/games/bad-entry/download`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/favorites`)).status, 200);

    assert.equal((await fetch(favoriteUrl, { method: "DELETE", headers: sameOriginHeaders })).status, 200);
    assert.deepEqual((await (await fetch(`${baseUrl}/api/favorites`)).json()).slugs, []);
    assert.equal((await fetch(favoriteUrl, { method: "POST", headers: sameOriginHeaders, body: "{}" })).status, 200);

    await stopServer(child);
    child = launchServer(port, dataDir, gamesDir, ruffleDir);
    await waitForServer(baseUrl, child);
    favorites = await (await fetch(`${baseUrl}/api/favorites`)).json();
    assert.deepEqual(favorites.slugs, ["demo-game"], "favorites survive a service restart");
  } finally {
    await stopServer(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("profile creation, save writes, and profile deletion require same-origin requests", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flashback-origin-"));
  const dataDir = path.join(temporaryRoot, "state");
  const gamesDir = path.join(temporaryRoot, "games");
  const ruffleDir = path.join(temporaryRoot, "ruffle-missing");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(gamesDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "catalog.json"), JSON.stringify([
      { slug: "demo-game", title: "Demo Game", file: "demo-game.swf", tags: [] },
    ]));
    child = launchServer(port, dataDir, gamesDir, ruffleDir);
    await waitForServer(baseUrl, child);
    const cookie = await configureAdmin(baseUrl);

    const createProfileUrl = `${baseUrl}/api/profiles`;
    assert.equal((await fetch(createProfileUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Player One" }),
    })).status, 403, "profile creation without Origin is rejected");
    assert.equal((await fetch(createProfileUrl, {
      method: "POST",
      headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Player One" }),
    })).status, 403, "cross-origin profile creation is rejected");

    const createResponse = await fetch(createProfileUrl, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Player One" }),
    });
    assert.equal(createResponse.status, 201);
    const profile = await createResponse.json();
    const saveUrl = `${baseUrl}/api/profiles/${profile.id}/saves/demo-game`;
    const saveBody = JSON.stringify({ data: { score: "123" } });
    assert.equal((await fetch(saveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: saveBody,
    })).status, 403, "save writes without Origin are rejected");
    assert.equal((await fetch(saveUrl, {
      method: "POST",
      headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
      body: saveBody,
    })).status, 403, "cross-origin save writes are rejected");
    assert.equal((await fetch(saveUrl, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: saveBody,
    })).status, 200);
    assert.deepEqual(await (await fetch(saveUrl)).json(), { data: { score: "123" } });

    const deleteProfileUrl = `${baseUrl}/api/admin/profiles/${profile.id}`;
    assert.equal((await fetch(deleteProfileUrl, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status, 403, "profile deletion without Origin is rejected");
    assert.equal((await fetch(deleteProfileUrl, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://attacker.invalid" },
    })).status, 403, "cross-origin profile deletion is rejected");
    assert.equal((await fetch(deleteProfileUrl, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: baseUrl },
    })).status, 200, "same-origin admin deletion succeeds");
    assert.deepEqual(await (await fetch(`${baseUrl}/api/profiles`)).json(), []);
  } finally {
    await stopServer(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("game deletion quarantines files and rolls back metadata when a move fails", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flashback-quarantine-"));
  const dataDir = path.join(temporaryRoot, "state");
  const gamesDir = path.join(temporaryRoot, "games");
  const ruffleDir = path.join(temporaryRoot, "ruffle-missing");
  const coversDir = path.join(dataDir, "covers");
  const assetsDir = path.join(dataDir, "game-assets", "demo-game");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;

  try {
    fs.mkdirSync(gamesDir, { recursive: true });
    fs.mkdirSync(coversDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(gamesDir, "demo-game.swf"), Buffer.from("FWS\x09\x08\x07\x06", "binary"));
    fs.writeFileSync(path.join(coversDir, "demo-game.png"), Buffer.from("cover"));
    fs.writeFileSync(path.join(assetsDir, "config.xml"), "<config />");
    fs.writeFileSync(path.join(dataDir, "catalog.json"), JSON.stringify([
      { slug: "demo-game", title: "Demo Game", description: "", file: "demo-game.swf", tags: [] },
    ]));
    fs.writeFileSync(path.join(dataDir, "favorites.json"), JSON.stringify(["demo-game"]));
    fs.writeFileSync(path.join(dataDir, "collections.json"), JSON.stringify([
      { slug: "arcade", name: "Arcade", description: "", games: ["demo-game"] },
    ]));

    child = launchServer(port, dataDir, gamesDir, ruffleDir);
    await waitForServer(baseUrl, child);
    const cookie = await configureAdmin(baseUrl);
    const deleteUrl = `${baseUrl}/api/admin/games/demo-game`;
    const headers = { Cookie: cookie };

    // A file where the cover quarantine directory should be forces an error
    // after the SWF has already moved. The route must restore both the file
    // and the JSON references.
    fs.writeFileSync(path.join(coversDir, ".flashback-quarantine"), "block quarantine directory");
    const failedDelete = await fetch(deleteUrl, { method: "DELETE", headers });
    assert.equal(failedDelete.status, 500);
    assert.deepEqual(await failedDelete.json(), { error: "game_delete_failed", rollbackComplete: true });
    assert.equal(fs.existsSync(path.join(gamesDir, "demo-game.swf")), true);
    assert.equal(fs.existsSync(path.join(coversDir, "demo-game.png")), true);
    assert.equal(fs.existsSync(path.join(assetsDir, "config.xml")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "catalog.json"), "utf-8")).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "favorites.json"), "utf-8")), ["demo-game"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "collections.json"), "utf-8"))[0].games, ["demo-game"]);

    fs.unlinkSync(path.join(coversDir, ".flashback-quarantine"));
    const successfulDelete = await fetch(deleteUrl, { method: "DELETE", headers });
    assert.equal(successfulDelete.status, 200);
    const result = await successfulDelete.json();
    assert.ok(result.quarantineId);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "catalog.json"), "utf-8")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "favorites.json"), "utf-8")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "collections.json"), "utf-8"))[0].games, []);
    assert.equal(fs.existsSync(path.join(gamesDir, "demo-game.swf")), false);
    assert.equal(fs.existsSync(path.join(coversDir, "demo-game.png")), false);
    assert.equal(fs.existsSync(assetsDir), false);

    const manifestPath = path.join(dataDir, "quarantine", "deleted-games", `${result.quarantineId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.game.slug, "demo-game");
    assert.equal(manifest.wasFavorite, true);
    assert.deepEqual(manifest.collectionSlugs, ["arcade"]);
    assert.equal(manifest.files.length, 3);
    for (const move of manifest.files) assert.equal(fs.existsSync(move.quarantined), true);
  } finally {
    await stopServer(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("multipart uploads enforce configured per-request memory and file-count limits", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flashback-upload-limits-"));
  const dataDir = path.join(temporaryRoot, "state");
  const gamesDir = path.join(temporaryRoot, "games");
  const ruffleDir = path.join(temporaryRoot, "ruffle-missing");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(gamesDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "catalog.json"), JSON.stringify([
      { slug: "demo-game", title: "Demo Game", file: "demo-game.swf", tags: [] },
    ]));
    child = launchServer(port, dataDir, gamesDir, ruffleDir, {
      MAX_MULTIPART_TOTAL_MB: "1",
      MAX_UPLOAD_MB: "1",
      MAX_SIDECAR_FILES: "2",
      MAX_SIDECAR_FILE_MB: "1",
    });
    await waitForServer(baseUrl, child);
    const cookie = await configureAdmin(baseUrl);
    const oversized = new Blob([Buffer.alloc(460 * 1024, 1)], { type: "application/octet-stream" });

    const gameForm = new FormData();
    gameForm.append("swf", oversized, "large.swf");
    gameForm.append("cover", oversized, "large.png");
    const gameResponse = await fetch(`${baseUrl}/api/admin/games`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: gameForm,
    });
    assert.equal(gameResponse.status, 413, "game uploads cannot buffer two files beyond the configured request budget");

    const sidecarForm = new FormData();
    sidecarForm.append("files", oversized, "first.xml");
    sidecarForm.append("files", oversized, "second.xml");
    const sidecarResponse = await fetch(`${baseUrl}/api/admin/games/demo-game/assets`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: sidecarForm,
    });
    assert.equal(sidecarResponse.status, 413, "sidecar files are bounded by their aggregate memory budget");

    const tooManySidecars = new FormData();
    tooManySidecars.append("files", new Blob(["a"]), "one.xml");
    tooManySidecars.append("files", new Blob(["b"]), "two.xml");
    tooManySidecars.append("files", new Blob(["c"]), "three.xml");
    const countResponse = await fetch(`${baseUrl}/api/admin/games/demo-game/assets`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: tooManySidecars,
    });
    assert.equal(countResponse.status, 400, "sidecar count obeys the configured limit");
  } finally {
    await stopServer(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("extra-asset routes reject traversal slugs and filenames", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flashback-asset-paths-"));
  const dataDir = path.join(temporaryRoot, "state");
  const gamesDir = path.join(temporaryRoot, "games");
  const outsideDir = path.join(temporaryRoot, "outside");
  const ruffleDir = path.join(temporaryRoot, "ruffle-missing");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secretPath = path.join(outsideDir, "secret.txt");
  let child;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(gamesDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(secretPath, "must remain outside the game library");
    fs.writeFileSync(path.join(dataDir, "catalog.json"), JSON.stringify([
      { slug: "demo-game", title: "Demo Game", file: "demo-game.swf", tags: [] },
    ]));

    child = launchServer(port, dataDir, gamesDir, ruffleDir);
    await waitForServer(baseUrl, child);
    const cookie = await configureAdmin(baseUrl);
    const traversalSlug = "..%2F..%2Foutside";
    const traversalDelete = await fetch(
      `${baseUrl}/api/admin/games/${traversalSlug}/assets/secret.txt`,
      { method: "DELETE", headers: { Cookie: cookie } }
    );
    assert.equal(traversalDelete.status, 400);
    assert.equal(fs.readFileSync(secretPath, "utf-8"), "must remain outside the game library");

    const traversalList = await fetch(`${baseUrl}/api/admin/games/${traversalSlug}/assets`, {
      headers: { Cookie: cookie },
    });
    assert.equal(traversalList.status, 400);

    const invalidFilename = await fetch(`${baseUrl}/api/admin/games/demo-game/assets/..%2Fsecret.txt`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(invalidFilename.status, 400);
    assert.equal(fs.readFileSync(secretPath, "utf-8"), "must remain outside the game library");
  } finally {
    await stopServer(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
