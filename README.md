# TrueBuild

An Expo phone camera guide for flat-pack assembly, with a Hono API on Node 24.
Photograph the manual, choose a step, then take a frozen assembly photo. The result is
`pass`, `refuse` with a reason and the cited manual diagram, or `cannot_verify`.
Ask about the photo or localize a named part with SAM.

Runtime AI uses only Meta Muse Spark and SAM 3.1. The built-in manual and default results
are synthetic fixtures. No real Meta call, physical assembly accuracy, phone camera,
Expo Go on SDK 58, or deployed HTTPS has been qualified.

## Run fixtures

```sh
npm ci
# Requires Gitleaks installed locally.
git config --local core.hooksPath .githooks

# Terminal 1: API, no Meta key needed.
API_SHARED_SECRET=truebuild-fixture-demo PROVIDER_MODE=fixture npm run dev:api

# Terminal 2: Expo browser development using the same phone UI.
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 EXPO_PUBLIC_API_SECRET=truebuild-fixture-demo EXPO_PUBLIC_PROVIDER_MODE=fixture npm run dev:web
```

For a phone on the same LAN, replace the API address with your computer's LAN address
and run `npm run start --workspace @truebuild/app` with those same public variables.
The API binds `0.0.0.0`; Expo's phone start uses LAN discovery. This is source-ready,
not a device test. Production app builds require an HTTPS API.

Use the sample manual or photograph a manual. Inspect and confirm the read-only facts;
unknown critical facts block confirmation. A new step, manual or photo clears old
results. The current manual camera action submits one page per parse. The API and
Gate 1 accept up to three pages. Native picker/manipulator cache files may remain on
the device; the app does not promise to delete them. Manuals are not saved across restarts.

## API contract

- Base URL: `EXPO_PUBLIC_API_BASE_URL`. HTTPS is supported; loopback/LAN HTTP is development-only.
- Header: `x-truebuild-key`, checked against server `API_SHARED_SECRET` before body reads.
- App value: `EXPO_PUBLIC_API_SECRET`. This is public demo configuration shipped in the bundle, not production authentication or a Meta credential.
- Public mode: `EXPO_PUBLIC_PROVIDER_MODE=fixture` (default) or `meta`. The existing wire value for live multipart calls remains `model`.
- Routes: `POST /api/manuals/parse`, `/api/checks`, `/api/questions`, `/api/segments`; `GET /api/session`, `/api/health`, and `/health`.
- Fixture calls use JSON; live calls use multipart. Responses retain request/binding identities. Successful fixture values carry simulated labels.
- Step checks submit one or two cited manual pages plus one observation. Legacy session metadata remains for compatibility; no owner-token workflow remains.

App start commands disable dotenv loading. Supply only public app variables in its shell.
Never put `MODEL_API_KEY` in an `EXPO_PUBLIC_*` variable.

## Meta setup and gates

Copy `.env.example` to local `.env`, set `PROVIDER_MODE=meta`, `MODEL_API_KEY` and
`API_SHARED_SECRET`, then run `npm run start:api`. Root API commands load that local
file. Set the app's public mode to `meta` and its demo shared key to the matching value.
Keep provider credentials in the server environment only.

Prepare a local manifest under ignored `uploads/` with manual photos, independently
reviewed expected facts, an observation, and the expected decision. Gate 2 also needs
a short H.264 MP4/MOV clip. `npm run gate:1 -- --help` describes the manifest.

```sh
npm run gate:1 -- --manifest uploads/gate.json --dispatch --confirm-critical-facts --review
npm run gate:2 -- --manifest uploads/gate.json --dispatch --confirm-critical-facts
npm run gate:3 -- --manifest uploads/gate.json --dispatch --confirm-critical-facts
```

The scripts refuse without a local key. Gate 1 grades about ten steps through human
review; structural matching alone is not semantic accuracy. Gate 2 reports latency
and ID consistency, which does not establish physical object identity. Gate 3 measures
one check against 8 seconds. A larger manual can select the relevant 1–2 cited pages
with `sourcePageIds`; that result does not qualify a full-manual request. Results append
only aggregates to local, uncommitted `docs/gate-results.md`. No real gates have run.

## Deploy the API

```sh
npm run build:api
# Build context is the repository root.
docker build -f api/Dockerfile -t truebuild-api .
```

Run the container behind HTTPS. Set `PROVIDER_MODE`, server-only `MODEL_API_KEY`,
`API_SHARED_SECRET`, and `PORT` through the hosting platform. Add the exact deployed
browser origin to `CORS_ORIGINS`; native requests need no browser Origin. Health is at
`/health`. Fixture mode is the default and never reads the model key or calls Meta.

`MODEL_CALL_LIMIT` defaults to 200 admitted attempts per process; restart resets it.
It is not a monetary budget. `CHECK_TIMEOUT_MS` defaults to 8000 and accepts 1–8000.
There are no automatic retries. Timing logs contain duration only. Container deployment
and clip processing remain unqualified: the current clip adapter requires ffprobe and
ffmpeg 8.0.1 at macOS Homebrew paths. Frozen-image SAM does not use those tools.

## Checks and recovery

```sh
npm run typecheck
npm test
npm run test:e2e
npm run lint
npm run format:check
npm run smoke:api
```

Browser checks start fixture servers without loading `.env`. They are browser evidence,
not native or real-model qualification. The pre-commit hook runs redacted Gitleaks on
staged changes; it is local and bypassable. Review staged paths. Only this root README
is published; plans, research, security notes, captures and gate results stay local.
The old editors, persistence, owner ledger and evaluator are recoverable at `pre-descope`.
