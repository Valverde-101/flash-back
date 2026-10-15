const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const BLOCK_SIZE = 512;

function writeOctal(header, offset, length, value) {
  const text = Math.floor(value).toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error("Backup archive entry is too large");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(name, size, mtimeSeconds = Math.floor(Date.now() / 1000)) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  const posixName = name.replace(/\\/g, "/");
  let headerName = posixName;
  let prefix = "";
  if (Buffer.byteLength(headerName, "utf8") > 100) {
    const splitAt = posixName.lastIndexOf("/");
    if (splitAt < 1) throw new Error(`Backup path is too long: ${name}`);
    prefix = posixName.slice(0, splitAt);
    headerName = posixName.slice(splitAt + 1);
    if (Buffer.byteLength(headerName, "utf8") > 100 || Buffer.byteLength(prefix, "utf8") > 155) {
      throw new Error(`Backup path is too long: ${name}`);
    }
  }
  const nameBytes = Buffer.from(headerName, "utf8");
  nameBytes.copy(header, 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSeconds);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createTarGzipStream(entries, manifest) {
  async function* generateTar() {
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    yield tarHeader("manifest.json", manifestBuffer.length);
    yield manifestBuffer;
    if (manifestBuffer.length % BLOCK_SIZE) yield Buffer.alloc(BLOCK_SIZE - (manifestBuffer.length % BLOCK_SIZE));

    for (const entry of entries) {
      const stat = entry.sourcePath ? fs.statSync(entry.sourcePath) : null;
      if (stat && !stat.isFile()) continue;
      const size = stat ? stat.size : entry.buffer.length;
      yield tarHeader(entry.archivePath, size, stat ? Math.floor(stat.mtimeMs / 1000) : undefined);
      if (entry.buffer) {
        yield entry.buffer;
      } else {
        let bytesRead = 0;
        for await (const chunk of fs.createReadStream(entry.sourcePath)) {
          bytesRead += chunk.length;
          yield chunk;
        }
        if (bytesRead !== size) throw new Error(`File changed while creating backup: ${entry.archivePath}`);
      }
      if (size % BLOCK_SIZE) yield Buffer.alloc(BLOCK_SIZE - (size % BLOCK_SIZE));
    }
    yield Buffer.alloc(BLOCK_SIZE * 2);
  }

  const gzip = zlib.createGzip();
  pipeline(Readable.from(generateTar()), gzip).catch((error) => gzip.destroy(error));
  return gzip;
}

class ByteReader {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.ended = false;
  }

  async fill() {
    if (this.offset < this.buffer.length || this.ended) return;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      this.buffer = Buffer.alloc(0);
      this.offset = 0;
      return;
    }
    this.buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.offset = 0;
  }

  async readExact(length, allowCleanEof = false) {
    const chunks = [];
    let received = 0;
    while (received < length) {
      await this.fill();
      if (this.offset >= this.buffer.length) {
        if (allowCleanEof && received === 0 && this.ended) return null;
        throw new Error("Backup archive ended unexpectedly");
      }
      const count = Math.min(length - received, this.buffer.length - this.offset);
      chunks.push(this.buffer.subarray(this.offset, this.offset + count));
      this.offset += count;
      received += count;
    }
    return Buffer.concat(chunks, received);
  }

  async *take(length) {
    let remaining = length;
    while (remaining > 0) {
      await this.fill();
      if (this.offset >= this.buffer.length) throw new Error("Backup archive ended inside a file");
      const count = Math.min(remaining, this.buffer.length - this.offset);
      yield this.buffer.subarray(this.offset, this.offset + count);
      this.offset += count;
      remaining -= count;
    }
  }

  async drainZeroPadding() {
    if (this.buffer.subarray(this.offset).some((byte) => byte !== 0)) {
      throw new Error("Backup contains data after its end marker");
    }
    this.offset = this.buffer.length;
    while (!this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (chunk.some((byte) => byte !== 0)) throw new Error("Backup contains data after its end marker");
    }
  }
}

function parseOctal(field) {
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("Backup archive contains an invalid size");
  return Number.parseInt(text, 8);
}

function readTarPath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

async function extractTarGzipFile(archivePath, destination, { allowPath, maxFiles, maxBytes }) {
  fs.mkdirSync(destination, { recursive: true });
  const source = fs.createReadStream(archivePath);
  const gunzip = zlib.createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new ByteReader(gunzip);
  const seen = new Set();
  let fileCount = 0;
  let totalBytes = 0;

  while (true) {
    const header = await reader.readExact(BLOCK_SIZE, true);
    if (!header) throw new Error("Backup archive is missing its end marker");
    if (header.every((byte) => byte === 0)) {
      const secondEndBlock = await reader.readExact(BLOCK_SIZE);
      if (!secondEndBlock.every((byte) => byte === 0)) throw new Error("Backup archive end marker is incomplete");
      await reader.drainZeroPadding();
      break;
    }
    const name = readTarPath(header);
    const expectedChecksum = parseOctal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum) throw new Error("Backup archive header checksum is invalid");
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== "0".charCodeAt(0)) {
      throw new Error("Backup may contain regular files only");
    }
    if (!name || name.includes("\\") || name.startsWith("/") || path.posix.normalize(name) !== name || name.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("Backup contains an unsafe path");
    }
    if (!allowPath(name)) throw new Error(`Backup contains an unsupported path: ${name}`);
    if (seen.has(name)) throw new Error(`Backup repeats a path: ${name}`);
    seen.add(name);

    const size = parseOctal(header.subarray(124, 136));
    fileCount += 1;
    totalBytes += size;
    if (fileCount > maxFiles || totalBytes > maxBytes) throw new Error("Backup exceeds restore limits");

    const target = path.resolve(destination, ...name.split("/"));
    const relative = path.relative(destination, target);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("Backup path escapes its staging folder");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await pipeline(Readable.from(reader.take(size)), fs.createWriteStream(target, { flags: "wx" }));
    const padding = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding) {
      for await (const ignored of reader.take(padding)) {
        // Consume the tar block padding without buffering it.
      }
    }
  }

  return { files: seen, fileCount, totalBytes };
}

module.exports = { createTarGzipStream, extractTarGzipFile };
