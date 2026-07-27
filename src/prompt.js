export function messagesToPrompt(messages = []) {
  return messages
    .map((message) => {
      const role = message.role ?? "user";
      const content = normalizeContent(message.content);
      return `${role.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
}

export function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text ?? "";
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content);
}
