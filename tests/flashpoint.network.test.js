const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { _createSafeFetcher, _networkLimits } = require("../server/lib/flashpoint");

const PUBLIC_IPV4 = "93.184.216.34";

function makeResponse(statusCode, headers = {}, body = "") {
  const response = Readable.from(body ? [Buffer.from(body)] : []);
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}

function makeClient(route) {
  const calls = [];
  return {
    calls,
    get(inputUrl, options, callback) {
      const url = new URL(inputUrl);
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = (error) => {
        request.destroyed = true;
        if (error) process.nextTick(() => request.emit("error", error));
      };
      calls.push({ url: url.href, options });
      process.nextTick(() => {
        const result = route(url);
        callback(makeResponse(result.statusCode || 200, result.headers, result.body));
      });
      return request;
    },
  };
}

function makeFetcher({ route = () => ({ body: "ok" }), lookup = async () => [{ address: PUBLIC_IPV4, family: 4 }] } = {}) {
  const httpClient = makeClient(route);
  const httpsClient = makeClient(route);
  const fetch = _createSafeFetcher({ lookup, httpClient, httpsClient });
  return { fetch, httpClient, httpsClient };
}

test("accepts a public host and pins the validated DNS result for the socket", async () => {
  const { fetch, httpsClient } = makeFetcher();
  const result = await fetch("https://assets.example.net/game.swf", 32);

  assert.equal(result.toString(), "ok");
  const { options } = httpsClient.calls[0];
  assert.equal(options.agent, false);
  const pinned = await new Promise((resolve, reject) => {
    options.lookup("assets.example.net", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(pinned, { address: PUBLIC_IPV4, family: 4 });
});

test("accepts globally routable IPv6 literals and rejects IPv6 link-local/transition ranges", async () => {
  const { fetch, httpsClient } = makeFetcher();
  const result = await fetch("https://[2606:4700:4700::1111]/game.swf", 32);
  assert.equal(result.toString(), "ok");
  assert.equal(httpsClient.calls.length, 1);

  for (const url of ["https://[fe80::1]/", "https://[2002::1]/"]) {
    await assert.rejects(fetch(url, 32), { code: "ERR_BLOCKED_ADDRESS" });
  }
});

test("rejects non-HTTP protocols, local literals, and reserved local names before connecting", async () => {
  const { fetch, httpClient, httpsClient } = makeFetcher();
  for (const url of [
    "file:///etc/passwd",
    "ftp://assets.example/game.swf",
    "http://127.0.0.1/private",
    "http://[::1]/private",
    "http://240.0.0.1/reserved",
    "https://metadata.internal/latest",
    "https://localhost/",
  ]) {
    await assert.rejects(fetch(url, 32), (error) =>
      ["ERR_BLOCKED_PROTOCOL", "ERR_BLOCKED_ADDRESS"].includes(error.code)
    );
  }
  assert.equal(httpClient.calls.length + httpsClient.calls.length, 0);
});

test("rejects private or mixed public/private DNS answers", async () => {
  for (const records of [
    [{ address: "10.1.2.3", family: 4 }],
    [
      { address: PUBLIC_IPV4, family: 4 },
      { address: "169.254.10.20", family: 4 },
    ],
    [{ address: "2001:db8::1", family: 6 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
  ]) {
    const { fetch, httpClient, httpsClient } = makeFetcher({ lookup: async () => records });
    await assert.rejects(fetch("https://assets.example.net/game.swf", 32), { code: "ERR_BLOCKED_ADDRESS" });
    assert.equal(httpClient.calls.length + httpsClient.calls.length, 0);
  }
});

test("revalidates every redirect destination and refuses redirects to local addresses", async () => {
  const { fetch, httpsClient } = makeFetcher({
    route: () => ({ statusCode: 302, headers: { location: "http://192.168.1.1/admin" } }),
  });
  await assert.rejects(fetch("https://assets.example.net/game.swf", 32), { code: "ERR_BLOCKED_ADDRESS" });
  assert.equal(httpsClient.calls.length, 1);
});

test("caps redirect chains", async () => {
  const { fetch, httpsClient } = makeFetcher({
    route: (url) => ({
      statusCode: 302,
      headers: { location: `/hop/${Number(url.pathname.split("/").pop() || 0) + 1}` },
    }),
  });
  await assert.rejects(fetch("https://assets.example.net/hop/0", 32), { code: "ERR_TOO_MANY_REDIRECTS" });
  assert.equal(httpsClient.calls.length, 6); // Initial request plus five followed redirects.
});

test("enforces the byte cap while streaming even without Content-Length", async () => {
  const { fetch } = makeFetcher({ route: () => ({ body: "0123456789" }) });
  await assert.rejects(fetch("https://assets.example.net/game.swf", 5), { code: "ERR_RESPONSE_TOO_LARGE" });
});

test("uses separate bounded budgets for HTML, SWFs, sidecars, and logos", () => {
  assert.deepEqual(_networkLimits, {
    html: 2 * 1024 * 1024,
    swf: 200 * 1024 * 1024,
    sidecar: 8 * 1024 * 1024,
    sidecarTotal: 24 * 1024 * 1024,
    logo: 4 * 1024 * 1024,
  });
  assert.equal(new Set([_networkLimits.html, _networkLimits.swf, _networkLimits.sidecar, _networkLimits.logo]).size, 4);
});
