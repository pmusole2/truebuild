// TrueBuild gate check 2: can Muse Spark turn a photo of a manual page into structured steps?
// Usage: MODEL_API_KEY=... npx tsx spark-manual-smoke.ts "<local photo or public URL of a manual page>"
import OpenAI from "openai";
import { mediaPart } from "./media.ts";

const [imageUrl] = process.argv.slice(2);
if (!imageUrl || !process.env.MODEL_API_KEY) {
  console.error('Usage: MODEL_API_KEY=... npx tsx spark-manual-smoke.ts "<photo file or URL>"');
  process.exit(1);
}
const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const media = await mediaPart(client, imageUrl);
const started = Date.now();
const res: any = await client.responses.create({
  model: "muse-spark-1.3",
  input: [{ role: "user", content: [
    { type: "input_text", text:
      "This is a page from a wordless flat-pack assembly manual. Return only JSON: " +
      '{"steps":[{"step":number,"parts":[{"label":string,"qty":number}],"orientation":string,"connection":string,"common_mistake":string}]}. ' +
      "Use the part labels printed in the manual. Say 'unclear' instead of guessing." },
    media,
  ]}],
} as any);
console.log(`took ${Date.now() - started} ms`);
console.log(res.output_text ?? JSON.stringify(res, null, 2));
