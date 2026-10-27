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
EXPO_PUBLIC_API_BASE_URL=https://YOUR-NGROK-HOST \
EXPO_PUBLIC_API_SECRET=YOUR-APP-SHARED-KEY \
EXPO_PUBLIC_PROVIDER_MODE=meta \
npm run start --workspace @truebuild/app -- --lan
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

- Default models: `muse-spark-1.3` and `sam-3.1`. `MODEL_SPARK` explicitly opts into
  `muse-spark-1.3-contributor` (content may train Meta models) or preview `muse-wonder-1.0`.
- Structured output uses Responses `text.format` with a strict, finite JSON schema.
  Images are user-role `input_image` blocks. Requests use `store:false` and low reasoning.
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
Meta calls use multipart; the wire mode remains `model`. Metadata is limited to 512 KiB,
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
development only. The production app has no sample manual or fixture-mode switch and
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
native requests do not need a browser Origin. Deployment is not part of this task.
Optional backend clip processing still needs ffprobe/ffmpeg at the configured Homebrew
paths and is unqualified. Still-image Spark checks do not need those tools.
