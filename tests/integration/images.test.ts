import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toMessages } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, openDatabase, type DbHandle } from "../../server/db";
import { attachImages, loadImage, saveImage } from "../../server/images";

const dirs: string[] = [];
const handles: DbHandle[] = [];
// 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function setup(): DbHandle {
  const home = mkdtempSync(join(tmpdir(), "atelier-images-"));
  dirs.push(home);
  const handle = openDatabase(ensureHome(home));
  handles.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("image store", () => {
  it("saves a png once by content and loads it back", () => {
    const { paths } = setup();
    const a = saveImage(paths, "image/png", PNG);
    const b = saveImage(paths, "image/png", PNG);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(loadImage(paths, a)).toEqual({ mediaType: "image/png", data: PNG });
  });

  it("rejects unsupported types, bytes that are not that image, and oversize data", () => {
    const { paths } = setup();
    expect(() => saveImage(paths, "image/svg+xml", PNG)).toThrowError(/not supported/i);
    expect(() => saveImage(paths, "image/png", Buffer.from("hello world").toString("base64"))).toThrowError(/not a valid/i);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5 * 1024 * 1024)]).toString("base64");
    expect(() => saveImage(paths, "image/png", big)).toThrowError(/too large/i);
  });

  it("refuses ids that could escape the blob directory", () => {
    const { paths } = setup();
    expect(loadImage(paths, "../x.png")).toBeNull();
    expect(loadImage(paths, "0123456789abcdef.png")).toBeNull();
  });
});

describe("image attachment on a message", () => {
  it("appends one marker per existing image and caps the count", () => {
    const { paths } = setup();
    const id = saveImage(paths, "image/png", PNG);
    expect(attachImages(paths, "look", [id, id])).toBe(`look\n\n<attached_image id="${id}"/>`);
    expect(attachImages(paths, "look", [])).toBe("look");
    expect(() => attachImages(paths, "look", ["0123456789abcdef.png"])).toThrowError(/not found/i);
    const many = Array.from({ length: 5 }, (_, i) => saveImage(paths, "image/png", Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from([i])]).toString("base64")));
    expect(() => attachImages(paths, "look", many)).toThrowError(/too many/i);
  });

  it("turns markers into image parts for the model and keeps the text clean", () => {
    const handle = setup();
    const id = saveImage(handle.paths, "image/png", PNG);
    const session = createSession(handle, "Pic");
    appendMessage(handle, session.id, "user", attachImages(handle.paths, "what is this?", [id]), null);
    const [message] = toMessages(handle, session.id, 10);
    expect(message?.content).toBe("what is this?");
    expect(message?.images).toEqual([{ mediaType: "image/png", data: PNG }]);
  });
});
