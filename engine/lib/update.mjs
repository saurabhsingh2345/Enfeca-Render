import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export function currentVersion() {
  return String(pkg.version || "0.0.0");
}

export function hostArch() {
  const a = os.arch();
  if (a === "arm64") return "darwin-arm64";
  return "darwin-x64";
}

function settingsPath(dataRoot) {
  return path.join(dataRoot, "update-settings.json");
}

export function loadUpdateSettings(dataRoot) {
  const file = settingsPath(dataRoot);
  let feedUrl = process.env.RENDER_AGENT_UPDATE_FEED?.trim() || "";
  if (fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof j.feedUrl === "string") feedUrl = j.feedUrl.trim();
    } catch {
      /* ignore */
    }
  }
  return { feedUrl };
}

export function saveUpdateSettings(dataRoot, { feedUrl }) {
  const file = settingsPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ feedUrl: String(feedUrl || "").trim() }, null, 2),
  );
  return loadUpdateSettings(dataRoot);
}

/** semver-ish compare: 1 if a>b, -1 if a<b, 0 equal */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function resolveFeedUrl(feedUrl, fileName) {
  const base = feedUrl.replace(/\/?latest\.json$/i, "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(fileName)) return fileName;
  return `${base}/${fileName.replace(/^\//, "")}`;
}

export async function checkForUpdate(dataRoot) {
  const { feedUrl } = loadUpdateSettings(dataRoot);
  const current = currentVersion();
  const arch = hostArch();

  if (!feedUrl) {
    return {
      ok: true,
      current,
      arch,
      feedUrl: "",
      updateAvailable: false,
      message:
        "Set an update feed URL first (folder that contains latest.json + DMG files). Example: http://192.168.30.123:8080/api/render-agent-updates",
    };
  }

  const latestUrl = /latest\.json$/i.test(feedUrl)
    ? feedUrl
    : `${feedUrl.replace(/\/$/, "")}/latest.json`;

  const res = await fetch(latestUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Could not read feed (${res.status}): ${latestUrl}`);
  }
  const latest = await res.json();
  const remoteVer = String(latest.version || "");
  const dmgName =
    latest.downloads?.[arch] ||
    latest.downloads?.[arch.replace("darwin-", "")] ||
    null;
  const newer = remoteVer && compareVersions(remoteVer, current) > 0;

  return {
    ok: true,
    current,
    arch,
    feedUrl,
    latestUrl,
    remoteVersion: remoteVer,
    notes: latest.notes || "",
    updateAvailable: Boolean(newer && dmgName),
    upToDate: remoteVer ? compareVersions(remoteVer, current) <= 0 : false,
    dmgName,
    dmgUrl: dmgName ? resolveFeedUrl(feedUrl, dmgName) : null,
    message: !remoteVer
      ? "Feed missing version"
      : !dmgName
        ? `No DMG listed for ${arch}`
        : newer
          ? `Update available: ${remoteVer}`
          : `You are on the latest (${current})`,
  };
}

export async function downloadAndOpenDmg(dataRoot, dmgUrl, fileName) {
  if (!dmgUrl) throw new Error("Missing DMG URL");
  const downloads =
    process.env.HOME
      ? path.join(process.env.HOME, "Downloads")
      : os.tmpdir();
  fs.mkdirSync(downloads, { recursive: true });
  const dest = path.join(
    downloads,
    fileName || path.basename(new URL(dmgUrl).pathname) || "Explainer-Render-Agent-update.dmg",
  );

  const res = await fetch(dmgUrl, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok) throw new Error(`Download failed HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("Downloaded file looks empty");
  fs.writeFileSync(dest, buf);

  await openPath(dest);
  return { ok: true, path: dest };
}

export function openPath(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }
    execFile("open", [filePath], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
