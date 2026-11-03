import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
    createDemoManual,
    manualSessionSchema,
    manualStepSchema,
    parsedManualSchema,
    projectManualSessionExtensions,
    requestedStepExtensions,
    sanitizeManualStepActions,
    SUPPORTED_STEP_EXTENSIONS,
} from './index'

/** Step fields that existed before the optional extension mechanism; anything else must be a registered extension. */
const LEGACY_STEP_KEYS = [
    'stepId',
    'order',
    'title',
    'parts',
    'orientation',
    'connection',
    'visibleChecks',
    'sourceRefs',
    'correction',
    'kind',
    'requirements',
    'alternatives',
    'selectedAlternativeId',
    'safetyNotes',
]

const pages = new Set(['demo-page-1'])

function action(
    actionId: string,
    instruction: string,
    pageId = 'demo-page-1',
): { actionId: string; instruction: string; sourceRefs: { pageId: string; region: null }[] } {
    return { actionId, instruction, sourceRefs: [{ pageId, region: null }] }
}

function sessionWithActions(actions: unknown): ReturnType<typeof createDemoManual> {
    const session = createDemoManual()
    Object.assign(session.reviewedSteps[0]!, { actions })
    return session
}

/** Raw provider output shaped from a demo session: the extraction never marks a correction reviewed. */
function rawWithSteps(mapStep: (step: ReturnType<typeof createDemoManual>['reviewedSteps'][number]) => object): {
    parts: unknown
    steps: Record<string, unknown>[]
    unknowns: []
} {
    const session = createDemoManual()
    return {
        parts: session.parts,
        steps: session.reviewedSteps.map((step) => ({
            ...mapStep(step),
            correction: step.correction === null ? null : { ...step.correction, reviewed: false },
        })),
        unknowns: [],
    }
}

describe('step extension registry', () => {
    const shape = manualStepSchema.shape as Record<string, z.ZodType>
    const extensionKeys = Object.keys(shape).filter((key) => !LEGACY_STEP_KEYS.includes(key))

    it('names the planned step fields exactly once', () => {
        expect(SUPPORTED_STEP_EXTENSIONS).toEqual(['actions', 'sourceText'])
    })

    it.each(extensionKeys)('registers optional extension schema field %s', (key) => {
        expect(SUPPORTED_STEP_EXTENSIONS).toContain(key)
        expect(shape[key]!.safeParse(undefined).success).toBe(true)
    })

    it('keeps every step field outside the legacy set registered', () => {
        expect(extensionKeys.every((key) => SUPPORTED_STEP_EXTENSIONS.some((name) => name === key))).toBe(true)
    })

    it('retains registered extensions by default and projects for an older reader explicitly', () => {
        const session = sessionWithActions([action('a1', 'Turn the panel.')])
        Object.assign(session.reviewedSteps[0]!, { sourceText: 'Source words' })
        expect(projectManualSessionExtensions(session)).toEqual(session)
        const projected = projectManualSessionExtensions(session, [])
        expect(projected).not.toEqual(session)
    })
})

describe('requestedStepExtensions', () => {
    it.each([
        ['stepFields=actions,sourceText', ['actions', 'sourceText']],
        ['stepActions=1', ['actions']],
        ['stepFields=sourceText&stepActions=1', ['actions', 'sourceText']],
        ['stepFields=bogus, actions ,,sourceText&stepFields=actions', ['actions', 'sourceText']],
        ['stepFields=unknown', []],
        ['stepActions=1&stepActions=1', []],
        ['', []],
    ])('parses %s', (query, expected) => {
        expect([...requestedStepExtensions(new URLSearchParams(query))]).toEqual(expected)
    })
})

