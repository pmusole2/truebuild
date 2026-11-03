# TrueBuild

TrueBuild turns a photographed assembly manual into steps you can follow. Review the extracted
plan, open a guide with rotatable 3D pieces, then photograph your build to check the current step
or ask a question. Checks return **pass**, **refuse**, or **cannot verify** when the image does
not provide enough evidence. Review AI output against the original manual.

- **Backend:** https://truebuild-suhsi.sevalla.app
- **Health:** https://truebuild-suhsi.sevalla.app/health
- **Privacy:** https://truebuild-suhsi.sevalla.app/privacy
- **TestFlight:** `<TestFlight public link>`
- **Demo video:** `<demo video link>`

Built for the Meta hackathon with Meta's Muse Spark, Muse Wonder and SAM models through the Meta API.

## Try the flow

1. Photograph manual pages or choose them from your library. Agree to the AI data disclosure
   before sending anything. Each parse accepts up to eight pages.
2. Review the extracted parts and steps against the manual, then start the build.
3. Open a guide. Drag its 3D pieces to rotate them and pinch to zoom.
4. Take a photo of your assembly and request a check. Read the result and any explanation;
   unclear evidence stays uncertain. You can also ask a question about that step.

## How Meta's models are used

These are the roles implemented in the server, rather than claims about model accuracy:

| Model                               | Role in TrueBuild                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Muse Spark** (`muse-spark-1.3`)   | Default manual parsing, photo-check verdicts, questions, and generated screens outside the guides.                                                                                                                                  |
| **Muse Wonder** (`muse-wonder-1.0`) | Guide documents, constrained 3D primitive geometry, and a separate grounded-overlay stage. It can also be selected for parsing.                                                                                                     |
| **SAM 3.1** (`sam-3.1`)             | A separate segmentation stage that searches for parts in an image.                                                                                                                                                                  |
| **Second opinion**                  | After a `cannot_verify` verdict, an enabled follow-up uses Wonder by default. It cannot turn an uncertain primary verdict into a pass. An empty `MODEL_SECOND_OPINION` or `off` disables it; the example environment leaves it off. |

See [the stage policy](api/src/server/ai-policy.ts),
[provider](api/src/providers/meta-provider.ts), and
[runtime](api/src/server/model-runtime.ts). Model requests stay on the server. The app never
receives the Meta API key.

## Generated guides, with a fallback

Models return structured UI documents rather than executable code. The server checks their
structure, manual grounding, and guide completeness. Some completed but invalid proposals receive
one repair attempt; rejected or unavailable output falls back to a deterministic document built
from validated material. Fallback documents retain their fallback label.

The production app uses **steps** mode: guide documents are generated, while the other screens
use the built-in composition. The code also supports `full` and `off` modes. Piece geometry uses
a bounded vocabulary of boxes, cylinders, cones, spheres, toruses, and capsules, plus lathe
(revolved profile) and extrude (flat outline) parts, rendered by the app's own 3D viewer.

## Architecture

- **Expo / React Native app** in `app/`: camera capture, local manual/progress storage, guide
  rendering, and a Three.js viewer through `expo-gl`.
- **Hono API on Node 24** in `api/`: validates uploads, calls Meta's Responses API, validates
  results, and applies per-client and global limits.
- **Shared Zod contracts** in `packages/contracts/`: typed requests, results, UI documents,
  and geometry.
- **Deployment**: the API runs on Sevalla from `api/Dockerfile`; the iOS app ships through EAS
  (TestFlight builds and over-the-air updates).
- **SSE streaming**: manual parsing sends progress and a final result; segmentation streams its
  events. Fifteen-second comment keepalives keep idle streams active.

Manual pages and photos pass through temporary server memory to Meta's models. Meta processes
and retains them under its own terms. TrueBuild has no accounts, ads, or analytics; temporary
IP counters limit abuse. The consent screen links to the public privacy page.

## Run locally with fixtures — no Meta key needed

Use Node 24, then install from the repository root:

```sh
npm ci
```

Start the isolated fixture API in one terminal. It never constructs a live provider:

