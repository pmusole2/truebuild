# TrueBuild

Photograph your manual, review the extracted plan, then build with a phone camera.
Freeze a photo to check a step or ask a question. A verified mismatch includes a reason,
its expected manual diagram and a grounded region on your photo. Unclear evidence stays
`cannot_verify`.

The app uses Meta mode by default. Missing credentials never select fixtures. The Meta
key stays on the Hono/Node 24 server. Real Meta output, assembly accuracy, 8-second model
latency, physical cameras, native file handling, Expo Go SDK 58 and deployed HTTPS remain
unverified. Local mocks establish protocol and application behavior only.

## Local setup

```sh
npm ci
cp .env.example .env
```

Put `MODEL_API_KEY` in the local `.env` and set a matching server `API_SHARED_SECRET`.
The phone's `EXPO_PUBLIC_API_SECRET` is public app configuration, not production user
authentication or a Meta credential. Never put a Meta key in an `EXPO_PUBLIC_*` variable.
Root API commands load `.env`; Expo commands deliberately do not.

```sh
# One GET /v1/models, no generation; refuses without a key.
npm run doctor

# Terminal 1
npm run start:api

# Terminal 2: expose the API for the phone; use the HTTPS URL ngrok prints.
ngrok http 3001

# Terminal 3: substitute that HTTPS URL and the matching public app shared key.
EXPO_NO_DOTENV=1 EXPO_OFFLINE=0 \
EXPO_PUBLIC_API_BASE_URL=https://YOUR-NGROK-HOST \
EXPO_PUBLIC_API_SECRET=YOUR-APP-SHARED-KEY \
EXPO_PUBLIC_PROVIDER_MODE=meta \
npm exec --workspace @truebuild/app -- expo start --lan
```

Scan pages or choose multiple photos, reorder or retake them, then read the manual.
Review the extracted facts against its diagrams before confirming. Missing critical facts
require clearer pages and a new read; the app does not invent them. Question entry supports
text and the phone keyboard's dictation, without a separate audio API.

Images are normalized on-device to JPEG, at most 1280 pixels on the long edge and
256 KiB per page. Up to 20 ordered manual pages are supported. Parsed manuals, original
normalized page bytes and progress persist locally. Saved assembly photos are view-only
after restart; take a fresh photo before checking or asking.

## Provider policy and contracts

- Default models: `muse-spark-1.3` for parse and check/ask, and `sam-3.1` for segmentation.
  `MODEL_SPARK` accepts only `muse-spark-1.3`; contributor IDs are rejected because submitted
  content may train Meta models. `muse-wonder-1.0` is a preview, more expensive Standard
  model: an explicit parse-only choice, never a default, a check/ask model or a fallback.
- No automatic fallback: no parse, check, ask or second opinion switches to another model
  after an error, timeout or refusal. A failed Wonder run stays a Wonder failure. Gate 1b
  reports that arm as incomplete or failed and never substitutes a Spark result for it.
- Structured output uses Responses `text.format` with a strict, finite JSON schema.
  Images are user-role `input_image` blocks. Requests use `store:false`. Reasoning is set
  per model: Spark uses `low`; the Wonder parse uses `high`.
- Logs contain allowlisted model/status/latency and numeric usage only, never bodies,
  questions, media or keys.

Routes: `POST /api/manuals/parse`, `/api/checks`, `/api/questions`, `/api/segments`;
`GET /api/session`, `/api/health`, `/health`. Data/session routes require `x-truebuild-key`.
App-to-Hono model calls use multipart; Hono-to-Meta Responses calls use JSON. The app
wire mode remains `model`. Metadata is limited to 512 KiB,
images to 4 MiB each and 8 MiB total. App uploads use tighter normalization limits.

## Documented mock and offline fixtures

The mock runs the real Meta-mode API/provider path against a loopback server which
validates documented request shapes. It refuses real credentials and requires an explicit
`--test-only` flag. It does not establish model accuracy.

```sh
# No MODEL_API_KEY in this process. Scenarios: correct, reversed, uncertain.
PORT=31071 CORS_ORIGINS=http://localhost:18071 \
node --import tsx api/scripts/mock-server.ts --test-only --scenario=reversed
```

Use public app key `truebuild-fixture-demo` and Meta app mode against that local mock.
Fixture mode remains an explicit `PROVIDER_MODE=fixture` option for tests/offline API
development only. The production app has no sample manual or fixture-mode UI switch and
rejects fixture envelopes. No key is needed for automated checks.

## Operator gates after the key arrives

Start the real API separately. Prepare ignored `uploads/gate.json` with real manual and
observation photos and independently reviewed truth. `npm run gate:1 -- --help` describes
its schema. Gate 2 defaults to Spark still grounding and needs `expectedObservationRegion`;
SAM and a short H.264 MP4/MOV clip are optional operator paths.

```sh
npm run gate:1 -- --manifest uploads/gate.json --dispatch --confirm-critical-facts --review
npm run gate:2 -- --manifest uploads/gate.json --dispatch --confirm-critical-facts
npm run gate:3 -- --manifest uploads/gate.json --dispatch --confirm-critical-facts
```

