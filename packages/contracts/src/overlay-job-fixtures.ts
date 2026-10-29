/**
 * Input/output fixtures of the overlay job (`POST /api/checks/overlay`, `/result`, `/cancel`) for native and app tests.
 * Pure data, synthetic: they carry no photo, no one-use token value that works anywhere, and no model claim beyond a
 * labeled synthetic fixture. The server's own tests assert that the real routes emit exactly these shapes
 * (`overlay-pending.test.ts`), so a client built against them cannot drift from the API.
 *
 * Client rules the fixtures encode: send the original request once; on 202 poll `/result` with the ORIGINAL
 * `requestId` and capture `binding` plus the ticket (never resend the photo or the token); a 200 `unavailable`
 * (timeout or failure) is final and never affects the verdict; a late 200 ok is still collected unless the capture is
 * stale (then discard it); a repeated original request is refused before dispatch.
 */
const binding = {
    kind: 'capture',
    manualId: 'fixture-manual',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
} as const
const identity = { requestId: 'overlay-fixture-1', binding } as const
const ticket = 'fixture-ticket-1'

const overlay = {
    evidence: 'synthetic-fixture',
    observedRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.6 },
} as const

export const OVERLAY_JOB_IO_FIXTURES = {
    /** Answered within the sync wait: 200 with the published overlay. */
    success: {
        responses: [{ status: 200, body: { status: 'ok', mode: 'fixture', ...identity, value: overlay } }],
    },
    /** Slower than the sync wait: 202 ticket, then the late answer is collected by `/result`. */
    late: {
        responses: [
            {
                status: 202,
                body: { status: 'pending', ...identity, ticket, retryAfterMs: 1_500, expiresInMs: 55_000 },
            },
            {
                status: 202,
                body: { status: 'pending', ...identity, ticket, retryAfterMs: 1_500, expiresInMs: 50_000 },
            },
            { status: 200, body: { status: 'ok', mode: 'fixture', ...identity, value: overlay } },
        ],
    },
    /** The overlay budget ended: collected as a 200 `unavailable` (never a 504). The verdict is unaffected. */
    timeout: {
        responses: [
            { status: 202, body: { status: 'pending', ...identity, ticket, retryAfterMs: 1_500, expiresInMs: 55_000 } },
            {
                status: 200,
                body: { status: 'unavailable', ...identity, code: 'timeout', retryable: false },
            },
        ],
    },
    /** The same original request again: refused before any dispatch, no second ticket. */
    replay: {
        responses: [
            {
                status: 409,
                body: { status: 'unavailable', ...identity, code: 'duplicate_request', retryable: false },
            },
        ],
    },
    /** A newer manual revision was already seen: refused before any dispatch. */
    stale: {
        responses: [
            {
                status: 409,
                body: { status: 'unavailable', ...identity, code: 'invalid_input', retryable: false },
            },
        ],
    },
    /** `/cancel` of a known job. */
    cancelled: { responses: [{ status: 204, body: null }] },
} as const

export type OverlayJobScenario = keyof typeof OVERLAY_JOB_IO_FIXTURES
