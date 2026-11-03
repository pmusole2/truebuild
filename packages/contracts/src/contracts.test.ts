import { describe, expect, it } from 'vitest'

import {
    apiResultSchema,
    checkResultSchema,
    createDemoManual,
    isCurrentResult,
    manualSessionSchema,
    manualStepSchema,
    matchesBinding,
    normalizedBoxSchema,
    parsedManualSchema,
    trackSnapshotSchema,
    type CaptureBinding,
    type ManualSession,
} from './index'

function demo(): ManualSession {
    return createDemoManual()
}

const capture: CaptureBinding = {
    kind: 'capture',
    manualId: 'demo-divider',
    revision: 1,
    stepId: 'step-1',
    captureId: 'capture-1',
}

describe('manual trust boundaries', () => {
    it('preserves selected extraction pages independently of returned citations and accepts older sessions', () => {
        const previous = demo()
        const selected = {
            ...previous,
            rawExtraction: { parts: [], steps: [], unknowns: ['No legible facts on this page.'] },
            extractionSourcePageIds: ['demo-page-1'],
        }

        expect(manualSessionSchema.parse(selected).extractionSourcePageIds).toEqual(['demo-page-1'])
        expect(manualSessionSchema.parse(previous)).toEqual(previous)
    })

    it.each([
        ['duplicate selected page', ['demo-page-1', 'demo-page-1'], false],
        ['unresolved selected page', ['absent-page'], false],
        ['custody without raw evidence', ['demo-page-1'], true],
    ] as const)('rejects extraction custody with %s', (_label, selected, missingRaw) => {
        const value = { ...demo(), extractionSourcePageIds: [...selected] }
        if (missingRaw) {
            value.rawExtraction = null
        }
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
    })

    it('round-trips optional source-backed step actions and enforces count, length and identity bounds', () => {
        const step = demo().reviewedSteps[0]!
        const action = { actionId: 'a1', instruction: 'Turn the panel.', sourceRefs: step.sourceRefs }
        const withActions = { ...step, actions: [action] }
        expect(manualStepSchema.parse(withActions)).toEqual(withActions)
        expect(manualStepSchema.parse(step)).not.toHaveProperty('actions')
        expect(
            manualStepSchema.safeParse({
                ...step,
                actions: Array.from({ length: 6 }, (_, i) => ({
                    ...action,
                    actionId: `a${i}`,
                    instruction: 'x'.repeat(90),
                })),
            }).success,
        ).toBe(true)
        for (const actions of [
            Array.from({ length: 7 }, (_, i) => ({ ...action, actionId: `a${i}` })),
            [{ ...action, instruction: 'x'.repeat(91) }],
            [action, action],
            [{ ...action, sourceRefs: [] }],
        ]) {
            expect(manualStepSchema.safeParse({ ...step, actions }).success).toBe(false)
        }
        const session = demo()
        session.reviewedSteps[0] = {
            ...step,
            actions: [{ ...action, sourceRefs: [{ pageId: 'missing', region: null }] }],
        }
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
    })

    it('provides an isolated deterministic synthetic reviewed manual', () => {
        const first = demo()
        const second = demo()

        expect(manualSessionSchema.parse(first)).toEqual(second)
        first.title = 'Changed'
        expect(second.title).not.toBe('Changed')
        expect(first.reviewedSteps).toHaveLength(2)
    })

    it.each([
        [
            'duplicate page',
            (value: ManualSession): void => {
                value.pages.push(value.pages[0]!)
            },
        ],
        [
            'duplicate step',
            (value: ManualSession): void => {
                value.reviewedSteps.push(value.reviewedSteps[0]!)
            },
        ],
        [
            'duplicate reviewed part',
            (value: ManualSession): void => {
                value.parts.push(value.parts[0]!)
            },
        ],
        [
            'duplicate extracted part',
            (value: ManualSession): void => {
                value.rawExtraction!.parts.push(value.rawExtraction!.parts[0]!)
            },
        ],
        [
            'unresolved page',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.sourceRefs[0]!.pageId = 'absent'
            },
        ],
        [
            'unresolved part',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.parts[0]!.partId = 'absent'
            },
        ],
        [
            'unresolved correction source',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.correction!.actions[0]!.sourceRefs[0]!.pageId = 'absent'
            },
        ],
    ])('rejects %s', (_label, mutate) => {
        const value = demo()
        mutate(value)
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
    })

    it('preserves unknown facts in drafts but refuses reviewed unknown critical facts', () => {
        const value = demo()
        value.reviewStatus = 'unreviewed'
        value.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Not visible in the source' }

        const parsed = manualSessionSchema.parse(value)
        expect(parsed.reviewedSteps[0]!.orientation).toEqual({
            state: 'unknown',
            reason: 'Not visible in the source',
        })
        value.reviewStatus = 'reviewed'
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
    })

    it('keeps editable facts separate from the raw extraction registry', () => {
        const value = demo()
        value.parts[0]!.name = { state: 'unknown', reason: 'Needs manual correction' }
        value.reviewStatus = 'unreviewed'

        const parsed = manualSessionSchema.parse(value)
        expect(parsed.parts[0]!.name.state).toBe('unknown')
        expect(parsed.rawExtraction!.parts[0]!.name.state).toBe('known')
    })

    it.each([
        [
            'name',
            (value: ManualSession): void => {
                value.parts[0]!.name = { state: 'unknown', reason: 'Unreadable label' }
            },
        ],
        [
            'quantity',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'Unreadable count' }
            },
        ],
        [
            'connection',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.connection = { state: 'unknown', reason: 'Connection not visible' }
            },
        ],
        [
            'check',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.visibleChecks[0]!.description = {
                    state: 'unknown',
                    reason: 'Check not visible',
                }
            },
        ],
        [
            'correction review',
            (value: ManualSession): void => {
                value.reviewedSteps[0]!.correction!.reviewed = false
            },
        ],
    ])('rejects reviewed sessions with unresolved %s', (_label, mutate) => {
        const value = demo()
        mutate(value)
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
    })

    it('forbids model extraction from claiming human-reviewed correction plans', () => {
        const value = demo().rawExtraction!
        value.steps[0]!.correction!.reviewed = true
        expect(parsedManualSchema.safeParse(value).success).toBe(false)
    })

    it('allows an imported draft with no steps, but never calls it reviewed', () => {
        const value = demo()
        value.rawExtraction = null
        value.reviewedSteps = []
        value.reviewStatus = 'unreviewed'
        expect(manualSessionSchema.safeParse(value).success).toBe(true)
        value.reviewStatus = 'reviewed'
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
    })

    it('rejects oversized images, malformed timestamps and unknown fields', () => {
        const value = demo()
        expect(manualSessionSchema.safeParse({ ...value, updatedAt: 'yesterday' }).success).toBe(false)
        expect(manualSessionSchema.safeParse({ ...value, extra: true }).success).toBe(false)
        value.pages[0]!.width = 24_000_001
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
    })
})