```sh
PROVIDER_MODE=fixture PORT=3101 GENERATIVE_UI=steps \
  node --import tsx api/scripts/fixture-server.ts
```

Start the development web app in another terminal:

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

Open http://localhost:8091. This explicit developer fixture mode uses synthetic responses and
isolated local storage; it does not establish live-model accuracy or native camera behavior.
The shared fixture key above is public test configuration. Production builds reject fixture flags.

For an API mock that exercises the Meta request protocol without inference, the main Playwright
suite starts `api/scripts/mock-server.ts` with its required `--test-only` flag.

## Run locally with a Meta API key

Copy the example environment and fill in the two empty secrets. The file is gitignored; never
commit it.

```sh
cp .env.example .env
# set MODEL_API_KEY (Meta API key) and API_SHARED_SECRET (any long random string)
npm run doctor      # optional: one GET to https://api.meta.ai/v1/models, no inference
npm run start:api   # listens on PORT (3001 by default)
```

Then start the app against it, using the same shared secret:

```sh
cd app
EXPO_NO_DOTENV=1 \
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 \
EXPO_PUBLIC_API_SECRET=<your API_SHARED_SECRET> \
EXPO_PUBLIC_PROVIDER_MODE=meta \
EXPO_PUBLIC_GENERATIVE_UI=steps \
npm run web -- --localhost --port 8091
```

Live mode sends your manual pages and photos to Meta's API and uses your key's quota. The comments
in [`.env.example`](.env.example) describe every documented setting, including the per-day call
limits.

### Environment variables

API server (`.env`): `PROVIDER_MODE`, `MODEL_API_KEY`, `API_SHARED_SECRET`, `PORT`, `MODEL_SPARK`,
`MODEL_PARSE`, `MODEL_SECOND_OPINION`, `MODEL_SAM`, `MODEL_CHECK_CONTEXT`, `MODEL_LAYOUT`,
`MODEL_LAYOUT_WONDER`, `MODEL_CALL_LIMIT_PER_DAY`, `MODEL_CALL_LIMIT_PER_CLIENT_DAY`,
`PARSE_LIMIT_PER_HOUR`, `CHECK_TIMEOUT_MS`, `CORS_ORIGINS`, and the optional tuning names listed at
the end of `.env.example` (`GENERATIVE_UI`, `MODEL_SEGMENTS`, concurrency, and per-stage
`AI_MODEL_*`, `AI_EFFORT_*`, `AI_DEADLINE_*_MS`, `AI_MAX_OUTPUT_*` overrides).

App (Expo, read at build time): `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_API_SECRET`,
`EXPO_PUBLIC_PROVIDER_MODE`, `EXPO_PUBLIC_GENERATIVE_UI`. Other `EXPO_PUBLIC_*` flags are test and
fixture switches that production builds reject.

## Production over-the-air updates

`npm run ota:production --workspace @truebuild/app` publishes JavaScript and asset changes to the
`production` EAS Update channel. It needs the EAS CLI and an EAS login with access to the project.
The `production` EAS environment must define `EXPO_PUBLIC_API_BASE_URL` as the Sevalla origin,
`EXPO_PUBLIC_PROVIDER_MODE=meta`, and `EXPO_PUBLIC_GENERATIVE_UI=steps`. The export checks these
values, and refuses fixture or test flags, before it bundles anything.

Native module changes, native configuration changes and app `version` changes need a new store build.
Updates target the app version (`runtimeVersion` policy `appVersion`), so an update reaches only
builds with the same version.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:ui
npm run test:e2e
npx playwright test --config playwright.generative.config.ts
TRUEBUILD_E2E_GENERATIVE_UI=off npx playwright test --config playwright.generative.config.ts
```

These checks use fixtures and mocks, and require no model credential. For a live setup, keep
`MODEL_API_KEY` on the API server only. The app's `EXPO_PUBLIC_API_SECRET` is a shared demo access
key visible in its bundle; it is not a Meta credential or user authentication.

`gate-check/truebuild-gate-check/` holds the early standalone smoke scripts used to confirm Meta API
access. Unlike the checks above, they make live, billable calls and need `MODEL_API_KEY`.

## License

[MIT](LICENSE) © 2026 Prince Musole
