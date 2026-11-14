import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { RPC_CODES, RpcError } from "./rpc.js";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export interface ConvertedPrompt {
  text: string;
  images: Array<{ mediaType: string; data: string }>;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PROMPT_CHARS = 100_000;

function invalid(message: string): RpcError {
  return new RpcError(RPC_CODES.invalidParams, message);
}

/** A file:// link to a file inside the workspace, as a workspace-relative path, or null. */
function insideWorkspace(uri: string, workspace: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rel = relative(resolve(workspace), resolve(path));
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

/**
 * The prompt an ACP client sent (an array of content blocks) as atelier's prompt text plus images. Only what
 * `initialize` advertised is accepted: text, resource links and images. A link to a file inside the workspace
 * becomes an `@path` mention, which atelier already attaches; any other link stays plain text and attaches nothing.
 */
export function convertPrompt(blocks: unknown, workspace: string): ConvertedPrompt {
  if (!Array.isArray(blocks) || blocks.length === 0) throw invalid("prompt must be a non-empty array of content blocks.");
  const parts: string[] = [];
  const images: ConvertedPrompt["images"] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) throw invalid("each prompt block must be an object.");
    const entry = block as Record<string, unknown>;
    if (entry.type === "text") {
      if (typeof entry.text !== "string") throw invalid("a text block needs a text string.");
      parts.push(entry.text);
    } else if (entry.type === "resource_link") {
      if (typeof entry.uri !== "string" || typeof entry.name !== "string") throw invalid("a resource_link block needs uri and name.");
      const rel = insideWorkspace(entry.uri, workspace);
      parts.push(rel === null ? `[${entry.name}](${entry.uri})` : `@${rel}`);
    } else if (entry.type === "image") {
      if (typeof entry.mimeType !== "string" || !IMAGE_TYPES.has(entry.mimeType)) throw invalid("an image block must be png, jpeg, gif or webp.");
      if (typeof entry.data !== "string" || entry.data.length === 0) throw invalid("an image block needs base64 data.");
      images.push({ mediaType: entry.mimeType, data: entry.data });
    } else {
      throw invalid(`a ${String(entry.type)} block is not supported; this agent accepts text, resource_link and image.`);
    }
  }
  let text = parts.join("\n");
  if (text.trim().length === 0) {
    if (images.length === 0) throw invalid("the prompt has no text.");
    text = "See the attached image.";
  }
  if (text.length > MAX_PROMPT_CHARS) throw invalid(`the prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
  return { text, images };
}

const KINDS: Record<string, ToolKind> = {
  read_file: "read",
  git_status: "read",
  git_diff: "read",
  list_dir: "search",
  glob: "search",
  ripgrep: "search",
  write_file: "edit",
  edit_file: "edit",
  multi_edit: "edit",
  bash: "execute",
  delegate: "think",
};

export function toolKind(name: string): ToolKind {
  return KINDS[name] ?? "other";
}

export function toolTitle(name: string, detail: string): string {
  const text = detail.trim();
  if (text.length === 0) return name;
  return `${name}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
}

const BLOCK_MESSAGES: Record<string, string> = {
  no_provider: "No provider is configured. Add one in atelier's Settings (or config.json), then try again.",
  provider_missing: "The default provider no longer exists. Choose another in atelier's Settings.",
  no_model: "No default model is set. Choose one in atelier's Settings.",
  lease_busy: "Another atelier process is already running this conversation.",
};

/** A sentence for a blocked run's reason, so an editor shows something a person can act on; unknown reasons pass through. */
export function blockMessage(reason: string): string {
  return BLOCK_MESSAGES[reason] ?? reason;
}

/** The ACP stop reason for a blocked run, or null when it is a real failure that must be reported as an error. */
export function stopReasonFor(reason: string): StopReason | null {
  if (reason === "stopped") return "cancelled";
  if (reason === "step cap reached") return "max_turn_requests";
  return null;
}
