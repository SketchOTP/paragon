import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertNotProductionWrite, getProductionDataDir } from "../src/smartRoute/dataPaths.js";
import { writeCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";

const PROD_SNAPSHOT = path.join(getProductionDataDir(), "model-intelligence-current.json");
const suiteDataDir = process.env.SMARTROUTE_DATA_DIR;

test("NODE_ENV=test refuses writes to production snapshot path", async () => {
  process.env.NODE_ENV = "test";
  process.env.SMARTROUTE_TEST = "1";
  process.env.SMARTROUTE_DATA_DIR = getProductionDataDir();
  try {
    assert.throws(
      () => assertNotProductionWrite(PROD_SNAPSHOT),
      /Refusing to write production SmartRoute data path during tests/
    );
    await assert.rejects(
      () =>
        writeCurrentSnapshot({
          version: 1,
          models: [{ canonical_id: "claude:claude-haiku-4-5" }],
          rankings: {}
        }),
      /Refusing to write production SmartRoute data path during tests/
    );
  } finally {
    if (suiteDataDir) process.env.SMARTROUTE_DATA_DIR = suiteDataDir;
  }
});

test("production snapshot is unchanged by guard rejection", async () => {
  process.env.NODE_ENV = "test";
  let before = null;
  try {
    before = await fs.readFile(PROD_SNAPSHOT, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  process.env.SMARTROUTE_DATA_DIR = getProductionDataDir();
  try {
    await writeCurrentSnapshot({
      version: 1,
      models: [{ canonical_id: "test-fixture:should-not-land" }],
      rankings: {}
    });
    assert.fail("expected production write to throw");
  } catch (error) {
    assert.match(error.message, /Refusing to write production/);
  } finally {
    if (suiteDataDir) process.env.SMARTROUTE_DATA_DIR = suiteDataDir;
  }

  let after = null;
  try {
    after = await fs.readFile(PROD_SNAPSHOT, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.equal(after, before);
  if (after) {
    assert.doesNotMatch(after, /test-fixture:should-not-land/);
  }
});
