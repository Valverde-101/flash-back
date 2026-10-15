// Downloads the latest Ruffle "web-selfhosted" build into public/ruffle/
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const { RUFFLE_DIR } = require("../lib/paths");

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

function httpGetJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "flashback" }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error("Too many redirects while checking Ruffle release."));
        const nextUrl = new URL(res.headers.location, url);
        if (nextUrl.protocol !== "https:") return reject(new Error("Ruffle release redirected to a non-HTTPS URL."));
        return resolve(httpGetJson(nextUrl, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 2 * 1024 * 1024) request.destroy(new Error("Ruffle release metadata exceeded the size limit."));
      });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Timed out while checking Ruffle release.")));
    request.on("error", reject);
  });
}

function downloadFile(url, destPath, redirects = 0, bytes = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let request;
    file.on("error", (error) => {
      if (request) request.destroy(error);
      else reject(error);
    });
    request = https.get(url, { headers: { "User-Agent": "flashback" }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close(() => {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          if (redirects >= MAX_REDIRECTS) return reject(new Error("Too many redirects while downloading Ruffle."));
          const nextUrl = new URL(res.headers.location, url);
          if (nextUrl.protocol !== "https:") return reject(new Error("Ruffle download redirected to a non-HTTPS URL."));
          resolve(downloadFile(nextUrl, destPath, redirects + 1));
        });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return file.close(() => {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
        });
      }
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) request.destroy(new Error("Ruffle archive exceeded the 300 MiB download limit."));
      });
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    request.on("timeout", () => request.destroy(new Error("Timed out while downloading Ruffle.")));
    request.on("error", (error) => {
      file.destroy();
      file.close(() => {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(error);
      });
    });
  });
}

async function main() {
  console.log("Fetching latest Ruffle release info...");
  const release = await httpGetJson("https://api.github.com/repos/ruffle-rs/ruffle/releases/latest");
  const asset = release.assets.find((a) => a.name.endsWith("-web-selfhosted.zip"));

  if (!asset) {
    throw new Error("Could not find web-selfhosted asset in latest Ruffle release.");
  }

  console.log(`Found ${asset.name} (${release.tag_name}).`);

  fs.mkdirSync(RUFFLE_DIR, { recursive: true });
  const zipPath = path.join(RUFFLE_DIR, "ruffle.zip");

  console.log("Downloading...");
  await downloadFile(asset.browser_download_url, zipPath);

  console.log("Extracting...");
  // Windows 10+ includes tar.exe with ZIP support; Unix also has tar by
  // default. This avoids requiring Git Bash's separate `unzip` executable.
  execFileSync(process.platform === "win32" ? "tar.exe" : "tar", ["-xf", zipPath, "-C", RUFFLE_DIR], { stdio: "inherit" });
  fs.unlinkSync(zipPath);

  fs.writeFileSync(
    path.join(RUFFLE_DIR, "VERSION"),
    `${release.tag_name}\n`
  );

  console.log(`Ruffle ${release.tag_name} installed at ${RUFFLE_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
