// Shared helper: turn a URL or a local file path into a Responses API media part.
// Local files up to 50 MB go inline as a base64 data URL (documented for input_image and input_video).
// Bigger local files are uploaded once with POST /v1/files and referenced by file_id.
import fs from "fs";
import path from "path";
import type OpenAI from "openai";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};
const INLINE_LIMIT = 50_000_000;

export async function mediaPart(client: OpenAI, src: string): Promise<any> {
  const isVideo = /\.(mp4|mov)(\?|$)/i.test(src);
  if (/^https?:\/\//i.test(src)) {
    return isVideo ? { type: "input_video", video_url: src } : { type: "input_image", image_url: src };
  }
  if (!fs.existsSync(src)) throw new Error(`Not a URL and no such file: ${src}`);
  const ext = path.extname(src).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`Unsupported file type ${ext}. Use mp4/mov for video or png/jpg/webp/gif for images.`);
  const size = fs.statSync(src).size;
  if (size <= INLINE_LIMIT) {
    const dataUrl = `data:${mime};base64,${fs.readFileSync(src).toString("base64")}`;
    console.log(`sending ${path.basename(src)} inline (${(size / 1e6).toFixed(1)} MB)`);
    return isVideo ? { type: "input_video", video_url: dataUrl } : { type: "input_image", image_url: dataUrl };
  }
  console.log(`uploading ${path.basename(src)} (${(size / 1e6).toFixed(1)} MB) to /v1/files, expires in 1 day`);
  const file: any = await client.files.create({
    purpose: "user_data",
    expires_after: { anchor: "created_at", seconds: 86400 },
    file: fs.createReadStream(src),
  } as any);
  return isVideo ? { type: "input_video", file_id: file.id } : { type: "input_image", file_id: file.id };
}
