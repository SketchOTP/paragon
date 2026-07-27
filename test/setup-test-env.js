/**
 * Preload for the test suite. Redirects data writes into a temp dir during tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

if (!process.env.PARAGON_DATA_DIR && !process.env.ROUTERBOT_DATA_DIR) {
  process.env.PARAGON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-test-suite-"));
}
