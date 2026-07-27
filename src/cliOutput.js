/** Shared helpers for parsing CLI / pseudo-TTY output. */

export function stripAnsi(text, { preserveCr = false } = {}) {
  let out = String(text ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  if (!preserveCr) {
    out = out.replace(/\r/g, "");
  }
  return out;
}

export function splitTTYLines(text) {
  const plain = stripAnsi(text, { preserveCr: true });
  const lines = [];
  for (const physical of plain.split(/\r\n|\n/)) {
    const segments = physical.split("\r");
    const line = segments[segments.length - 1].trim();
    if (line) {
      lines.push(line);
    }
  }
  return lines
    .filter((line) => !/^fetching/i.test(line))
    .filter((line) => !/^error:/i.test(line))
    .filter((line) => !/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\\-]+$/.test(line));
}

export function dedupeModels(models) {
  const byId = new Map();
  for (const model of models ?? []) {
    if (!model?.id || byId.has(model.id)) {
      continue;
    }
    byId.set(model.id, { id: model.id, name: model.name || model.id });
  }
  return [...byId.values()];
}
