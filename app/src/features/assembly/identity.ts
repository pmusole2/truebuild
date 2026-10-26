import * as Crypto from 'expo-crypto'

// Uniqueness, not secrecy, is the requirement. A generator that returns no string must never repeat a value.
function uniqueSuffix(): string {
    const value: unknown = Crypto.randomUUID()
    if (typeof value === 'string' && value.length > 0) {
        return value
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Identities are unique across screen mounts, reloads and steps. A component-local counter would restart at 1 and
 * collide with the run ledger's duplicate rule for a legitimate second action.
 */
export function freshRequestId(kind: 'check' | 'question' | 'locate' | 'extract'): string {
    return `${kind}-${uniqueSuffix()}`
}

/** A new physical observation, retake or correction recheck always gets a new capture identity. */
export function freshCaptureId(): string {
    return `capture-${uniqueSuffix()}`
}
