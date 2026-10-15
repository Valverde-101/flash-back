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

function launchServer(port, dataDir, gamesDir, ruffleDir) {
  return spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      FLASHBACK_DATA_DIR: dataDir,
      FLASHBACK_GAMES_DIR: gamesDir,
      FLASHBACK_RUFFLE_DIR: ruffleDir,
    },
    stdio: "ignore",
  });
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
