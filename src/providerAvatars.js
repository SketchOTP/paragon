/**
 * Provider avatar storage (PARAGON-D-004D1).
 *
 * Provider cards show a real avatar image instead of an emoji glyph. The five
 * providers that ship with PARAGON have bundled avatars under
 * `public/avatars/`; any provider — including one the operator adds later —
 * can override that with an uploaded image, stored as `providers.<id>.avatar`.
 *
 * Uploads are written to `data/avatars/` and served from `/provider-avatars/`,
 * NOT inlined into config.json as a data URI: a base64 image in the config
 * would bloat every config read/write on the request path and would be
 * re-sent in full by the dashboard on every save.
 *
 * Only the pixel data is trusted from the client, and only after the magic
 * bytes say it is one of three raster formats. The provider id supplies the
 * filename, so it is validated against the same charset the add-provider form
 * enforces — an id is never used as a path fragment unchecked.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./configStore.js";

export const AVATAR_DIR = path.join(dataDir, "avatars");
export const AVATAR_ROUTE = "/provider-avatars";

/** Decoded-bytes ceiling. Generous for an avatar, small enough to be harmless. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * Sniffed rather than taken from the data-URI mime type, which is
 * client-supplied and therefore not evidence of anything.
 */
const SIGNATURES = [
  { ext: "png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "webp",
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP"
  }
];

export function isValidProviderId(provider) {
  return PROVIDER_ID_PATTERN.test(String(provider ?? ""));
}

/**
 * Parses a `data:` URL into raw bytes. Returns a plain error string rather
 * than throwing, so the route can answer 400 with the specific reason.
 */
export function decodeAvatarDataUrl(dataUrl) {
  const raw = String(dataUrl ?? "");
  const match = /^data:([a-z0-9.+/-]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (!match) {
    return { error: "Avatar must be a base64 data URL (data:image/...;base64,...)" };
  }
  let bytes;
  try {
    bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  } catch {
    return { error: "Avatar base64 payload could not be decoded" };
  }
  if (!bytes.length) {
    return { error: "Avatar payload is empty" };
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    return { error: `Avatar is ${Math.round(bytes.length / 1024)}KB; the limit is ${MAX_AVATAR_BYTES / 1024}KB` };
  }
  const signature = SIGNATURES.find((candidate) => candidate.test(bytes));
  if (!signature) {
    return { error: "Avatar must be a PNG, JPEG or WebP image" };
  }
  return { bytes, ext: signature.ext };
}

/**
 * Writes the avatar and returns the served path. Any previously-stored
 * extension for this provider is removed first so switching formats cannot
 * leave a stale file that keeps being served.
 */
export async function saveProviderAvatar(provider, dataUrl) {
  if (!isValidProviderId(provider)) {
    return { error: "Provider id must be lowercase letters, numbers or hyphens" };
  }
  const decoded = decodeAvatarDataUrl(dataUrl);
  if (decoded.error) {
    return { error: decoded.error };
  }
  await fs.mkdir(AVATAR_DIR, { recursive: true });
  await Promise.all(
    SIGNATURES.map(({ ext }) => fs.rm(path.join(AVATAR_DIR, `${provider}.${ext}`), { force: true }))
  );
  const filename = `${provider}.${decoded.ext}`;
  await fs.writeFile(path.join(AVATAR_DIR, filename), decoded.bytes);
  // Cache-busted so replacing an avatar shows up without a hard reload.
  return { avatar: `${AVATAR_ROUTE}/${filename}?v=${Date.now()}`, bytes: decoded.bytes.length, ext: decoded.ext };
}

export async function removeProviderAvatar(provider) {
  if (!isValidProviderId(provider)) {
    return { error: "Provider id must be lowercase letters, numbers or hyphens" };
  }
  await Promise.all(
    SIGNATURES.map(({ ext }) => fs.rm(path.join(AVATAR_DIR, `${provider}.${ext}`), { force: true }))
  );
  return { ok: true };
}
