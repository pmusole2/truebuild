let sequence = 0
export const NATIVE_CHECKPOINT_LOG_VERSION = 1
export const NATIVE_CHECKPOINT_LOG_MAX_BYTES = 700
const countKeys = new Set(['counts', 'rawTextCounts', 'strictCounts', 'strictRawTextCounts'])
const hostKeys = new Set(['byHostType', 'strictByHostType'])
const duplicateSessionKeys = new Set(['methods', 'routes', 'byHostType', 'strictByHostType'])
const origins = ['generated', 'fallback', 'shell', 'total'] as const
const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Only log transport loses these redundant running session details; the meter and Judge retain their full session. */
export function nativeCheckpointLogRecord(record: Record<string, unknown>): Record<string, unknown> {
    if (record.event !== 'render_origin_checkpoint' || record.logVersion !== undefined)
        throw new Error('invalid-checkpoint')
    if (!object(record.session)) return { ...record }
    return {
        ...record,
        session: Object.fromEntries(Object.entries(record.session).filter(([key]) => !duplicateSessionKeys.has(key))),
    }
}

function countTuple(value: unknown, wire: boolean): [number, number, number, number] {
    if (!wire && (!object(value) || Object.keys(value).length !== 4 || !origins.every((key) => key in value)))
        throw new Error('invalid-count-object')
    const tuple = wire ? value : origins.map((key) => (value as Record<string, unknown>)[key])
    if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        !tuple.every(integer) ||
        tuple[0]! + tuple[1]! + tuple[2]! !== tuple[3]
    )
        throw new Error('invalid-count-tuple')
    return tuple as [number, number, number, number]
}
function transform(value: unknown, decode: boolean, wire: boolean): unknown {
    if (Array.isArray(value)) return value.map((child) => transform(child, decode, wire))
    if (!object(value)) return value
    const convert = (counts: unknown, nullable = true): unknown => {
        if (counts === null && nullable) return null
        const tuple = countTuple(counts, wire)
        return decode ? Object.fromEntries(origins.map((key, index) => [key, tuple[index]])) : tuple
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, child]): [string, unknown] => {
            if (countKeys.has(key)) return [key, convert(child)]
            if (hostKeys.has(key) && child !== null) {
                if (!object(child)) throw new Error('invalid-host-counts')
                return [
                    key,
                    Object.fromEntries(Object.entries(child).map(([type, counts]) => [type, convert(counts, false)])),
                ]
            }
            return [key, transform(child, decode, wire)]
        }),
    )
}

/** v1 changes count representation only; each count remains an exact nonnegative integer, never a default. */
export function encodeNativeCheckpoint(record: Record<string, unknown>): Record<string, unknown> {
    const canonical = nativeCheckpointLogRecord(record)
    return {
        event: canonical.event,
        logVersion: NATIVE_CHECKPOINT_LOG_VERSION,
        ...(transform(canonical, false, false) as Record<string, unknown>),
    }
}
export function decodeNativeCheckpoint(value: unknown): Record<string, unknown> {
    if (!object(value) || value.event !== 'render_origin_checkpoint') throw new Error('invalid-checkpoint')
    if (value.logVersion !== undefined && value.logVersion !== NATIVE_CHECKPOINT_LOG_VERSION)
        throw new Error('unsupported-log-version')
    const { logVersion, ...record } = value
    return transform(record, true, logVersion === NATIVE_CHECKPOINT_LOG_VERSION) as Record<string, unknown>
}

function utf8(value: string, byte: (value: number) => void): void {
    for (const char of value) {
        const code = char.codePointAt(0)!
        if (code < 0x80) byte(code)
        else if (code < 0x800) {
            byte(0xc0 | (code >> 6))
            byte(0x80 | (code & 0x3f))
        } else if (code < 0x10000) {
            byte(0xe0 | (code >> 12))
            byte(0x80 | ((code >> 6) & 0x3f))
            byte(0x80 | (code & 0x3f))
        } else {
            byte(0xf0 | (code >> 18))
            byte(0x80 | ((code >> 12) & 0x3f))
            byte(0x80 | ((code >> 6) & 0x3f))
            byte(0x80 | (code & 0x3f))
        }
    }
}
function byteLength(value: string): number {
    let bytes = 0
    utf8(value, () => {
        bytes++
    })
    return bytes
}
/** Adler32 detects transport damage; it is not an authenticity/security boundary. */
function checksum(value: string): string {
    let a = 1,
        b = 0
    utf8(value, (byte) => {
        a = (a + byte) % 65521
        b = (b + a) % 65521
    })
    return (((b << 16) | a) >>> 0).toString(16).padStart(8, '0')
}

