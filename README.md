# TrueBuild

TrueBuild turns a photographed assembly manual into steps you can follow. Snap the manual pages,
check the parts and steps it pulled out, then follow a guide with 3D pieces and a short 3D motion
for each step. Photograph your build to check the current step, or ask a question about it.
A check returns **pass**, **refuse**, or **cannot verify** when the photo doesn't show enough.
Always compare AI output with the original manual.

- **Backend:** https://truebuild-suhsi.sevalla.app
- **Health:** https://truebuild-suhsi.sevalla.app/health
- **Privacy:** https://truebuild-suhsi.sevalla.app/privacy
- **TestFlight:** [Join the TestFlight beta](https://testflight.apple.com/join/WyxEtK4u)
- **Demo video:** [Watch the demo on YouTube](https://youtu.be/Lkzun9TevNg)

Built for the Meta hackathon with Meta's Muse Spark, Muse Wonder and SAM models through the Meta API.

## Contents

1. [What it does](#what-it-does)
2. [Meta models used](#meta-models-used)
3. [Stack](#stack)
4. [Prerequisites](#prerequisites)
5. [Setup](#setup)
6. [Environment variables](#environment-variables)
7. [Run with no key (fixture mode)](#run-with-no-key-fixture-mode)
8. [Run with a Meta API key](#run-with-a-meta-api-key)
9. [Sample images](#sample-images)
10. [Checks and tests](#checks-and-tests)
11. [Known limitations](#known-limitations)
12. [Production over-the-air updates](#production-over-the-air-updates)
13. [License](#license)

## What it does

1. **Read the manual.** Photograph up to eight manual pages, or pick them from your library. You
   agree to the AI data notice before anything is sent. The server pulls out the parts list and
   the steps.
2. **Review.** Check the extracted parts and steps against the manual, then start the build.
3. **Follow the guide.** Each step has a guide page, rotatable 3D pieces (drag to rotate, pinch to
   zoom) and, where the model's scene passes the server's checks, a short 3D motion of the step.
   If a motion scene fails those checks, the app shows the manual picture instead.
4. **Check your build.** Take a photo and ask for a check. The answer is pass, refuse or cannot
   verify, with a short reason. Parts the model can find are outlined on the photo. You can also
   ask a question about the step.

## Meta models used

These are the roles wired up in the server code, not claims about accuracy:

| Model | What it does in TrueBuild |
| --- | --- |
| **Muse Spark** (`muse-spark-1.3`) | Reads manual pages (default parser), judges build photos (pass / refuse / cannot verify), answers questions, and writes the generated screens outside the guides. |
| **Muse Wonder** (`muse-wonder-1.0`) | Writes guide pages, 3D piece geometry and the 3D step-motion scenes; also the grounded overlay stage and, when enabled, the second-opinion check. It can be picked as the parser with `MODEL_PARSE`. |
| **SAM 3.1** (`sam-3.1`) | After a check, finds and outlines named parts on your build photo (masks and boxes shown on the result). Turned off by `MODEL_SEGMENTS=0` or `GENERATIVE_UI=off`. |

A second opinion only runs after a `cannot_verify` verdict and can never turn it into a pass. It is
off when `MODEL_SECOND_OPINION` is empty, which is the default in `.env.example`.

Where to look: [stage policy](api/src/server/ai-policy.ts),
[Meta provider](api/src/providers/meta-provider.ts), [SAM provider](api/src/providers/sam.ts),
[step motion](api/src/server/step-motion.ts) and [runtime config](api/src/server/model-runtime.ts).
Model calls stay on the server. The app never sees the Meta API key.

### Generated guides, with a fallback

Models return structured UI documents, not code. The server checks their structure, that they
match the manual, and that guides are complete. Some bad answers get one repair try; anything
still rejected falls back to a plain document built from checked material, and keeps its
fallback label. Production uses **steps** mode (generated guide pages, built-in screens
elsewhere); `full` and `off` also exist. 3D pieces use a fixed set of shapes (box, cylinder,
cone, sphere, torus, capsule, lathe and extrude), drawn by the app's own Three.js viewer.

## Stack

- **App** (`app/`): Expo / React Native with Expo Router, TypeScript. Camera capture, local
  storage of manuals and progress, guide rendering, and a Three.js viewer through `expo-gl`.
  Runs on iOS and on the web for development.
- **API** (`api/`): Hono on Node 24, TypeScript. Checks uploads, calls Meta's Responses API,
  validates results, and applies per-client and global limits. Uses `ffmpeg`/`ffprobe` from
  `PATH` for media handling.
- **Contracts** (`packages/contracts/`): shared Zod schemas for requests, results, UI documents
  and geometry.
- **Tests:** Vitest (API and contracts), Jest (app), Playwright (end to end).
- **Deploy:** the API runs on Sevalla from `api/Dockerfile`; the iOS app ships through EAS
  (TestFlight builds and over-the-air updates).
- **Streaming:** manual parsing streams progress and a final result over SSE; SAM streams its
  events. Comment keepalives every 15 s keep idle streams open.

Manual pages and photos pass through server memory to Meta's models. Meta processes and keeps them
under its own terms. TrueBuild has no accounts, ads or analytics; short-lived IP counters limit
abuse.

## Prerequisites

- **Node.js 24** (the root `package.json` requires `>=24.0.0 <25`) and the npm that ships with it.
- **Git.**
- **ffmpeg and ffprobe** on `PATH`, only for live media handling (not needed for fixture mode or
  the unit tests).
- **A Meta API key**, only for live mode. Fixture mode and the tests need no key.
- For the iOS app on a device: Xcode or an EAS account with access to the project. Not needed for
  the web app.

## Setup

```sh
git clone https://github.com/pmusole2/truebuild.git
cd truebuild
node -v          # must print v24.x
npm ci           # installs all three workspaces
npm run typecheck
```

## Environment variables

Every variable lives in [`.env.example`](.env.example) with a short comment. Copy it to `.env`
for live mode. `.env` is gitignored; never commit it. `.env.example` has no real keys.

**API server (`.env`):** `PROVIDER_MODE`, `MODEL_API_KEY`, `API_SHARED_SECRET`, `PORT`,
`MODEL_SPARK`, `MODEL_PARSE`, `MODEL_SECOND_OPINION`, `MODEL_SAM`, `MODEL_CHECK_CONTEXT`,
`MODEL_LAYOUT`, `MODEL_LAYOUT_WONDER`, `MODEL_CALL_LIMIT_PER_DAY`,
`MODEL_CALL_LIMIT_PER_CLIENT_DAY`, `PARSE_LIMIT_PER_HOUR`, `CHECK_TIMEOUT_MS`, `CORS_ORIGINS`,
`STEP_MOTION_ENABLED`, `STEP_MOTION_DAILY_LIMIT`, plus the optional tuning names at the end of
`.env.example` (`GENERATIVE_UI`, `MODEL_SEGMENTS`, concurrency, `FFMPEG_PATH`/`FFPROBE_PATH` and
per-stage `AI_MODEL_*`, `AI_EFFORT_*`, `AI_DEADLINE_*_MS`, `AI_MAX_OUTPUT_*`).

Only two are secrets: `MODEL_API_KEY` (your Meta key) and `API_SHARED_SECRET` (any long random
string you pick).

**App (Expo, read at build time):** `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_API_SECRET`,
`EXPO_PUBLIC_PROVIDER_MODE`, `EXPO_PUBLIC_GENERATIVE_UI`. Other `EXPO_PUBLIC_*` flags are test and
fixture switches that production builds reject. `EXPO_PUBLIC_API_SECRET` ends up in the app
bundle, so it is a shared demo access key, not a Meta credential or user login.

## Run with no key (fixture mode)

This runs the whole app against synthetic answers. No Meta key, no model calls, no cost. It does
not show real model quality or native camera behaviour.

Terminal 1, the fixture API (it never builds a live provider and only runs on port 3101):

```sh
PROVIDER_MODE=fixture PORT=3101 GENERATIVE_UI=steps \
  node --import tsx api/scripts/fixture-server.ts
```

It prints `Fixture API:127.0.0.1:3101; synthetic inputs and documents; no inference`. Check it:

```sh
curl http://127.0.0.1:3101/health
# {"status":"ok","fixture":"available","live":"unconfigured","label":"Demo data — simulated results"}
curl -H 'x-truebuild-key: truebuild-fixture-demo' http://127.0.0.1:3101/api/session
# {"status":"ok",...,"providerMode":"fixture",...}
```

Terminal 2, the web app:

```sh
cd app
EXPO_NO_DOTENV=1 \
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3101 \
EXPO_PUBLIC_API_SECRET=truebuild-fixture-demo \
EXPO_PUBLIC_PROVIDER_MODE=fixture \
EXPO_PUBLIC_GENERATIVE_UI=steps \
EXPO_PUBLIC_AI_EFFORT_PROOF=1 \
npm run web -- --localhost --port 8091
```

Open http://localhost:8091. The home screen says "Your manuals" and "Add your first manual".
Add any image as a manual page (for example one from [`samples/`](#sample-images)); the fixture
API answers with a synthetic manual whatever the image shows.

`truebuild-fixture-demo` is a public test key for fixture mode only. Production builds reject
fixture flags.

Other fixture scenarios, set with `TRUEBUILD_FIXTURE_SCENARIO` on the fixture API: `full`
(default), `all-pass`, `no-overlay`, `no-mask`, `parse-unavailable`, `check-unavailable`,
`overlay-unavailable`.

## Run with a Meta API key

```sh
cp .env.example .env
# set MODEL_API_KEY (your Meta key) and API_SHARED_SECRET (any long random string)
npm run doctor      # optional: one GET to https://api.meta.ai/v1/models, no inference
npm run start:api   # listens on PORT (3001 by default)
```

Then start the app against it with the same shared secret:

```sh
cd app
EXPO_NO_DOTENV=1 \
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 \
EXPO_PUBLIC_API_SECRET=<your API_SHARED_SECRET> \
EXPO_PUBLIC_PROVIDER_MODE=meta \
EXPO_PUBLIC_GENERATIVE_UI=steps \
npm run web -- --localhost --port 8091
```

Live mode sends your pages and photos to Meta and uses your key's quota. The per-day call limits
in `.env.example` cap spend on a running server.

## Sample images

Small test images Prince used while building TrueBuild, committed so anyone can try the flow:

| File | What it is |
| --- | --- |
| `samples/treadmill/manual-p3.jpg` … `manual-p6.jpg` | Photos of a folding walking-pad treadmill manual, pages 3-6. Steps are on pages 5-6: place flat, raise the handrail and fix it with two knobs, fit the phone support with two screws. |
| `samples/drone/manual-p1.jpg` … `manual-p4.jpg` | Photos of a kids' 3-in-1 mini drone manual, pages 1-4 (fan blades and battery). Resized to 1600 px. |

In fixture mode any image gets a synthetic answer. In live mode these give real model output.

## Checks and tests

```sh
npm run typecheck
npx vitest run api/src packages/contracts/src   # API + contracts unit tests
npm run lint
npm run format:check
npm run test:e2e                                 # Playwright, starts its own fixture/mock servers
```

These use fixtures and mocks and need no key. `npm run test:ui` (the app's Jest suite, also part
of `npm test`) is slow; it can take over 10 minutes.

`gate-check/truebuild-gate-check/` holds early smoke scripts that confirmed Meta API access. Unlike
everything above, they make **live, billable** calls and need `MODEL_API_KEY`.

## Known limitations

- **AI output can be wrong.** Parsing, checks and answers come from models. Always compare with
  the paper manual. A check says cannot verify rather than guess, so clear photos can still get
  "Can't tell".
- **3D step motion is best effort.** Scenes that fail the server's quality checks fall back to the
  manual picture, and some steps may show no motion.
- **Fixture mode is synthetic.** It shows the flow, not model quality, and it ignores what your
  images show.
- **Web is for development.** The real camera flow is the iOS app (TestFlight). The web build is
  for trying the flow and for tests.
- **Limits reset on restart.** Rate limits and counters live in server memory (UTC windows).
- **No accounts or sync.** Manuals and progress stay on the device.
- **Up to eight pages per parse.**
- **The shared app key is public.** `EXPO_PUBLIC_API_SECRET` is visible in the app bundle; it
  limits casual use, it is not real auth.

## Production over-the-air updates

`npm run ota:production --workspace @truebuild/app` publishes JavaScript and asset changes to the
`production` EAS Update channel. It needs the EAS CLI and an EAS login with access to the project.
The `production` EAS environment must set `EXPO_PUBLIC_API_BASE_URL` to the Sevalla origin,
`EXPO_PUBLIC_PROVIDER_MODE=meta` and `EXPO_PUBLIC_GENERATIVE_UI=steps`. The export checks these
and refuses fixture or test flags before it bundles anything. Native changes and app `version`
changes need a new store build (`runtimeVersion` policy `appVersion`).

## License

[MIT](LICENSE) © 2026 Prince Musole
