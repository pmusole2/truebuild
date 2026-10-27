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
  Images are user-role `input_image` blocks. Requests use `store:false`. Spark uses low
  reasoning. The Wonder parse target is `reasoning.effort: high`; until the explicit parse
  option is integrated, the provider still sends low for every model.
- Still overlays use Spark's documented perception grounding in the same check/ask call.
  SAM remains a backend/operator mask and optional clip path; there is no clips UI.
- Stable instructions, the full reviewed plan/parts and every ordered manual image precede
  the changing step/photo/question. Cache hits are measured from usage, never assumed.
- `MODEL_CHECK_CONTEXT=full` sends up to 20 source pages plus one frozen observation.
  Explicit server `compact` selects 1–2 pages only if every required citation fits.
  It returns unavailable without dispatch when coverage is impossible. No automatic
  second call is made after a timeout.
- The server enforces an absolute check/ask deadline of at most 8 seconds. Delivered
  verdicts and human question composition persist until their capture binding changes.
  A question gets a new call deadline; another check requires a new photo.
- `MODEL_CALL_LIMIT` defaults to 200 conservative admitted attempts per process, reset on
  restart. Admission can consume a unit without provider dispatch; every retry consumes
  another. This is a call cap, not exact billing or a monetary budget.
- Retry only documented transient statuses 429/500/503, at most three attempts with
  exponential jitter and `Retry-After`, within the same deadline. Ambiguous transport
  failures are not retried. Zero rate-limit remaining reserves a conservative 60-second
  local pause because no reset header is documented; a shorter request can time out
  while waiting without dispatching.
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
`MODEL_SPARK` to anything other than `muse-spark-1.3`, and it fails a response whose
returned model is another model. A response without model provenance cannot prove the
model, so that case is reported as the existing result rather than as Spark-verified.

### Gate 1b: Spark versus Wonder parse (A/B)

```sh
npm run gate:1b -- --manifest uploads/gate.json --dispatch --ab --confirm-critical-facts --review
```

Gate 1b parses the same ordered real pages once with `muse-spark-1.3` and once with
`muse-wonder-1.0`, in process through the provider with an explicit `parseModel` for each
arm. The arm order is randomized. Until the provider exposes the explicit `parseModel`
option, both arms refuse with `provider_dependency_unavailable` and nothing is dispatched. It does not use the API route, a request model override or
process-wide environment changes, and it does not need `API_SHARED_SECRET`.

- Readiness is read from the local `.env` only after both `--dispatch` and `--ab`: it needs
  `PROVIDER_MODE=meta` and `MODEL_API_KEY`. The key is never printed, logged or sent by the
  gate. `--review` needs an interactive terminal.
- **No automatic fallback.** Each arm is attributed to the model it requested. A Wonder
  error, timeout or missing dispatch attribution makes that arm `failed` or `incomplete`.
  The gate never retries it, never calls Spark in its place and never reports Spark's result
  as Wonder's. Attribution comes from server dispatch metrics and any returned model field;
  a mismatch marks the arm incomplete.
- Per arm the report records status and reason, provider attempts, gate-measured latency,
  input, cached and output tokens, and cost. Cost is priced only from actual uncached input,
  cached input and output tokens at the cited Standard rates (reasoning is inside output);
  missing usage is reported as unverified, never zero.
- Semantic accuracy is unverified without `--review`, and no winner is declared without it.
  With review, the winner is the higher reviewed step accuracy on this single manual, only
  when both arms completed. Equal accuracy is `no_measured_difference`. Cost and latency are
  reported beside the winner and do not decide it.
- Every 1b run reports `automaticFallback: none`, `defaultChange: none` and
  `recommendation: keep_spark_default`. No gate result changes configuration; Spark stays the
  parse default unless the operator changes it explicitly after reviewing the evidence.
- Only aggregates are appended to `docs/gate-results.md`: no key, no page bytes, no step text.
  A refusal still writes an aggregate line with `requests: 0`.

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
