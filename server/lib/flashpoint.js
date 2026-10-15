// Lets the admin panel search Flashpoint's public database and import a game
// from its original host when possible, falling back to the Flashpoint
// database's GameZIP endpoint when the original host has disappeared. The
// database API is also used by FlashpointProject's own public database site.
//
// "Respect" scenario: every request identifies itself with a real User-Agent
// and a timeout, requests to flashpointarchive.org and to individual
// candidate hosts are always sequential (never parallel/burst), and a
// server-side cooldown throttles how often an admin (or a bug in the UI)
// can trigger a search/import in the first place. This is a manually
// triggered, one-game-at-a-time tool — not a bulk scraper.
const https = require("https");
const http = require("http");
const dns = require("dns");
const net = require("net");
const zlib = require("zlib");
const { isValidSwf } = require("./validateSwf");

const USER_AGENT = "FlashBack/1.0 (+https://github.com/Valverde-101/flash-back) game importer";
const FLASHPOINT_API_BASE = "https://db-api.unstable.life";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_SIDECAR_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Object.freeze({
  html: 2 * 1024 * 1024,
  api: 5 * 1024 * 1024,
  swf: 200 * 1024 * 1024,
  gameZip: 256 * 1024 * 1024,
  sidecar: 8 * 1024 * 1024,
  sidecarTotal: 24 * 1024 * 1024,
  logo: 4 * 1024 * 1024,
});
const BETWEEN_REQUESTS_DELAY_MS = 500;

const SEARCH_COOLDOWN_MS = 2000;
const IMPORT_COOLDOWN_MS = 3000;
let lastSearchAt = 0;
let lastImportAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkCooldown(lastAt, cooldownMs) {
  const elapsed = Date.now() - lastAt;
  return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
}

const IPV4_BLOCKED_RANGES = [
  ["0.0.0.0", 8],       // This network
  ["10.0.0.0", 8],      // Private use
  ["100.64.0.0", 10],   // Shared address space / carrier NAT
  ["127.0.0.0", 8],     // Loopback
  ["169.254.0.0", 16],  // Link local
  ["172.16.0.0", 12],   // Private use
  ["192.0.0.0", 24],    // IETF protocol assignments (conservatively blocked)
  ["192.0.2.0", 24],    // Documentation
  ["192.31.196.0", 24], // AS112 special-purpose anycast
  ["192.52.193.0", 24], // Special-purpose anycast
  ["192.88.99.0", 24],  // Deprecated relay anycast
  ["192.168.0.0", 16],  // Private use
  ["192.175.48.0", 24], // AS112 special-purpose anycast
  ["198.18.0.0", 15],   // Benchmarking
  ["198.51.100.0", 24], // Documentation
  ["203.0.113.0", 24],  // Documentation
  ["224.0.0.0", 4],     // Multicast
  ["240.0.0.0", 4],     // Reserved / broadcast
].map(([address, prefix]) => [ipv4ToBigInt(address), prefix]);

