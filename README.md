# TrueBuild

A phone flat-pack camera guide. Photograph a manual, build a step plan from it, then photograph the assembly at a chosen step and get `pass`, `refuse` (with the reason and manual diagram) or `cannot_verify`. Ask a question about the photo, or localize parts in one frozen photo with SAM.

## Run the app

- Web (localhost): `npm run web --workspace @truebuild/app`, then open `http://localhost:8081`.
- Phone (Expo Go on the same LAN; not device-qualified yet): `npm run start --workspace @truebuild/app` shows a LAN QR code. Set the public variables in your shell first, using your computer's LAN address for the API, for example `EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3001 EXPO_PUBLIC_API_SECRET=<demo key> npm run start --workspace @truebuild/app`.
- The start scripts set `EXPO_NO_DOTENV=1`, so a `.env` file is **not** loaded by the app. Export `EXPO_PUBLIC_*` values in the shell (or pass them explicitly at launch). Never put a Meta key in an `EXPO_PUBLIC_` variable.

## API contract

- Base URL: `EXPO_PUBLIC_API_BASE_URL`. Fixture mode is the default and needs no key. HTTPS is allowed; plain HTTP is for LAN development only. Loopback is not hardcoded.
- Auth: the app sends `x-truebuild-key`. The server checks it against `API_SHARED_SECRET`.
- `EXPO_PUBLIC_API_SECRET` is a PUBLIC demo-only shared key. It ships inside the app bundle, so it is never a Meta credential and must not be treated as one.
- Meta credentials stay server-side only (`MODEL_API_KEY`). Never add an `EXPO_PUBLIC_` prefix to them.
- Routes (unchanged): `POST /api/manuals/parse`, `POST /api/checks`, `POST /api/questions`, `POST /api/segments`, `GET /api/session`, `GET /api/health`. The Hono migration keeps these paths and adds `GET /health`.
- Fixture requests are JSON and return `mode: "fixture"`. Model requests are multipart and return `mode: "model"`. Every response carries an explicit simulated label in fixture mode.

The software can be developed and exercised before the physical kit arrives. The built-in demo and browser fixtures are synthetic. Real Meta access, phone execution, and physical assembly accuracy still need qualification.

Runtime AI uses only Meta models: Muse Spark and SAM 3.1.

## Run locally

Use Node 24 and npm. From this directory:

```sh
npm ci
npm run dev
```

Open `http://localhost:8081`. The backend binds to `127.0.0.1:3001`. This default starts fixture mode with model calls disabled and needs no key. Open the built-in demo to try wrong, correct and unclear simulated observations. Every simulated result is labelled.

Import JPEG, PNG or WebP manual pages to create a private local manual. Edit the parts and steps, check every critical fact against the page, mark reviewed, and save before opening a step check. Imported pages persist on this browser/device; assembly photos are not added to saved manuals. Native camera and image processing can leave temporary platform cache files; their cleanup remains unqualified. A page diagram is never substituted for a photo of the assembly.

With a connected backend, selected pages can be extracted into a preview, preserved as raw evidence, and explicitly copied to editable draft steps. Human review remains required. Proposed corrections must be confirmed against the manual or discarded. A fresh photo replaces the prior check, answer and localization. SAM boxes describe one frozen photo; continuous tracking and clip capture are not implemented in the UI.

## Enable the protected Meta path

This is a single-process, loopback prototype. It is not exposed for remote phone access or deployment. Keep keys server-side and authorize provider use before sending private pages. Requests use `store: false`; that does not establish zero retention or replace checking provider terms.

1. Copy `.env.example` to `.env` and set `MODEL_API_KEY` locally. Never add an `EXPO_PUBLIC_` prefix or enter the Meta key in the app.
2. Stop the default backend. Run `npm run dev:api:new-run` once to explicitly start a new allowance. Run `npm run dev:web` separately if needed.
3. In **Live backend connection**, keep the local address and paste the **owner session token** from the private `.local/session-token` file. Connect stores it only in memory. **Check session** verifies the local owner session and reports whether a key is configured; it makes no model call and does not prove the key works.
4. Each extraction, check, question or localization requires its own action. There are no automatic model retries. Obtain account access and agree the call allowance before making the first real request.

Use `npm run dev:api:owner` to resume the existing allowance after stopping the owner server. Restart rotates the token and preserves usage. `dev:api:new-run` explicitly starts another allowance; do not use it to recover from an ambiguous request or corrupt ledger. Ctrl+C stops the task-started server.

The default ledger allows 20 requests and reserves 100,000 accounting units per request from a 2,000,000-unit budget. These are conservative internal counters, **not a guaranteed dollar spending limit**. Unknown and failed outcomes retain their reservation. A session expires after 30 minutes. Actual billing and provider access remain separate checks.

## Checks and qualification

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
python3 -B tests/test_git_guard.py
```

Browser checks start and stop their own local servers. Connected browser cases use strict scripted responses and synthetic images; they do not call Meta or measure assembly accuracy.

The metadata-only evaluation runner keeps fixture, tuning and physical held-out rows separate:

```sh
npm run evaluate -- --input .local/evaluation-input.json --output .local/evaluation-summary.json
```

It preserves the input and refuses to overwrite a report unless explicitly requested. Its aggregate gate cannot prove capture provenance, labels, device behavior or model performance. Phone persistence, camera permissions, native streaming, real Meta/SAM behavior, and moving-part tracking remain unqualified. Expo CLI dependency advisories also remain a release/exposure gate; local checks are not a security certification.

## Local Git safeguards

The commit guard requires Python 3.11 or later and Gitleaks. Enable it in each clone:

```sh
git config --local core.hooksPath .githooks
```

Keep publishable project documentation in the normal root `README.md`, which must be a regular file. Other Markdown documents, additional READMEs, agent notes, research, handoffs, and planning/specification documents remain local. Ignore rules exclude the document folders; the commit guard also blocks prohibited indexed paths, including forced additions and staged ignore-rule removal. Named planning/specification artifacts are blocked in text, structured-data, office and spreadsheet formats.

Folders named `doc`, `docs`, `plan`, `plans`, `planning`, `spec`, `specs` or `specifications` are reserved for local documents at every depth. Keep source and automated `.spec.ts` tests outside those folders. Plan/spec-shaped data filenames such as `requirements.txt` and `api.spec.json` are also reserved; changing these rules requires review.

Known personal application draft names are excluded in every file format, along with raw media, the original archive and local secrets. Their originals remain on disk. Keep private captures and raw results under `.local/`; keep the Meta key server-side. `.env.example` contains no credential. The private backend directory requires mode `0700`; token and ledger files require `0600`. Treat manuals and images as untrusted data, never executable instructions, and do not log prompts, images, responses or credentials.

The hook scans every indexed blob using Gitleaks with redacted output, including binary content. It uses the staged scan configuration and fails closed if required tools or configuration are unavailable. Policy-file changes need review. The root README exception does not exempt it from secret scanning.

Local hooks can be bypassed with `--no-verify` or by changing `core.hooksPath`; scanners are heuristic. Nothing is enforced remotely. Ignore rules do not remove already tracked files. The hook scans the index, not history, LFS payloads or submodule content. Review candidate paths and content and run a full-history `gitleaks git` scan before publishing; rotate any credential ever committed. Do not store secrets or raw captures in LFS. Local historical smoke scripts are diagnostics and are not used by the app/backend.

No real model inference, mobile-device qualification, physical accuracy result or deployment is established by the local software checks.
