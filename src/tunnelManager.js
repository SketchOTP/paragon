import { execSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants, existsSync, accessSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addLog } from "./logStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataDir = path.join(repoRoot, "data");
const tunnelUrlsPath = path.join(dataDir, "tunnel-urls.json");
const cloudflaredLogPath = path.join(dataDir, "cloudflared.log");
const cloudflaredBinPath = path.join(repoRoot, "bin", "cloudflared");
const cloudflaredPidPath = path.join(dataDir, "cloudflared.pid");
const ngrokLogPath = path.join(dataDir, "ngrok.log");
const ngrokPidPath = path.join(dataDir, "ngrok.pid");

const TRYCFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const CLOUDFLARED_WAIT_MS = 45000;
const NGROK_WAIT_MS = 30000;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

let cloudflaredChild = null;
let ngrokChild = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pidAlive(pidPath) {
  try {
    const raw = await fs.readFile(pidPath, "utf8");
    const pid = Number(raw.trim());
    if (!pid) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeTunnelEntry(provider, fields) {
  await fs.mkdir(dataDir, { recursive: true });
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(tunnelUrlsPath, "utf8"));
  } catch {
    /* fresh */
  }
  const entry = { ...(data[provider] ?? {}), ...fields, updatedAt: new Date().toISOString() };
  if (entry.url) {
    const origin = entry.url.replace(/\/$/, "");
    entry.cursorBaseUrl = `${origin}/v1`;
    entry.cursorAgentBaseUrl = `${origin}/v1/cursor`;
  }
  data[provider] = entry;
  await fs.writeFile(tunnelUrlsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return entry;
}

async function readTunnelUrls() {
  try {
    return JSON.parse(await fs.readFile(tunnelUrlsPath, "utf8"));
  } catch {
    return {};
  }
}

function resolveCloudflaredBin() {
  if (process.env.CLOUDFLARED_BIN) {
    return process.env.CLOUDFLARED_BIN;
  }
  return cloudflaredBinPath;
}

function resolveNgrokBin() {
  if (process.env.NGROK_BIN) {
    return process.env.NGROK_BIN;
  }
  if (process.platform !== "win32" && existsSync("/snap/bin/ngrok")) {
    try {
      accessSync("/snap/bin/ngrok", fsConstants.X_OK);
      return "/snap/bin/ngrok";
    } catch {
      /* fall through */
    }
  }
  return "ngrok";
}

async function cloudflaredInstalled() {
  const bin = resolveCloudflaredBin();
  try {
    await fs.access(bin, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function installCloudflared() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  await fs.mkdir(path.dirname(cloudflaredBinPath), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(cloudflaredBinPath, buffer);
  await fs.chmod(cloudflaredBinPath, 0o755);
  addLog({ type: "tunnel", provider: "cloudflared", message: "cloudflared installed to bin/" });
  return { bin: cloudflaredBinPath };
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }
}

async function stopCloudflared() {
  if (cloudflaredChild?.pid) {
    killPid(cloudflaredChild.pid);
    cloudflaredChild = null;
  }
  if (await pidAlive(cloudflaredPidPath)) {
    const raw = await fs.readFile(cloudflaredPidPath, "utf8");
    killPid(Number(raw.trim()));
  }
  await fs.unlink(cloudflaredPidPath).catch(() => {});
  addLog({ type: "tunnel", provider: "cloudflared", message: "stopped" });
}

async function stopNgrok() {
  if (ngrokChild?.pid) {
    killPid(ngrokChild.pid);
    ngrokChild = null;
  }
  if (await pidAlive(ngrokPidPath)) {
    const raw = await fs.readFile(ngrokPidPath, "utf8");
    killPid(Number(raw.trim()));
  }
  await fs.unlink(ngrokPidPath).catch(() => {});
  addLog({ type: "tunnel", provider: "ngrok", message: "stopped" });
}

async function urlFromCloudflaredLog() {
  try {
    const log = await fs.readFile(cloudflaredLogPath, "utf8");
    const match = log.match(TRYCFLARE_RE);
    return match?.[0] ?? "";
  } catch {
    return "";
  }
}

function ngrokPublicUrl() {
  return new Promise((resolve) => {
    const req = http.get(NGROK_API, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const tunnel = data.tunnels?.find((t) => t.public_url?.startsWith("https://"));
          resolve(tunnel?.public_url ?? "");
        } catch {
          resolve("");
        }
      });
    });
    req.on("error", () => resolve(""));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve("");
    });
  });
}