describe('geometry and result identity', () => {
    it.each([
        { x: 0.9, y: 0, width: 0.2, height: 1 },
        { x: 0, y: -0.1, width: 1, height: 1 },
        { x: 0, y: 0, width: 0, height: 1 },
        { x: Number.NaN, y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 },
    ])('rejects invalid normalized box %#', (value) => {
        expect(normalizedBoxSchema.safeParse(value).success).toBe(false)
    })

    it('accepts the exact image boundary', () => {
        expect(normalizedBoxSchema.safeParse({ x: 0, y: 0, width: 1, height: 1 }).success).toBe(true)
    })

    it('requires evidence and no missing evidence for pass', () => {
        const result = { decision: 'pass', reason: 'Demo data — simulated results', observedRegion: null }
        expect(checkResultSchema.safeParse({ ...result, sourceRefs: [], missingEvidence: [] }).success).toBe(false)
        expect(
            checkResultSchema.safeParse({
                ...result,
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                missingEvidence: ['Fastener not visible'],
            }).success,
        ).toBe(false)
    })

    it('compares all identity fields and never accepts unavailable results', () => {
        const value = checkResultSchema.parse({
            decision: 'cannot_verify',
            reason: 'Demo data — simulated results',
            sourceRefs: [],
            observedRegion: null,
            missingEvidence: ['No observation'],
        })
        const result = apiResultSchema(checkResultSchema).parse({
            status: 'ok',
            mode: 'fixture',
            requestId: 'request-1',
            binding: capture,
            value,
        })
        expect(isCurrentResult(result, capture)).toBe(true)
        for (const stale of [
            { ...capture, manualId: 'different' },
            { ...capture, revision: 2 },
            { ...capture, stepId: 'step-2' },
            { ...capture, captureId: 'capture-2' },
            { kind: 'manual' as const, manualId: capture.manualId, revision: 1 },
        ]) {
            expect(matchesBinding(capture, stale)).toBe(false)
            expect(isCurrentResult(result, stale)).toBe(false)
        }
        expect(
            isCurrentResult(
                {
                    status: 'unavailable',
                    requestId: 'request-1',
                    binding: capture,
                    code: 'unconfigured',
                    retryable: false,
                },
                capture,
            ),
        ).toBe(false)
    })

    it('rejects duplicate track identities within a single stream snapshot', () => {
        const record = { objectId: 'object-1', label: 'Divider', box: { x: 0, y: 0, width: 1, height: 1 } }
        expect(
            trackSnapshotSchema.safeParse({
                binding: capture,
                streamId: 'stream-1',
                frameIndex: 0,
                capturedAt: '2026-01-01T00:00:00.000Z',
                records: [record, record],
                complete: true,
            }).success,
        ).toBe(false)
    })
})

it('rejects every uncited refusal, including generic mismatches without an orientation assessment', () => {
    expect(
        checkResultSchema.safeParse({
            decision: 'refuse',
            reason: 'Observed mismatch',
            sourceRefs: [],
            observedRegion: null,
            missingEvidence: [],
        }).success,
    ).toBe(false)
})
