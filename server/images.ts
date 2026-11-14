import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { AtelierError, type AtelierPaths } from "./config.js";
import type { ImagePart } from "./providers/types.js";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
};
const ID = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
const MARKER = /\n\n<attached_image id="([0-9a-f]{16}\.(?:png|jpg|gif|webp))"\/>/g;

function mediaTypeOf(id: string): string | null {
  const ext = id.slice(id.lastIndexOf(".") + 1);
  return Object.entries(TYPES).find(([, info]) => info.ext === ext)?.[0] ?? null;
}

/** Store image bytes once by content hash under the blob directory and return its id. */
export function saveImage(paths: AtelierPaths, mediaType: string, base64: string): string {
  const info = TYPES[mediaType];
  if (info === undefined) {
    throw new AtelierError("BAD_REQUEST", "That image type is not supported.", `${mediaType} is not png, jpeg, gif or webp.`, "Attach a png, jpeg, gif or webp image.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new AtelierError("BAD_REQUEST", "The image is too large.", `It is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, "Resize or compress the image and attach it again.");
  }
  if (!info.magic.every((byte, index) => bytes[index] === byte)) {
    throw new AtelierError("BAD_REQUEST", "The file is not a valid image.", `Its bytes do not look like ${mediaType}.`, "Attach the original image file.");
  }
  const id = `${hashOf(bytes)}.${info.ext}`;
  const path = join(paths.blobs, `img_${id}`);
  // An existing blob is trusted only if its bytes still hash to its name; a torn write is replaced.
  if (loadImage(paths, id) === null) writeAtomic(path, bytes);
  return id;
}

function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Temp file, fsync, then rename, so a crash leaves the old state or the whole new file, never half of it. */
function writeAtomic(path: string, bytes: Buffer): void {
  const temp = `${path}.tmp_${process.pid}`;
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

export function loadImage(paths: AtelierPaths, id: string): ImagePart | null {
  if (!ID.test(id)) return null;
  const mediaType = mediaTypeOf(id);
  const path = join(paths.blobs, `img_${id}`);
  if (mediaType === null || !existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (hashOf(bytes) !== id.slice(0, 16)) return null;
  return { mediaType, data: bytes.toString("base64") };
}

/** Append one marker per distinct stored image so the message stays small and replayable. */
export function attachImages(paths: AtelierPaths, text: string, ids: string[]): string {
  const distinct = [...new Set(ids)];
  if (distinct.length > MAX_IMAGES) {
    throw new AtelierError("BAD_REQUEST", "Too many images.", `${distinct.length} images were attached.`, `Attach at most ${MAX_IMAGES} images per message.`);
  }
  let out = text;
  for (const id of distinct) {
    if (loadImage(paths, id) === null) throw new AtelierError("BAD_REQUEST", "Image not found.", id, "Attach the image again.");
    out += `\n\n<attached_image id="${id}"/>`;
  }
  return out;
}

/** Split a stored message into its text and the stored images it references. */
export function extractImages(paths: AtelierPaths, content: string): { text: string; images: ImagePart[] } {
  const images: ImagePart[] = [];
  for (const match of content.matchAll(MARKER)) {
    const image = loadImage(paths, match[1] ?? "");
    if (image !== null) images.push(image);
  }
  return { text: content.replace(MARKER, ""), images };
}

const EXTENSIONS: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Store an image file from disk (for `atelier run --image`) and return its id. */
export function saveImageFile(paths: AtelierPaths, base: string, file: string): string {
  const path = resolve(base, file);
  const mediaType = EXTENSIONS[extname(path).toLowerCase()];
  if (mediaType === undefined) {
    throw new AtelierError("HEADLESS_IMAGE", "That image type is not supported.", `${file} does not end in .png, .jpg, .jpeg, .gif or .webp.`, "Pass a png, jpeg, gif or webp file.");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new AtelierError("HEADLESS_IMAGE", "Image file not found.", `${path} is not a readable file.`, "Check the path passed to --image.");
  }
  if (statSync(path).size > MAX_IMAGE_BYTES) {
    throw new AtelierError("BAD_REQUEST", "The image is too large.", `${file} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, "Resize or compress the image and try again.");
  }
  return saveImage(paths, mediaType, readFileSync(path).toString("base64"));
}
