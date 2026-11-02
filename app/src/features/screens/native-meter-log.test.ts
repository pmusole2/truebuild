import { expect, it } from 'vitest'
import {
    decodeNativeCheckpoint,
    decodeNativeCheckpointLines,
    encodeNativeCheckpoint,
    logNativeCheckpoint,
    nativeCheckpointLogRecord,
} from './native-meter-log'

const counts = (generated = 3, fallback = 2, shell = 1): Record<string, number> => ({
    generated,
    fallback,
    shell,
    total: generated + fallback + shell,
})
const totals = (): Record<string, unknown> => ({
    metricsVersion: 3,
    status: 'measured',
    counts: counts(),
    byHostType: { 'RN:View': counts(2, 2, 0), 'RN:Text': counts(1, 0, 1) },
    rawTextCounts: counts(1, 0, 0),
    generatedShare: 0.5,
    reason: null,
    strictStatus: 'measured',
    strictCounts: counts(2, 2, 1),
    strictByHostType: { 'RN:View': counts(2, 2, 0), 'RN:Text': counts(0, 0, 1) },
    strictRawTextCounts: counts(0, 0, 0),
    strictGeneratedShare: 0.4,
    strictReason: null,
    exclusions: {
        development: { counts: counts(0, 0, 0), rawTextCounts: counts(0, 0, 0) },
        capabilityInternals: { counts: counts(1, 0, 0), rawTextCounts: counts(0, 0, 0) },
        byCapability: { CameraView: { counts: counts(1, 0, 0), rawTextCounts: counts(0, 0, 0) } },
    },
})
const record = (): Record<string, unknown> => {
    const method = {
        ...totals(),
        method: 'focused-visible-native-hosts',
        scope: 'Public committed host census',
        selection: {
            background: { counts: counts(4, 2, 3), rawTextCounts: counts(0, 0, 1) },
            focusedRootCount: 1,
            overlayRootCount: 2,
            boundary: 'native-screen',
        },
        limitations: ['not physical UIKit/Android view counts'],
    }
    const route = { ...method, route: 'home', sampleCount: 2, minimumGeneratedShare: 0.25 }
    return {
        event: 'render_origin_checkpoint',
        evidence: 'native-public-host',
        ...totals(),
        methods: { allMounted: { ...method, method: 'all-mounted-native-hosts' }, focusedVisible: method },
        checkpoint: { sessionId: 'opaque-session', platform: 'android', screen: 'home', checkpointId: 'view-1:focus' },
        sampledAt: 1234567890.125,
        sampleMs: 4.625,
        rootCount: 3,
        scope: 'React Native committed host/ShadowTree checkpoint of registered documents',
        session: {
            ...totals(),
            sampleCount: 2,
            meanRouteGeneratedShare: 0.5,
            meanRouteStrictGeneratedShare: 0.4,
            methods: { allMounted: { ...method, routes: [route] }, focusedVisible: { ...method, routes: [route] } },
            routes: [route],
        },
    }
}
const emit = (value: Record<string, unknown>): string[] => {
    const lines: string[] = []
    logNativeCheckpoint(value, (line): void => {
        lines.push(line)
    })
    return lines
}

it('retains every checkpoint field and session headline while omitting only duplicated running census detail', () => {
    const original = record()
    const canonical = nativeCheckpointLogRecord(original)
    expect({ ...canonical, session: null }).toEqual({ ...original, session: null })
    expect(canonical.session).toMatchObject({
        sampleCount: 2,
        counts: counts(),
        meanRouteGeneratedShare: 0.5,
        rawTextCounts: counts(1, 0, 0),
        strictCounts: counts(2, 2, 1),
        strictRawTextCounts: counts(0, 0, 0),
        meanRouteStrictGeneratedShare: 0.4,
        exclusions: totals().exclusions,
    })
    expect(canonical.session).not.toHaveProperty('methods')
    expect(canonical.session).not.toHaveProperty('routes')
    expect(canonical.session).not.toHaveProperty('byHostType')
    expect(canonical.session).not.toHaveProperty('strictByHostType')
    expect(original).toEqual(record())
})

it('roundtrips all checkpoint count tables, selection, strict exclusions, floats and null unavailable states exactly', () => {
    const original = record()
    const wire = encodeNativeCheckpoint(original)
    expect(wire.logVersion).toBe(1)
    expect(wire.counts).toEqual([3, 2, 1, 6])
    expect(wire.byHostType).toEqual({ 'RN:View': [2, 2, 0, 4], 'RN:Text': [1, 0, 1, 2] })
    expect(decodeNativeCheckpoint(JSON.parse(JSON.stringify(wire)))).toEqual(nativeCheckpointLogRecord(original))
    const methods = original.methods as Record<string, Record<string, unknown>>
    const unavailable = {
        ...original,
        status: 'unavailable',
        reason: 'incomplete-checkpoints',
        counts: null,
        byHostType: null,
        rawTextCounts: null,
        generatedShare: null,
        methods: {
            allMounted: methods.allMounted,
            focusedVisible: {
                ...methods.focusedVisible,
                status: 'unavailable',
                reason: 'focus-unavailable',
                counts: null,
                byHostType: null,
                rawTextCounts: null,
                generatedShare: null,
                strictStatus: 'unavailable',
                strictReason: 'focus-unavailable',
                strictCounts: null,
                strictByHostType: null,
                strictRawTextCounts: null,
                strictGeneratedShare: null,
            },
        },
    }
    expect(decodeNativeCheckpoint(encodeNativeCheckpoint(unavailable))).toEqual(nativeCheckpointLogRecord(unavailable))
    const noRootsTotals = {
        status: 'unavailable',
        reason: 'no-roots',
        counts: null,
        byHostType: null,
        rawTextCounts: null,
        generatedShare: null,
        strictStatus: 'unavailable',
        strictReason: 'no-roots',
        strictCounts: null,
        strictByHostType: null,
        strictRawTextCounts: null,
        strictGeneratedShare: null,
        exclusions: null,
    }
    const noRoots = {
        ...original,
        ...noRootsTotals,
        rootCount: null,
        methods: Object.fromEntries(
            Object.entries(methods).map(([key, method]) => [key, { ...method, ...noRootsTotals, selection: null }]),
        ),
        session: { ...noRootsTotals, sampleCount: 1 },
    }
    expect(decodeNativeCheckpointLines(emit(noRoots))).toEqual([nativeCheckpointLogRecord(noRoots)])
})

