# TrueBuild

A phone flat-pack camera guide. Photograph a manual, build a step plan from it, then photograph the assembly at a chosen step and get `pass`, `refuse` (with the reason and manual diagram) or `cannot_verify`. Ask a question about the photo, or localize parts in one frozen photo with SAM.

## Run the app

- Web (localhost): `npm run web --workspace @truebuild/app`, then open `http://localhost:8081`.
- Phone (Expo Go on the same LAN; not device-qualified yet): `npm run start --workspace @truebuild/app` shows a LAN QR code. Set the public variables in your shell first, using your computer's LAN address for the API, for example `EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3001 EXPO_PUBLIC_API_SECRET=<demo key> npm run start --workspace @truebuild/app`.
- The start scripts set `EXPO_NO_DOTENV=1`, so a `.env` file is **not** loaded by the app. Export `EXPO_PUBLIC_*` values in the shell (or pass them explicitly at launch). Never put a Meta key in an `EXPO_PUBLIC_` variable.

### Local fixture environment (no model, no Meta key)

Equivalent to what `npm run test:e2e` uses. The demo key below is synthetic and public; it is not a credential.

```sh
# API (Next today, Hono after migration)
API_SHARED_SECRET=truebuild-fixture-demo PROVIDER_MODE=fixture TRUEBUILD_ENABLE_MODELS=0 npm run dev:api

# App (web or phone)
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 EXPO_PUBLIC_API_SECRET=truebuild-fixture-demo \
EXPO_PUBLIC_PROVIDER_MODE=fixture EXPO_NO_DOTENV=1 npm run web --workspace @truebuild/app
```

`EXPO_PUBLIC_PROVIDER_MODE` accepts `fixture` (default, simulated results) or `meta` (live backend path, sent to the wire as `model`). Any other value stops the app at startup instead of silently simulating. Plain HTTP is accepted only in a development build for loopback or LAN hosts; a production build requires HTTPS.

Fixture mode needs no `MODEL_API_KEY`, and it does not disable the shared-key check: the server still expects `x-truebuild-key`. Known gap: the current Next API does not yet allow `x-truebuild-key` in CORS preflight, so a browser cannot send it to that API until the CORS bridge lands. Until then the Playwright run with the header fails at preflight; the same UI flows pass when the app is started without the header.

## API contract

- Base URL: `EXPO_PUBLIC_API_BASE_URL`. Fixture mode is the default and needs no key. HTTPS is allowed; plain HTTP is for LAN development only. Loopback is not hardcoded.
- Auth: the app sends `x-truebuild-key`. The server checks it against `API_SHARED_SECRET`.
- `EXPO_PUBLIC_API_SECRET` is a PUBLIC demo-only shared key. It ships inside the app bundle, so it is never a Meta credential and must not be treated as one.
- Meta credentials stay server-side only (`MODEL_API_KEY`). Never add an `EXPO_PUBLIC_` prefix to them.
- Routes (unchanged): `POST /api/manuals/parse`, `POST /api/checks`, `POST /api/questions`, `POST /api/segments`, `GET /api/session`, `GET /api/health`. The Hono migration keeps these paths and adds `GET /health`.
- Fixture requests are JSON and return `mode: "fixture"`. Model requests are multipart and return `mode: "model"`. Every response carries an explicit simulated label in fixture mode.

The software can be developed and exercised before the physical kit arrives. The built-in demo and browser fixtures are synthetic. Real Meta access, phone execution, and physical assembly accuracy still need qualification.

Runtime AI uses only Meta models: Muse Spark and SAM 3.1.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:ui
npm run test:e2e
```

Browser checks start and stop their own local servers with the fixture environment above. The sample manual is an original synthetic fixture, not a real manual, and nothing here is physically qualified. Native camera, permissions and Expo Go behaviour are unverified.

## Local Git safeguards

Enable the pre-commit secret guard in each clone (requires Gitleaks):

```sh
git config --local core.hooksPath .githooks
```

The hook runs `gitleaks` on staged changes only, fails closed when the scanner or config is missing, and redacts findings. `--no-verify` skips it locally; nothing is enforced remotely.

