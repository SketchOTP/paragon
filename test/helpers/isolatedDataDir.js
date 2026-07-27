import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Run fn with SMARTROUTE_DATA_DIR pointed at a fresh temp directory.
 * Always sets NODE_ENV=test so production write guards stay active.
 */
export async function withIsolatedDataDir(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "routerbot-data-"));
  const prevDataDir = process.env.SMARTROUTE_DATA_DIR;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.SMARTROUTE_DATA_DIR = tmp;
  process.env.NODE_ENV = "test";
  try {
    return await fn(tmp);
  } finally {
    if (prevDataDir === undefined) delete process.env.SMARTROUTE_DATA_DIR;
    else process.env.SMARTROUTE_DATA_DIR = prevDataDir;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
}