it('reconstructs exact safe census evidence through <=700-byte escaped Unicode fragments, with no oversized duplicate', () => {
    const original = { ...record(), scope: 'a "quote" \\ 🌿\n'.repeat(200) }
    const lines = emit(original)
    expect(lines.length).toBeGreaterThan(1)
    const parts = lines.map((line) => JSON.parse(line) as { event: string; index: number; total: number })
    expect(parts.every((part) => part.event === 'render_origin_fragment')).toBe(true)
    expect(parts.map((part) => part.index)).toEqual(parts.map((_, index) => index))
    expect(parts.every((part) => part.total === parts.length)).toBe(true)
    expect(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 700)).toBe(true)
    expect(decodeNativeCheckpointLines(lines)).toEqual([nativeCheckpointLogRecord(original)])
    expect(decodeNativeCheckpointLines([...lines].reverse())).toEqual([nativeCheckpointLogRecord(original)])
    expect(decodeNativeCheckpointLines([lines[0]!, ...lines])).toEqual([nativeCheckpointLogRecord(original)])
})

it('emits a small checkpoint once and retains legacy raw/fragment evidence without changing its session', () => {
    const small = { event: 'render_origin_checkpoint', counts: counts(), sampleMs: 0.125 }
    const lines = emit(small)
    expect(lines).toHaveLength(1)
    expect(decodeNativeCheckpointLines(lines)).toEqual([small])
    const original = record()
    const value = JSON.stringify(original)
    const parts = [value.slice(0, 500), value.slice(500)].map((data, index) =>
        JSON.stringify({ event: 'render_origin_fragment', id: 44, index, total: 2, data }),
    )
    expect(decodeNativeCheckpointLines([...parts, value])).toEqual([original])
    expect(decodeNativeCheckpoint(original)).toEqual(original)
})

it.each(['missing', 'truncated', 'index', 'total', 'duplicate', 'length', 'checksum', 'corrupted-data'])(
    'fails closed on %s fragments and never manufactures a partial measurement',
    (failure) => {
        const lines = emit(record())
        expect(lines.length).toBeGreaterThan(2)
        const parts = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        if (failure === 'missing') lines.pop()
        else if (failure === 'truncated') lines[0] = lines[0]!.slice(0, -1)
        else if (failure === 'duplicate') lines.splice(1, 0, JSON.stringify({ ...parts[0], data: 'conflict' }))
        else {
            const first = parts[0]!
            if (failure === 'index') first.index = -1
            if (failure === 'total') first.total = Number(first.total) + 1
            if (failure === 'length')
                parts.forEach((part) => {
                    part.bytes = Number(part.bytes) + 1
                })
            if (failure === 'checksum')
                parts.forEach((part) => {
                    part.checksum = '00000000'
                })
            if (failure === 'corrupted-data')
                first.data = String(first.data).replace('native-public-host', 'native-public-lost')
            lines.splice(0, lines.length, ...parts.map((part) => JSON.stringify(part)))
        }
        expect(() => decodeNativeCheckpointLines(lines)).toThrow()
    },
)

it.each([
    [3, 2, 1],
    [3, 2, 1, 99],
    [3.5, 2, 1, 6.5],
    [-1, 2, 1, 2],
])('rejects malformed count tuple %j', (...tuple) => {
    expect(() => decodeNativeCheckpoint({ event: 'render_origin_checkpoint', logVersion: 1, counts: tuple })).toThrow()
})
it('rejects unknown payload/fragment versions instead of guessing a codec', () => {
    expect(() => decodeNativeCheckpoint({ event: 'render_origin_checkpoint', logVersion: 9 })).toThrow()
    const lines = emit(record()).map((line) => JSON.stringify({ ...JSON.parse(line), logVersion: 9 }))
    expect(() => decodeNativeCheckpointLines(lines)).toThrow()
})

it('rejects malformed host-type tables while preserving the whole unavailable table as null', () => {
    for (const byHostType of [[], { 'RN:View': null }, { 'RN:View': [1, 0, 0, 9] }])
        expect(() => decodeNativeCheckpoint({ event: 'render_origin_checkpoint', logVersion: 1, byHostType })).toThrow()
    expect(decodeNativeCheckpoint({ event: 'render_origin_checkpoint', logVersion: 1, byHostType: null })).toEqual({
        event: 'render_origin_checkpoint',
        byHostType: null,
    })
})
