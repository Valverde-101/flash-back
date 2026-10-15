const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { readJson, writeJson } = require("../server/lib/jsonStore");

test("JSON writes keep the previous version and recover from a damaged primary file", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flashback-json-store-"));
  const filePath = path.join(temporaryRoot, "catalog.json");
  const isValidObject = (value) => value && Number.isInteger(value.version);
  try {
    writeJson(filePath, { version: 1 });
    writeJson(filePath, { version: 2 });
    assert.equal(readJson(filePath, null, isValidObject).version, 2);
    assert.equal(readJson(`${filePath}.bak`, null, isValidObject).version, 1);

    fs.writeFileSync(filePath, "{invalid json");
    assert.equal(readJson(filePath, null, isValidObject).version, 1);
    assert.equal(readJson(filePath, null, isValidObject).version, 1, "recovery restores the primary file");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