function ipv4ToBigInt(address) {
  return address.split(".").reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function ipv6ToBigInt(address) {
  if (address.includes("%")) return null; // Scoped addresses are local-interface references.

  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  if (normalized.includes(".")) {
    const ipv4Part = normalized.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const ipv4 = ipv4ToBigInt(ipv4Part);
    normalized = `${normalized.slice(0, lastColon + 1)}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function inCidr(value, network, prefix, bitCount) {
  const shift = BigInt(bitCount - prefix);
  return value >> shift === network >> shift;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    return !IPV4_BLOCKED_RANGES.some(([network, prefix]) => inCidr(value, network, prefix, 32));
  }
  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Permit only IPv6 global-unicast space, then remove special-purpose,
  // documentation and transition prefixes that sit inside 2000::/3.
  const globalUnicast = inCidr(value, 0x20000000000000000000000000000000n, 3, 128);
  const specialRanges = [
    [0x20010000000000000000000000000000n, 23], // IETF special-purpose block
    [0x20010db8000000000000000000000000n, 32], // Documentation
    [0x20020000000000000000000000000000n, 16], // 6to4 transition
    [0x3fff0000000000000000000000000000n, 20], // Documentation
  ];
  return globalUnicast && !specialRanges.some(([network, prefix]) => inCidr(value, network, prefix, 128));
}

function networkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSafeUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw networkError("ERR_INVALID_URL", "Invalid network URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw networkError("ERR_BLOCKED_PROTOCOL", "Only HTTP and HTTPS URLs are allowed.");
  }
  if (url.username || url.password || !url.hostname) {
    throw networkError("ERR_INVALID_URL", "URLs with credentials or no hostname are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid")
  ) {
    throw networkError("ERR_BLOCKED_ADDRESS", "Local or reserved hostnames are not allowed.");
  }
  return { url, hostname };
}

async function resolvePublicAddress(hostname, lookup) {
  const family = net.isIP(hostname);
  if (family) {
    if (!isPublicAddress(hostname)) {
      throw networkError("ERR_BLOCKED_ADDRESS", "The URL resolves to a non-public IP address.");
    }
    return { address: hostname, family };
  }

  let timer;
  let records;
  try {
    records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(networkError("ERR_DNS_TIMEOUT", "DNS lookup timed out.")), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw networkError("ERR_DNS_EMPTY", "DNS returned no addresses.");
  }
  if (records.some((record) => !record || !isPublicAddress(record.address))) {
    throw networkError("ERR_BLOCKED_ADDRESS", "DNS returned a non-public IP address.");
  }
  return { address: records[0].address, family: net.isIP(records[0].address) };
}

function createSafeFetcher({ lookup = dns.promises.lookup, httpClient = http, httpsClient = https } = {}) {
  async function fetch(urlInput, maxBytes, redirects = 0) {
    const { url, hostname } = parseSafeUrl(urlInput);
    const pinnedAddress = await resolvePublicAddress(hostname, lookup);
    const client = url.protocol === "https:" ? httpsClient : httpClient;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let request;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const pinnedLookup = (requestedHostname, options, callback) => {
        const normalized = String(requestedHostname).replace(/^\[|\]$/g, "").toLowerCase();
        if (normalized !== hostname) {
          return callback(networkError("ERR_DNS_REBIND", "The connection hostname changed after validation."));
        }
        if (options && options.family && options.family !== pinnedAddress.family) {
          return callback(networkError("ERR_DNS_FAMILY", "The pinned address family does not match the connection."));
        }
        if (options && options.all) return callback(null, [pinnedAddress]);
        callback(null, pinnedAddress.address, pinnedAddress.family);
      };

      const abort = (error) => {
        finish(reject, error);
        if (request && !request.destroyed) request.destroy(error);
      };

      try {
        request = client.get(
          url,
          {
            agent: false,
            headers: { "User-Agent": USER_AGENT },
            lookup: pinnedLookup,
            timeout: REQUEST_TIMEOUT_MS,
          },
          (response) => {
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
              // Redirect bodies are irrelevant; destroy them rather than
              // draining an attacker-controlled, potentially unbounded body.
              response.destroy();
              if (redirects >= MAX_REDIRECTS) {
                return finish(reject, networkError("ERR_TOO_MANY_REDIRECTS", "Too many HTTP redirects."));
              }
              let nextUrl;
              try {
                nextUrl = new URL(response.headers.location, url).href;
              } catch (error) {
                return finish(reject, networkError("ERR_INVALID_REDIRECT", "Invalid redirect URL."));
              }
              return finish(resolve, fetch(nextUrl, maxBytes, redirects + 1));
            }
            if (status !== 200) {
              response.destroy();
              return finish(reject, new Error(`GET ${url.href} -> ${status}`));
            }

            const contentLength = Number(response.headers["content-length"]);
            if (Number.isFinite(contentLength) && contentLength > maxBytes) {
              return abort(networkError("ERR_RESPONSE_TOO_LARGE", `Response exceeds the ${maxBytes}-byte limit.`));
            }

            const chunks = [];
            let received = 0;
            response.on("data", (chunk) => {
              received += chunk.length;
              if (received > maxBytes) {
                return abort(networkError("ERR_RESPONSE_TOO_LARGE", `Response exceeds the ${maxBytes}-byte limit.`));
              }
              chunks.push(chunk);
            });
            response.on("end", () => finish(resolve, Buffer.concat(chunks, received)));
            response.on("error", (error) => finish(reject, error));
            response.on("aborted", () => finish(reject, networkError("ERR_RESPONSE_ABORTED", "The remote server aborted the response.")));
          }
        );
      } catch (error) {
        return finish(reject, error);
      }

      timer = setTimeout(() => abort(networkError("ERR_REQUEST_TIMEOUT", `GET ${url.href} timed out.`)), REQUEST_TIMEOUT_MS);
      request.on("timeout", () => abort(networkError("ERR_REQUEST_TIMEOUT", `GET ${url.href} timed out.`)));
      request.on("error", (error) => finish(reject, error));
    });
  }

  return fetch;
}

const safeFetch = createSafeFetcher();

function fetchText(url) {
  return safeFetch(url, MAX_RESPONSE_BYTES.html).then((buffer) => buffer.toString("utf8"));
}

function fetchBuffer(url, maxBytes = MAX_RESPONSE_BYTES.swf) {
  return safeFetch(url, maxBytes);
}

function isFlashpointId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function flashpointApiUrl(endpoint, params) {
  const url = new URL(endpoint, FLASHPOINT_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.href;
}

async function fetchJson(url) {
  const buffer = await safeFetch(url, MAX_RESPONSE_BYTES.api);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw networkError("ERR_INVALID_JSON", "Flashpoint returned invalid JSON.");
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Returns the number of ms the caller should wait before this would be
// allowed, or 0 if it's fine to proceed right now (and marks it as used).
function trySearchSlot() {
  const wait = checkCooldown(lastSearchAt, SEARCH_COOLDOWN_MS);
  if (wait === 0) lastSearchAt = Date.now();
  return wait;
}

function tryImportSlot() {
  const wait = checkCooldown(lastImportAt, IMPORT_COOLDOWN_MS);
  if (wait === 0) lastImportAt = Date.now();
  return wait;
}

// Flashpoint's own image CDN, keyed off the entry's UUID — no search or
// detail-page scraping needed to find it, the URL is always this shape.
function logoUrl(id) {
  return `https://infinity.unstable.life/images/Logos/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.png?type=jpg`;
}

// Search the same public database API used by FlashpointProject's own
// flashpoint-database site. Keep the old HTML page as a graceful search
// fallback if that API is temporarily unavailable.
async function search(query) {
  try {
    const data = await fetchJson(flashpointApiUrl("/search", {
      smartSearch: query,
      platform: "Flash",
      fields: "id,title,platform,launchCommand,zipped",
      limit: 100,
    }));
    if (!Array.isArray(data)) throw networkError("ERR_INVALID_API_RESPONSE", "Flashpoint returned an invalid search result.");
    return data
      .filter((entry) => isFlashpointId(entry.id) && entry.platform === "Flash" && typeof entry.title === "string")
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        type: "Flash",
        logo: logoUrl(entry.id),
      }));
  } catch (error) {
    return searchLegacy(query);
  }
}

