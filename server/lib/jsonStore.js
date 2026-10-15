const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parseJsonFile(filePath, validator) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (validator && !validator(value)) {
    throw new Error(`Invalid JSON data shape in ${filePath}`);
  }
  return value;
}

function readJson(filePath, fallback, validator) {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return parseJsonFile(filePath, validator);
  } catch (primaryError) {
    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) throw primaryError;

    const backup = parseJsonFile(backupPath, validator);
    restoreBackup(filePath, backup);
    return backup;
  }
}

function restoreBackup(filePath, value) {
  writeJson(filePath, value, { backup: false });
}

function writeJson(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  const backupPath = `${filePath}.bak`;

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });

    if (options.backup !== false && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }

    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      // Preserve the original storage error.
    }
    throw error;
  }
}

module.exports = { readJson, writeJson };
