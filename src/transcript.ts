import { splitAttachments } from "./attachments";
import type { Message } from "./types";

export function conversationMarkdown(title: string, messages: Message[], exportedAt: number = Date.now()): string {
  const lines: string[] = [`# ${title}`, ""];
  for (const message of messages) {
    lines.push(`## ${message.role === "user" ? "You" : "Atelier"}`);
    lines.push("");
    const { text, files: fileNames, images } = splitAttachments(message.text);
    const files = [...fileNames, ...images.map((_, index) => `image ${index + 1}`)];
    lines.push(text.trim());
    if (files.length > 0) lines.push("", `Attached: ${files.map((file) => `\`${file}\``).join(", ")}`);
    lines.push("");
  }
  if (messages.length === 0) {
    lines.push("_No messages in this conversation._");
    lines.push("");
  }
  lines.push(`_Exported ${new Date(exportedAt).toISOString()}._`);
  lines.push("");
  return lines.join("\n");
}

export function transcriptFilename(title: string): string {
  const safe = title
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return `${safe.length > 0 ? safe : "conversation"}.md`;
}

export interface DownloadDeps {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  click: (anchor: HTMLAnchorElement) => void;
}

export function downloadTranscript(
  title: string,
  messages: Message[],
  deps: Partial<DownloadDeps> = {},
): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const createObjectURL = deps.createObjectURL ?? URL.createObjectURL?.bind(URL);
  const revokeObjectURL = deps.revokeObjectURL ?? URL.revokeObjectURL?.bind(URL);
  if (typeof createObjectURL !== "function" || typeof revokeObjectURL !== "function") return false;
  const blob = new Blob([conversationMarkdown(title, messages)], { type: "text/markdown;charset=utf-8" });
  let url: string;
  try {
    url = createObjectURL(blob);
  } catch {
    return false;
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = transcriptFilename(title);
  const click = deps.click ?? ((node: HTMLAnchorElement) => node.click());
  try {
    click(anchor);
  } catch {
    revokeObjectURL(url);
    return false;
  }
  revokeObjectURL(url);
  return true;
}