async function searchLegacy(query) {
  const html = await fetchText(`https://flashpointarchive.org/search?query=${encodeURIComponent(query)}`);

  const results = [];
  const blockRe = /<div class="fp-search-result">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let block;
  while ((block = blockRe.exec(html))) {
    const section = block[1];
    const titleMatch = section.match(/<a class="fp-search-result-title" href="\/view\?id=([0-9a-f-]+)">([^<]*)/);
    const infoMatch = section.match(/<div class="fp-search-result-info">([^<-]*)/);
    if (!titleMatch) continue;

    const type = infoMatch ? infoMatch[1].trim() : "";
    if (!type.startsWith("Flash")) continue;

    const id = titleMatch[1];
    if (!isFlashpointId(id)) continue;
    results.push({
      id,
      title: decodeEntities(titleMatch[2]),
      type,
      logo: logoUrl(id),
    });
  }
  return results;
}

function extractRow(html, label) {
  const re = new RegExp(`<th>${label}:</th>\\s*<td>([\\s\\S]*?)</td>`);
  const match = html.match(re);
  return match ? decodeEntities(match[1].replace(/<[^>]+>/g, "")) : "";
}

function extractLaunchCommands(html) {
  const commands = [];
  const re = /<th>Launch Command:<\/th>\s*<td>([^<]*)<\/td>/g;
  let match;
  while ((match = re.exec(html))) {
    const url = decodeEntities(match[1]);
    if (url && !/^https?:\/\/localflash\//i.test(url) && !commands.includes(url)) {
      commands.push(url);
    }
  }
  return commands;
}