describe('optional actions never fail a manual parse', () => {
    it('keeps the valid actions of a mixed list and drops the rest', () => {
        const session = sessionWithActions([
            action('a1', 'Turn the panel.'),
            action('a2', '   '),
            action('a1', 'Turn it again.'),
            action('a3', 'Lift it.', 'missing-page'),
            action('a4', 'Press it.'),
        ])
        expect(manualSessionSchema.parse(session).reviewedSteps[0]!.actions?.map((item) => item.actionId)).toEqual([
            'a1',
            'a4',
        ])
    })

    it('lets a bad entry not claim an identity that a later valid entry needs', () => {
        const session = sessionWithActions([action('a5', 'Lift it.', 'missing-page'), action('a5', 'Lift it.')])
        expect(manualSessionSchema.parse(session).reviewedSteps[0]!.actions?.map((item) => item.actionId)).toEqual([
            'a5',
        ])
    })

    it('becomes no procedure when every action is bad', () => {
        const session = sessionWithActions([action('a1', ' '), action('a2', 'Lift.', 'missing-page')])
        expect(manualSessionSchema.parse(session).reviewedSteps[0]!.actions).toBeNull()
    })

    it('treats a non-list procedure as no procedure', () => {
        expect(manualSessionSchema.parse(sessionWithActions('not a list')).reviewedSteps[0]!.actions).toBeNull()
    })

    it('cleans a mixed raw provider manual before the strict parse', () => {
        const raw = rawWithSteps((step) => ({
            ...step,
            actions: [action('a1', 'Turn the panel.'), action('a2', ' '), action('a1', 'Again.')],
        }))
        expect(parsedManualSchema.parse(raw).steps[0]!.actions?.map((item) => item.actionId)).toEqual(['a1'])
        const parsed = parsedManualSchema.parse(sanitizeManualStepActions(raw, pages))
        expect(parsed.steps[0]!.actions?.map((item) => item.actionId)).toEqual(['a1'])
        expect(raw.steps[0]!.actions).toHaveLength(3)
    })

    it('cleans an all-bad raw provider manual to no procedure', () => {
        const raw = rawWithSteps((step) => ({
            ...step,
            actions: [action('a1', ' '), action('a2', 'Lift.', 'other-page')],
        }))
        const parsed = parsedManualSchema.parse(sanitizeManualStepActions(raw, pages))
        expect(parsed.steps.every((step) => step.actions === null)).toBe(true)
    })

    it('projects a future sourceText field out of raw provider steps before the strict parse', () => {
        const raw = rawWithSteps((step) => ({ ...step, sourceText: 'Future source words' }))
        expect(parsedManualSchema.safeParse(raw).success).toBe(true)
        expect(parsedManualSchema.safeParse(sanitizeManualStepActions(raw, pages)).success).toBe(true)
    })

    it('keeps the six-action limit and bounded instructions after cleanup', () => {
        const actions = Array.from({ length: 8 }, (_, index) => action(`a${index}`, `Move ${'carefully '.repeat(20)}`))
        const session = manualSessionSchema.parse(sessionWithActions([action('bad', ' '), ...actions]))
        const kept = session.reviewedSteps[0]!.actions!
        expect(kept).toHaveLength(6)
        expect(kept.every((item) => item.instruction.length <= 120)).toBe(true)
    })

    it('does not change non-action source evidence, which stays strict', () => {
        expect(
            manualSessionSchema.parse(sessionWithActions([action('a1', 'Turn.')])).reviewedSteps[0]!.actions,
        ).toHaveLength(1)
        const session = sessionWithActions([action('a1', 'Turn.', 'missing-page')])
        session.reviewedSteps[0]!.sourceRefs = [{ pageId: 'missing-page', region: null }]
        expect(manualSessionSchema.safeParse(session).success).toBe(false)
    })

    it('leaves the input untouched', () => {
        const raw = rawWithSteps((step) => ({ ...step, actions: [action('a1', ' ')] }))
        const before = structuredClone(raw)
        sanitizeManualStepActions(raw, pages)
        expect(raw).toEqual(before)
    })
})