export async function startCloudflared(localPort) {
  if (!(await cloudflaredInstalled())) {
    throw new Error("cloudflared not installed — use Install in dashboard or ./scripts/install-cloudflared.sh");
  }
  if (cloudflaredChild?.pid || (await pidAlive(cloudflaredPidPath))) {
    const urls = await readTunnelUrls();
    return {
      alreadyRunning: true,
      entry: urls.cloudflared,
      url: urls.cloudflared?.url ?? (await urlFromCloudflaredLog())
    };
  }

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(cloudflaredLogPath, "", "utf8");

  const bin = resolveCloudflaredBin();
  const localUrl = `http://127.0.0.1:${localPort}`;
  const logHandle = await fs.open(cloudflaredLogPath, "a");

  cloudflaredChild = spawn(bin, ["tunnel", "--url", localUrl, "--no-autoupdate"], {
    cwd: repoRoot,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    detached: false
  });

  await fs.writeFile(cloudflaredPidPath, `${cloudflaredChild.pid}\n`, "utf8");
  addLog({ type: "tunnel", provider: "cloudflared", message: `starting (pid ${cloudflaredChild.pid})` });

  cloudflaredChild.on("exit", () => {
    cloudflaredChild = null;
    fs.unlink(cloudflaredPidPath).catch(() => {});
  });

  let url = "";
  const deadline = Date.now() + CLOUDFLARED_WAIT_MS;
  while (Date.now() < deadline) {
    url = await urlFromCloudflaredLog();
    if (url) {
      break;
    }
    await sleep(1000);
  }

  if (!url) {
    await stopCloudflared();
    throw new Error("No trycloudflare.com URL within timeout — check data/cloudflared.log");
  }

  const entry = await writeTunnelEntry("cloudflared", { url, running: true });
  addLog({ type: "tunnel", provider: "cloudflared", message: `public URL ${url}` });
  return { entry, url };
}

export async function startNgrok(localPort, authtoken, domain = "") {
  const token = (authtoken || "").trim();
  if (!token) {
    throw new Error("ngrok authtoken required — add it in Server settings");
  }
  const host = (domain || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const expectedUrl = host ? `https://${host}` : "";

  if (ngrokChild?.pid || (await pidAlive(ngrokPidPath))) {
    const urls = await readTunnelUrls();
    const live = (await ngrokPublicUrl()) || expectedUrl;
    return {
      alreadyRunning: true,
      entry: urls.ngrok,
      url: live || urls.ngrok?.url
    };
  }

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(ngrokLogPath, "", "utf8");

  const bin = resolveNgrokBin();
  const logHandle = await fs.open(ngrokLogPath, "a");
  const args = ["http", String(localPort), "--log=stdout"];
  if (host) {
    args.splice(1, 0, `--url=${host}`);
  }

  ngrokChild = spawn(bin, args, {
    cwd: repoRoot,
    env: { ...process.env, NGROK_AUTHTOKEN: token },
    stdio: ["ignore", logHandle.fd, logHandle.fd]
  });

  await fs.writeFile(ngrokPidPath, `${ngrokChild.pid}\n`, "utf8");
  addLog({ type: "tunnel", provider: "ngrok", message: `starting (pid ${ngrokChild.pid})` });

  ngrokChild.on("exit", () => {
    ngrokChild = null;
    fs.unlink(ngrokPidPath).catch(() => {});
  });

  let url = expectedUrl;
  const deadline = Date.now() + NGROK_WAIT_MS;
  while (Date.now() < deadline) {
    const live = await ngrokPublicUrl();
    if (live) {
      url = live;
      break;
    }
    if (expectedUrl) {
      break;
    }
    await sleep(1000);
  }

  if (!url) {
    await stopNgrok();
    throw new Error("ngrok did not publish a URL — verify authtoken at dashboard.ngrok.com");
  }

  const entry = await writeTunnelEntry("ngrok", { url, running: true });
  addLog({ type: "tunnel", provider: "ngrok", message: `public URL ${url}` });
  return { entry, url };
}

function tunnelProcessRunning(pattern) {
  try {
    execSync(`pgrep -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function getTunnelStatus(localPort) {
  const urls = await readTunnelUrls();
  const localTarget = `http://127.0.0.1:${localPort}`;
  const ngLiveUrl = await ngrokPublicUrl();
  const cfManagedRunning = cloudflaredChild?.pid || (await pidAlive(cloudflaredPidPath));
  const ngManagedRunning = ngrokChild?.pid || (await pidAlive(ngrokPidPath));
  const cfExternalRunning = tunnelProcessRunning(`cloudflared tunnel --url ${localTarget}`);
  const ngExternalRunning = tunnelProcessRunning(`ngrok http ${localPort}`);

  let cfUrl = urls.cloudflared?.url ?? "";
  if (cfManagedRunning || cfExternalRunning) {
    cfUrl = (await urlFromCloudflaredLog()) || cfUrl;
  }
  let ngUrl = urls.ngrok?.url ?? "";
  if (ngManagedRunning || ngExternalRunning || ngLiveUrl) {
    ngUrl = ngLiveUrl || ngUrl;
  }

  const cfActive = Boolean((cfManagedRunning || cfExternalRunning) && cfUrl);
  const ngActive = Boolean((ngManagedRunning || ngExternalRunning || ngLiveUrl) && ngUrl);

  return {
    localPort,
    cloudflared: {
      installed: await cloudflaredInstalled(),
      running: cfActive,
      url: cfActive ? cfUrl : "",
      cursorBaseUrl: cfActive ? `${cfUrl.replace(/\/$/, "")}/v1` : "",
      cursorAgentBaseUrl: cfActive ? `${cfUrl.replace(/\/$/, "")}/v1/cursor` : "",
      updatedAt: urls.cloudflared?.updatedAt
    },
    ngrok: {
      running: ngActive,
      url: ngActive ? ngUrl : "",
      cursorBaseUrl: ngActive ? `${ngUrl.replace(/\/$/, "")}/v1` : "",
      cursorAgentBaseUrl: ngActive ? `${ngUrl.replace(/\/$/, "")}/v1/cursor` : "",
      updatedAt: urls.ngrok?.updatedAt
    },
    saved: urls
  };
}

export { stopCloudflared, stopNgrok, readTunnelUrls, cloudflaredInstalled };