async function getEntry(id) {
  if (!isFlashpointId(id)) throw networkError("ERR_INVALID_FLASHPOINT_ID", "Invalid Flashpoint entry ID.");

  let apiEntry = null;
  try {
    const data = await fetchJson(flashpointApiUrl("/search", {
      id,
      fields: "id,title,platform,originalDescription,launchCommand,zipped",
      limit: 1,
    }));
    if (Array.isArray(data)) apiEntry = data.find((entry) => entry.id === id) || null;
  } catch (error) {
    // The public HTML detail page remains a usable metadata fallback.
  }

  let html = "";
  try {
    html = await fetchText(`https://flashpointarchive.org/view?id=${encodeURIComponent(id)}`);
  } catch (error) {
    if (!apiEntry) throw error;
  }

  const titleMatch = html.match(/<div class="fp-content-header">([^<]*)<\/div>/);
  const apiLaunchCommand = apiEntry && typeof apiEntry.launchCommand === "string" ? apiEntry.launchCommand : "";
  return {
    id,
    title: (apiEntry && apiEntry.title) || (titleMatch ? decodeEntities(titleMatch[1]) : ""),
    description: (apiEntry && apiEntry.originalDescription) || extractRow(html, "Original Description"),
    platform: (apiEntry && apiEntry.platform) || extractRow(html, "Platform"),
    launchCommands: extractLaunchCommands(html),
    archiveLaunchCommand: apiLaunchCommand,
    archiveAvailable: apiEntry ? apiEntry.zipped === true : null,
  };
}

// Tries each candidate URL in turn (sequentially, with a delay between
// attempts out of courtesy to whatever server is still hosting each one),
// and returns the buffer + source URL of the first one that's a genuine
// .swf file. Returns null when every original host is down; the caller can
// then use Flashpoint's GameZIP fallback.
async function fetchFirstValidSwf(candidateUrls) {
  for (let i = 0; i < candidateUrls.length; i++) {
    if (i > 0) await sleep(BETWEEN_REQUESTS_DELAY_MS);
    try {
      const buffer = await fetchBuffer(candidateUrls[i], MAX_RESPONSE_BYTES.swf);
      if (isValidSwf(buffer)) {
        return { buffer, sourceUrl: candidateUrls[i] };
      }
    } catch (err) {
      // Dead link, timeout, non-200, whatever — just move on to the next candidate.
    }
  }
  return null;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_MAX_ENTRIES = 20000;
const ZIP_MAX_SIDECAR_FILES = 20;
const ZIP_ALLOWED_SIDECAR_EXTENSIONS = new Set(["xml", "json", "csv", "txt", "dat", "bin", "mp3", "wav", "ogg", "png", "jpg", "jpeg", "gif", "webp"]);
const ZIP_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function zipError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function zipCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = ZIP_CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeZipPath(name) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
  const parts = name.split("/");
  return parts.every((part, index) => part !== ".." && (part !== "." || index === parts.length - 1));
}

function parseGameZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw zipError("ERR_INVALID_GAMEZIP", "Flashpoint returned an invalid GameZIP archive.");
  }

  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw zipError("ERR_INVALID_GAMEZIP", "Flashpoint returned an invalid GameZIP archive.");

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
    entryCount > ZIP_MAX_ENTRIES || centralOffset + centralSize > eocdOffset
  ) {
    throw zipError("ERR_INVALID_GAMEZIP", "Flashpoint returned an unsupported GameZIP archive.");
  }

  const entries = [];
  let offset = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > centralEnd || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw zipError("ERR_INVALID_GAMEZIP", "Flashpoint returned a damaged GameZIP archive.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (
      nextOffset > centralEnd || startDisk !== 0 || compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff || localOffset === 0xffffffff
    ) {
      throw zipError("ERR_INVALID_GAMEZIP", "Flashpoint returned an unsupported GameZIP entry.");
    }

    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString(flags & 0x0800 ? "utf8" : "latin1");
    const isDirectory = name.endsWith("/");
    if (
      !isDirectory && safeZipPath(name) && !(flags & 0x0001) &&
      (method === 0 || method === 8)
    ) {
      entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localOffset });
    }
    offset = nextOffset;
  }

  if (offset !== centralEnd) throw zipError("ERR_INVALID_GAMEZIP", "Flashpoint returned a malformed GameZIP directory.");
  return entries;
}

function extractGameZipEntry(buffer, entry, maxOutputBytes) {
  if (entry.uncompressedSize > maxOutputBytes || entry.localOffset + 30 > buffer.length) return null;
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE) return null;
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  if ((flags & 0x0001) || method !== entry.method) return null;
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length || dataEnd < dataStart) return null;

  let data;
  try {
    const compressed = buffer.subarray(dataStart, dataEnd);
    data = entry.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    return null;
  }
  if (data.length !== entry.uncompressedSize || zipCrc32(data) !== entry.crc32) return null;
  return data;
}

function launchPathFromCommand(command) {
  if (!command) return "";
  try {
    return decodeURIComponent(new URL(command).pathname).replace(/^\/+/, "").toLowerCase();
  } catch (error) {
    return "";
  }
}

