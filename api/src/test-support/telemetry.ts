import { expect } from 'vitest'

/**
 * A public result now carries the server-observed telemetry of the one provider call behind it. Existing exact-shape
 * assertions state the rest of the result precisely and only expect that telemetry to be present and well formed
 * (timing and usage are observed values, never fixed numbers, and unreported usage stays null).
 */
export function observed<T extends object>(value: T): T & { telemetry: unknown } {
    return {
        ...value,
        telemetry: expect.objectContaining({
            stage: expect.any(String),
            model: expect.any(String),
            effort: expect.any(String),
            timing: expect.any(Object),
            usage: expect.any(Object),
        }),
    }
}
