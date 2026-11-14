export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A reason the file cannot be attached, or null when it can. */
export function imageProblem(file: { name: string; type: string; size: number }, attached: number): string | null {
  if (attached >= MAX_IMAGES) return `You can attach at most ${MAX_IMAGES} images to one message.`;
  if (!TYPES.has(file.type)) return `${file.name} is not a supported image. Use png, jpeg, gif or webp.`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB. Resize it and try again.`;
  return null;
}

export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