function selectGameZipSwf(entries, launchCommand) {
  let candidates = entries.filter((entry) => entry.name.toLowerCase().endsWith(".swf"));
  if (!candidates.length) throw zipError("ERR_GAMEZIP_SWF_NOT_FOUND", "The Flashpoint backup contains no SWF file.");
  const launchPath = launchPathFromCommand(launchCommand);
  if (launchPath) {
    const exact = candidates.filter((entry) => {
      const relative = entry.name.replace(/^content\//i, "").toLowerCase();
      return relative === launchPath || relative.endsWith(`/${launchPath}`);
    });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw zipError("ERR_GAMEZIP_SWF_AMBIGUOUS", "The Flashpoint backup contains multiple matching SWF files.");

    const basename = launchPath.slice(launchPath.lastIndexOf("/") + 1);
    const basenameMatches = candidates.filter((entry) => entry.name.slice(entry.name.lastIndexOf("/") + 1).toLowerCase() === basename);
    if (basenameMatches.length === 1) return basenameMatches[0];
    if (basenameMatches.length > 1) throw zipError("ERR_GAMEZIP_SWF_AMBIGUOUS", "The Flashpoint backup contains multiple matching SWF files.");
  }
  if (candidates.length === 1) return candidates[0];
  throw zipError("ERR_GAMEZIP_SWF_AMBIGUOUS", "The Flashpoint backup contains several SWF files and its launch file could not be identified.");
}

function extractGameZipSwf(buffer, launchCommand) {
  const entries = parseGameZipEntries(buffer);
  const mainEntry = selectGameZipSwf(entries, launchCommand);
  const swf = extractGameZipEntry(buffer, mainEntry, MAX_RESPONSE_BYTES.swf);
  if (!isValidSwf(swf)) throw zipError("ERR_INVALID_GAMEZIP_SWF", "The selected Flashpoint backup file is not a valid SWF.");

  const parent = mainEntry.name.slice(0, mainEntry.name.lastIndexOf("/"));
  const sidecarAssets = [];
  let sidecarTotal = 0;
  for (const entry of entries) {
    if (sidecarAssets.length >= ZIP_MAX_SIDECAR_FILES || entry.name === mainEntry.name) continue;
    if (entry.name.slice(0, entry.name.lastIndexOf("/")) !== parent) continue;
    const filename = entry.name.slice(entry.name.lastIndexOf("/") + 1);
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(filename) || filename === "." || filename === "..") continue;
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
    if (!ZIP_ALLOWED_SIDECAR_EXTENSIONS.has(extension)) continue;
    if (entry.uncompressedSize > MAX_RESPONSE_BYTES.sidecar || sidecarTotal + entry.uncompressedSize > MAX_RESPONSE_BYTES.sidecarTotal) continue;
    const data = extractGameZipEntry(buffer, entry, MAX_RESPONSE_BYTES.sidecar);
    if (!data || data.length === 0) continue;
    sidecarTotal += data.length;
    sidecarAssets.push({ filename, buffer: data });
    if (sidecarTotal >= MAX_RESPONSE_BYTES.sidecarTotal) break;
  }

  return { buffer: swf, sidecarAssets };
}

async function fetchGameZipSwf(id, launchCommand) {
  if (!isFlashpointId(id)) throw networkError("ERR_INVALID_FLASHPOINT_ID", "Invalid Flashpoint entry ID.");
  let archive;
  try {
    archive = await fetchBuffer(flashpointApiUrl("/get", { id }), MAX_RESPONSE_BYTES.gameZip);
  } catch (error) {
    return null;
  }
  const extracted = extractGameZipSwf(archive, launchCommand);
  return { ...extracted, sourceUrl: "flashpoint-gamezip", fromGameZip: true };
}

// Some Flash games load a sidecar file (XML config, level list, ...) next
// to their .swf at runtime, via a plain string URL baked into the movie's
// own bytecode/data — found this concretely on Zuma's Revenge! by
// decompressing its .swf and grepping the result for ".xml". This automates
// exactly that manual process: decompress (if the movie is zlib-compressed,
// signature "CWS" — LZMA-compressed "ZWS" movies are skipped, uncommon for
// web-era content and not worth a dependency), scan for filename-shaped
// strings with a data-file extension, then try fetching each one from the
// same directory the working .swf came from. Anything that isn't a real
// 200 response, or looks like an HTML error/parking page instead of real
// data (some dead hosts soft-404 with a 200 status), is discarded — a
// missing sidecar file is never a reason to fail the import, same as a
// missing cover.
// Ordered by how likely a match is to be a real externally-fetched sidecar
// file rather than a false positive. XML/JSON/CSV/TXT are almost always
// real config/data files; .dat shows up constantly as internal SWF library
// symbol names (e.g. embedded clip linkage IDs) that just happen to match
// the "name.ext" pattern without ever being an HTTP request — confirmed on
// Zuma's Revenge!, whose decompressed .swf contains two dozen "levelNa.dat"
// library symbols alongside the two real files, "data.xml" and
// "levels.xml". Trying extensions in this order means the real ones get
// requested even when outnumbered by that kind of noise, without needing
// an unbounded number of requests to a third-party host.
const SIDECAR_EXTENSIONS_PRIORITY = ["xml", "json", "csv", "txt", "dat"];
const SIDECAR_FILENAME_RE = new RegExp(`[A-Za-z0-9_\\-]{2,40}\\.(?:${SIDECAR_EXTENSIONS_PRIORITY.join("|")})`, "g");
const MAX_SIDECAR_CANDIDATES = 10;