All gates refuse without a local key and required operator inputs. Gate 1's human review
grades semantic extraction; structural equality alone is insufficient. Gate 2 compares a
box to independent truth. Gate 3 measures one check against 8 seconds, reporting validated
server context scope. A compact result does not qualify full-manual latency. Aggregate
results stay local in ignored `docs/gate-results.md`. No real gate has run.

Gate 3 is Spark-only. It refuses before any dispatch when the local `.env` sets
`MODEL_SPARK` to anything other than `muse-spark-1.3`. It passes only when the returned
model is exactly `muse-spark-1.3`: a missing returned model is `unverified`
(`model_provenance_missing`), and any other returned model fails (`non_spark_model_returned`).

### Gate 1b: Spark versus Wonder parse (A/B)

```sh
npm run gate:1b -- --manifest uploads/gate.json --dispatch --ab --confirm-critical-facts --review
```

Gate 1b parses the same ordered real pages once with `muse-spark-1.3` and once with
`muse-wonder-1.0`. Each parse runs in process through the real provider, `createMetaProvider`
with an explicit `parseModel` per arm, and no request-level model override. The arm order is
randomized. It does not use the HTTP API route or process-wide environment changes, and it
does not need `API_SHARED_SECRET`.

- **Key path.** The gate reads `PROVIDER_MODE=meta` and `MODEL_API_KEY` from the local `.env`
  only after both `--dispatch` and `--ab` are present. The key is passed only to the provider,
  which sends it as the bearer header of its documented Meta Responses request to
  `https://api.meta.ai/v1/responses`. The gate never prints, logs or writes the key, and the
  report contains no key.
- **Retries.** The provider's documented policy applies: 429, 500 and 503 responses are retried
  inside one parse call, for at most 3 attempts. The gate itself never re-sends a parse. The
  report states `providerRetryPolicy` and `gateRetryPolicy: none`. Each arm's `attempts` counts
  the HTTP responses seen through the provider. It is `exact` only when the arm completed; a
  failed arm reports `lower_bound`, because a rejected fetch leaves no response to count.
- **No automatic fallback.** Each arm is attributed to the model it requested. A Wonder
  error, timeout or missing dispatch attribution makes that arm `failed` or `incomplete`.
  The gate never retries it, never calls Spark in its place and never reports Spark's result
  as Wonder's. Attribution comes from server dispatch metrics and any returned model field;
  a mismatch marks the arm incomplete.
- **Cost.** Each arm's cost is priced only from actual uncached input, cached input and output
  tokens at the cited Standard rates; reasoning is inside output. If usage or cached-token
  counts are missing, cost is `unverified`. The gate never treats a missing count as zero.
- **Plan quality.** Semantic step accuracy and a whole-plan operator rating are recorded per
  arm, and both need `--review`. The rating is 1 (poor) to 5 (excellent), with optional issue
  codes from a fixed list: `orientation`, `connection`, `part_identity`, `citation`,
  `missing_step`, `extra_step`, `step_order`, `unclear_wording`, `other`. Operator free text is
  not persisted, and the persisted report holds no model text or media.
- **Conclusion.** `conclusion` is `unverified` unless both arms completed and were step-reviewed
  and rated. It is `wonderClearlyWins` only when Wonder's step accuracy and rating are both
  higher than Spark's. It is `sparkClearlyWins` for the reverse, and `no_clear_win` for a tie or
  a split verdict. A percent difference alone never decides it. `wonderClearlyWins` is the
  boolean form of the same result. The conclusion covers one manual in one run.
- **Default.** Every 1b report states `defaultChange: none` and `recommendation:
keep_spark_default`. No result changes configuration. Spark remains the parse default unless
  the operator changes it explicitly after reviewing the evidence.
- Only aggregates are appended to `docs/gate-results.md`. A refusal writes an aggregate line
  with `requests: 0`.

The phone's `EXPO_PUBLIC_API_SECRET` remains public app configuration, not production user
authentication or a Meta credential. Gate 1b uses no phone header and no shared secret.

## Local library recovery

Any unavailable or damaged saved image locks the library read-only while retaining its
manifest, facts and remaining bytes. Use **Retry local library** after storage recovers;
writes resume only after a complete successful restore. Missing manifest with leftover
image chunks also stays read-only because the original identities cannot be inferred.

For permanent loss, restore app/site storage from an OS/browser backup and retry. With
no backup, explicitly reset app/site storage through OS/browser settings and re-import
original manual photos; that discards the local library. TrueBuild never resets it
automatically. Cache files left by an abrupt process crash rely on OS cache cleanup.

## Checks and deployment

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run format:check
npm run build:api
```

For container deployment use the repository root as build context:
`docker build -f api/Dockerfile -t truebuild-api .`. Configure provider/server environment
variables and HTTPS on the hosting platform. Add exact browser origins to `CORS_ORIGINS`;
native requests do not need a browser Origin. The current bundled shared header is public
and provides no private user authentication. Public deployment requires private server
access control and host-level request limits; do not use the bundled demo value as a
private production secret. Deployment and that access-control design are outside this task.
Optional backend clip processing still needs ffprobe/ffmpeg at the configured Homebrew
paths and is unqualified. Still-image Spark checks do not need those tools.
