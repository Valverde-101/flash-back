const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { _extractGameZipSwf } = require("../server/lib/flashpoint");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const [name, contents] of files) {
    const filename = Buffer.from(name, "utf8");
    const data = Buffer.from(contents);
    const compressed = zlib.deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localRecords.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

const validSwf = Buffer.from([0x46, 0x57, 0x53, 8, 8, 0, 0, 0]);

test("imports the launch SWF and same-folder game data from a GameZIP", () => {
  const archive = createZip([
    ["content/localflash/game/main.swf", validSwf],
    ["content/localflash/game/config.xml", "<game />"],
    ["content/localflash/game/notes.exe", "must not be extracted"],
    ["content/localflash/other/other.swf", validSwf],
  ]);

  const result = _extractGameZipSwf(archive, "http://localflash/game/main.swf");
  assert.deepEqual(result.buffer, validSwf);
  assert.deepEqual(result.sidecarAssets.map((asset) => [asset.filename, asset.buffer.toString()]), [
    ["config.xml", "<game />"],
  ]);
});

test("rejects ambiguous archives rather than importing the wrong game", () => {
  const archive = createZip([
    ["content/one/first.swf", validSwf],
    ["content/two/second.swf", validSwf],
  ]);
  assert.throws(() => _extractGameZipSwf(archive, ""), { code: "ERR_GAMEZIP_SWF_AMBIGUOUS" });
});

test("rejects archives without an SWF and ignores traversal sidecars", () => {
  assert.throws(() => _extractGameZipSwf(createZip([["content/game/readme.txt", "hello"]]), ""), {
    code: "ERR_GAMEZIP_SWF_NOT_FOUND",
  });

  const archive = createZip([
    ["content/game/main.swf", validSwf],
    ["content/game/../../outside.xml", "outside"],
  ]);
  const result = _extractGameZipSwf(archive, "http://localflash/main.swf");
  assert.deepEqual(result.sidecarAssets, []);
});