function findSidecarCandidates(swfBuffer) {
  const signature = swfBuffer.toString("ascii", 0, 3);
  let body = swfBuffer;

  if (signature === "CWS") {
    try {
      body = zlib.inflateSync(swfBuffer.subarray(8), { maxOutputLength: MAX_SIDECAR_SCAN_BYTES });
    } catch (err) {
      return [];
    }
  } else if (signature !== "FWS") {
    return []; // ZWS (LZMA) or not a recognizable SWF at all.
  }

  // Sidecar discovery is heuristic; scanning a bounded prefix avoids turning
  // one highly-compressed SWF into an unbounded inflate/string allocation.
  const text = body.subarray(0, MAX_SIDECAR_SCAN_BYTES).toString("latin1");
  const matches = text.match(SIDECAR_FILENAME_RE) || [];
  const unique = [...new Set(matches)];

  const extRank = (name) => SIDECAR_EXTENSIONS_PRIORITY.indexOf(name.slice(name.lastIndexOf(".") + 1));
  unique.sort((a, b) => extRank(a) - extRank(b));

  return unique.slice(0, MAX_SIDECAR_CANDIDATES);
}

function looksLikeErrorPage(buffer) {
  const head = buffer.subarray(0, 256).toString("latin1").trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function fetchSidecarAssets(swfBuffer, sourceUrl) {
  const candidates = findSidecarCandidates(swfBuffer);
  if (candidates.length === 0) return [];

  const baseUrl = sourceUrl.slice(0, sourceUrl.lastIndexOf("/") + 1);
  const found = [];
  let totalBytes = 0;

  for (let i = 0; i < candidates.length; i++) {
    const remainingBytes = MAX_RESPONSE_BYTES.sidecarTotal - totalBytes;
    if (remainingBytes <= 0) break;
    if (i > 0) await sleep(BETWEEN_REQUESTS_DELAY_MS);
    try {
      const buffer = await fetchBuffer(baseUrl + candidates[i], Math.min(MAX_RESPONSE_BYTES.sidecar, remainingBytes));
      totalBytes += buffer.length;
      if (buffer.length > 0 && !looksLikeErrorPage(buffer)) {
        found.push({ filename: candidates[i], buffer });
      }
      if (totalBytes >= MAX_RESPONSE_BYTES.sidecarTotal) break;
    } catch (err) {
      // Stop after a size-cap response: continuing would let a host send the
      // same over-limit body for every candidate and multiply network usage.
      if (err.code === "ERR_RESPONSE_TOO_LARGE") break;
      // Doesn't exist / dead link — just not a real sidecar file, skip it.
    }
  }

  return found;
}

// Best-effort fetch of the entry's logo/cover image from Flashpoint's own
// image CDN (not a third-party host, so this doesn't need the same
// candidate-list/fallback treatment as the .swf itself). Returns null on
// any failure — a missing cover is never a reason to fail the import.
async function fetchLogo(id) {
  try {
    return await fetchBuffer(logoUrl(id), MAX_RESPONSE_BYTES.logo);
  } catch (err) {
    return null;
  }
}

module.exports = {
  search,
  getEntry,
  fetchFirstValidSwf,
  fetchGameZipSwf,
  isFlashpointId,
  fetchLogo,
  fetchSidecarAssets,
  trySearchSlot,
  tryImportSlot,
  // Exported for focused network-policy tests; application callers should use
  // the higher-level search/import helpers above.
  _createSafeFetcher: createSafeFetcher,
  _networkLimits: MAX_RESPONSE_BYTES,
  _extractGameZipSwf: extractGameZipSwf,
  _parseGameZipEntries: parseGameZipEntries,
};
