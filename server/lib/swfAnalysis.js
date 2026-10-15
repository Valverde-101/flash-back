const crypto = require("crypto");
const zlib = require("zlib");
const { isValidSwf } = require("./validateSwf");

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const SIDECAR_RE = /[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}\.(?:xml|dat|txt|json|cfg|ini|csv|bin|pak|map|sol|data)/gi;
const SIDECAR_EXTENSIONS = ["xml", "dat", "json", "cfg", "ini", "csv", "bin", "pak", "map", "sol", "data", "txt"];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sidecarHints(buffer) {
  if (!isValidSwf(buffer)) return [];
  const signature = buffer.toString("ascii", 0, 3);
  let body = buffer;
  if (signature === "CWS") {
    try {
      body = zlib.inflateSync(buffer.subarray(8), { maxOutputLength: MAX_SCAN_BYTES });
    } catch (error) {
      return [];
    }
  } else if (signature !== "FWS") {
    // ZWS requires LZMA decoding; report no heuristic hints rather than
    // pretending the compressed payload was inspected.
    return [];
  }

  const text = body.subarray(0, MAX_SCAN_BYTES).toString("latin1");
  const names = [...new Set(text.match(SIDECAR_RE) || [])];
  const priority = (name) => SIDECAR_EXTENSIONS.indexOf(name.slice(name.lastIndexOf(".") + 1).toLowerCase());
  return names.sort((a, b) => priority(a) - priority(b)).slice(0, 40);
}

function measuredFileSize(buffer, signature) {
  if (signature === "FWS") return buffer.length;
  if (signature !== "CWS") return null;
  try {
    return zlib.inflateSync(buffer.subarray(8), { maxOutputLength: MAX_SCAN_BYTES }).length + 8;
  } catch (error) {
    return null;
  }
}

function inspectSwf(buffer, { sha = sha256(buffer), installedSidecars = [] } = {}) {
  const valid = isValidSwf(buffer);
  const signature = buffer.toString("ascii", 0, 3);
  const declaredSize = buffer.length >= 8 ? buffer.readUInt32LE(4) : null;
  const compression = ({ FWS: "none", CWS: "zlib", ZWS: "lzma" })[signature] || "unknown";
  const measuredSize = valid ? measuredFileSize(buffer, signature) : null;
  const hints = sidecarHints(buffer);
  const installed = new Set(installedSidecars.map((name) => name.toLowerCase()));
  return {
    valid,
    format: signature,
    version: valid ? buffer[3] : null,
    compression,
    actualBytes: buffer.length,
    declaredBytes: declaredSize,
    measuredBytes: measuredSize,
    declaredSizeMatches: measuredSize === null ? null : declaredSize === measuredSize,
    sha256: sha,
    sidecarHints: hints,
    missingSidecarHints: hints.filter((name) => !installed.has(name.toLowerCase())),
    installedSidecars,
  };
}

module.exports = { sha256, sidecarHints, inspectSwf };
