// TrueBuild gate check 1: can SAM 3.1 find and track flat-pack parts in a clip?
// Usage: MODEL_API_KEY=... npx tsx sam-smoke.ts "<local file or public URL: mp4/mov/jpg/png>" "wooden panel"
// Based on https://dev.meta.ai/docs/sam/overview (Responses API, model sam-3.1).
import OpenAI from "openai";
import { mediaPart } from "./media.ts";

const [mediaUrl, prompt = "wooden panel"] = process.argv.slice(2);
if (!mediaUrl || !process.env.MODEL_API_KEY) {
  console.error('Usage: MODEL_API_KEY=... npx tsx sam-smoke.ts "<file or URL>" "<noun phrase>"');
  process.exit(1);
}
const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });

const media = await mediaPart(client, mediaUrl);
const started = Date.now();
let firstFrameMs: number | null = null;
let text = "";
const stream: any = await client.responses.create({
  model: "sam-3.1",
  input: [{ type: "message", role: "user", content: [
    { type: "input_text", text: prompt },
    media,
  ]}],
  stream: true,
} as any);

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    if (firstFrameMs === null) firstFrameMs = Date.now() - started;
    text += event.delta;
  }
}
const lines = text.split("\n").filter(Boolean);
const ids = new Set<string>();
for (const line of lines) for (const m of line.matchAll(/(?:^<\d+f>|,)(\d+)<\|box/g)) ids.add(m[1]);
console.log(`prompt="${prompt}" frames=${lines.length} distinct object ids=${ids.size}`);
console.log(`first frame after ${firstFrameMs ?? "-"} ms, total ${Date.now() - started} ms`);
console.log(lines.length ? `frame 0: ${lines[0].slice(0, 300)}...` : "No matches (empty output). Try a more concrete noun phrase.");
