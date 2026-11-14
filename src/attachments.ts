const FILE_BLOCK = /\n\n<attached_file path="([^"]+)">[\s\S]*?<\/attached_file>/g;
const IMAGE_MARKER = /\n\n<attached_image id="([0-9a-f]{16}\.(?:png|jpg|gif|webp))"\/>/g;

/** Separate what the user typed from the file contents and image references the server appended. */
export function splitAttachments(content: string): { text: string; files: string[]; images: string[] } {
  const files = [...content.matchAll(FILE_BLOCK)].map((match) => match[1] ?? "");
  const images = [...content.matchAll(IMAGE_MARKER)].map((match) => match[1] ?? "");
  return { text: content.replace(FILE_BLOCK, "").replace(IMAGE_MARKER, ""), files, images };
}