/** No oversized duplicate: fragmentation is the only emission when the exact encoded record exceeds the line cap. */
export function logNativeCheckpoint(record: Record<string, unknown>, log: (line: string) => void = console.info): void {
    const value = JSON.stringify(encodeNativeCheckpoint(record))
    const bytes = byteLength(value)
    if (bytes <= NATIVE_CHECKPOINT_LOG_MAX_BYTES) {
        log(value)
        return
    }
    const id = ++sequence,
        digest = checksum(value)
    const fragment = (data: string, index: number, total: number): string =>
        JSON.stringify({
            event: 'render_origin_fragment',
            logVersion: NATIVE_CHECKPOINT_LOG_VERSION,
            id,
            index,
            total,
            bytes,
            checksum: digest,
            data,
        })
    // Reserve the maximum index/total width before splitting, so the final escaped JSON envelope always fits.
    const budget =
        NATIVE_CHECKPOINT_LOG_MAX_BYTES - byteLength(fragment('', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
    const parts: string[] = []
    let data = '',
        size = 0
    for (const char of value) {
        const extra = byteLength(JSON.stringify(char)) - 2
        if (size + extra > budget) {
            parts.push(data)
            data = ''
            size = 0
        }
        data += char
        size += extra
    }
    if (data !== '') parts.push(data)
    parts.forEach((part, index) => log(fragment(part, index, parts.length)))
}

type FragmentGroup = {
    total: number
    logVersion: unknown
    bytes: unknown
    checksum: unknown
    parts: Map<number, string>
}
/** Offline/test console adapter. Any invalid/incomplete recognized record throws; no partial measurement is returned. */
export function decodeNativeCheckpointLines(lines: readonly string[]): readonly Record<string, unknown>[] {
    const groups = new Map<number, FragmentGroup>(),
        records: Record<string, unknown>[] = []
    let lastFragmentRecord: string | null = null
    for (const line of lines) {
        const start = line.indexOf('{"event":"render_origin_')
        if (start < 0) continue
        const value: unknown = JSON.parse(line.slice(start))
        if (!object(value)) throw new Error('invalid-log-record')
        if (value.event === 'render_origin_checkpoint') {
            const decoded = decodeNativeCheckpoint(value)
            if (JSON.stringify(decoded) !== lastFragmentRecord) records.push(decoded)
            lastFragmentRecord = null
            continue
        }
        if (value.event !== 'render_origin_fragment') throw new Error('unknown-log-event')
        const { id, index, total, data, logVersion, bytes, checksum: digest } = value
        if (
            !integer(id) ||
            !integer(index) ||
            !integer(total) ||
            total < 1 ||
            index >= total ||
            typeof data !== 'string'
        )
            throw new Error('invalid-fragment')
        if (logVersion !== undefined && logVersion !== NATIVE_CHECKPOINT_LOG_VERSION)
            throw new Error('unsupported-log-version')
        if (
            logVersion === NATIVE_CHECKPOINT_LOG_VERSION &&
            (!integer(bytes) || typeof digest !== 'string' || !/^[0-9a-f]{8}$/u.test(digest))
        )
            throw new Error('invalid-fragment-integrity')
        const group = groups.get(id) ?? { total, logVersion, bytes, checksum: digest, parts: new Map<number, string>() }
        if (
            group.total !== total ||
            group.logVersion !== logVersion ||
            group.bytes !== bytes ||
            group.checksum !== digest
        )
            throw new Error('conflicting-fragment-metadata')
        const prior = group.parts.get(index)
        if (prior !== undefined && prior !== data) throw new Error('conflicting-fragment-data')
        group.parts.set(index, data)
        groups.set(id, group)
        if (group.parts.size !== total) continue
        const joined = Array.from({ length: total }, (_, i) => group.parts.get(i)!).join('')
        if (
            logVersion === NATIVE_CHECKPOINT_LOG_VERSION &&
            (byteLength(joined) !== bytes || checksum(joined) !== digest)
        )
            throw new Error('fragment-integrity-mismatch')
        const parsed: unknown = JSON.parse(joined)
        if (!object(parsed) || parsed.logVersion !== logVersion) throw new Error('fragment-payload-version-mismatch')
        const decoded = decodeNativeCheckpoint(parsed)
        records.push(decoded)
        lastFragmentRecord = JSON.stringify(decoded)
        groups.delete(id)
    }
    if (groups.size !== 0) throw new Error('incomplete-fragments')
    return records
}
