import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    assembleDocumentV2,
    allowedLiteralsV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    nodeIntentsV2,
    photoSpineV2,
    questionResultSchema,
    screenDocumentV2Schema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'
import { createHeroResponse } from './hero'

// The Ask sheet over the photo the app holds owes it in every variant at one spine. Matching the Answer's layout does
// not transfer a native image between separate surfaces: the actual Answer still earns its own image-load witness.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const FALLBACK = { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' } as const
const CAPTURE = { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false } as const
const WAITING_AND_FAILURE = ['busy', 'pending', 'empty', 'error', 'recovery'] as const
const SHEETS: [string, ScreenUiStateV2][] = [
    ['idle', { capture: CAPTURE }],
    ['asking', { capture: CAPTURE, busy: { activity: 'asking' } }],
    ['still thinking', { capture: CAPTURE, busy: { activity: 'question-waiting' } }],
]

function sheet(
    uiState: ScreenUiStateV2 | null = { capture: CAPTURE },
    patch: Partial<ScreenContextInputsV2> = {},
): ScreenContextInputsV2 {
    return {
        kind: 'questions',
        session: createDemoManual(),
        stepId: 'step-1',
        captureId: 'cap-1',
        result: null,
        failure: null,
        uiState,
        ...patch,
    }
}

/** The page that follows the sheet: the same step and the same held photo, with its answer. */
const answerAfter = (inputs: ScreenContextInputsV2): ScreenContextInputsV2 => ({
    ...inputs,
    kind: 'answer',
    result: {
        kind: 'question',
        question: 'Which way?',
        value: questionResultSchema.parse({
            answer: 'The groove faces inward toward the divider.',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            missingEvidence: [],
        }),
    },
})
const checkAfter = (inputs: ScreenContextInputsV2): ScreenContextInputsV2 => ({
    ...inputs,
    kind: 'result',
    result: { kind: 'check', value: createHeroResponse('reversed') },
})

const build = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
const messages = (document: unknown): string[] => {
    const parsed = screenDocumentV2Schema.safeParse(document)
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

type Stack = Extract<ScreenNodeV2, { type: 'Stack' }>
type Body = Pick<ScreenVariantV2, 'body'>
const stackOf = (variant: Body): Stack => {
    const stack = variant.body.type === 'Scroll' ? variant.body.children[0] : undefined
    if (stack?.type !== 'Stack') throw new Error('A body is a Scroll holding one Stack')
    return stack
}
const isHeldPhoto = (node: ScreenNodeV2 | undefined): boolean =>
    node?.type === 'Image' && node.source.kind === 'capture'
const photosIn = (variant: ScreenVariantV2): ScreenNodeV2[] => {
    const found: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, '', ({ node, hidden }) => {
        if (!hidden && isHeldPhoto(node)) found.push(node)
    })
    return found
}
const offeredBy = (variant: ScreenVariantV2): string[] => {
    const offered = [variant.header.back, ...variant.header.actions].flatMap((action) =>
        action === null ? [] : [action.intent.intent],
    )
    visitVariantNodesV2(variant, '', ({ node }) => offered.push(...nodeIntentsV2(node).map((intent) => intent.intent)))
    return offered
}

describe('a witnessed held Question capture is a required photo', () => {
    it.each<[string, ScreenContextInputsV2, boolean]>([
        ['the photo the app holds', sheet(), true],
        ['the held photo named by the app state alone', sheet({ capture: CAPTURE }, { captureId: null }), true],
        ['no photo held', sheet({}, { captureId: null }), false],
        ['a photo the app does not hold', sheet({ capture: CAPTURE }, { captureId: 'cap-9' }), false],
        ['a photo named with no held-capture state', sheet({ capture: null }), false],
    ])('%s', (_name, inputs, required) => {
        expect(documentMaterialV2(inputs).requirements.capture).toBe(required)
    })

    it.each(['guide', 'recovery', 'camera'] as const)('a %s over the same held photo owes none', (kind) => {
        const ui = { capture: CAPTURE, camera: { mode: 'build-photo', permission: 'granted' } } as const
        expect(documentMaterialV2({ ...sheet(ui), kind }).requirements.capture).toBe(false)
    })

    it('owes nothing else: every other requirement is what the same sheet owed before', () => {
        const held = documentMaterialV2(sheet())
        const bare = documentMaterialV2(sheet({}, { captureId: null }))
        expect(held.facts).toEqual(bare.facts)
        expect(held.sources).toEqual(bare.sources)
        // The question field exists only where a photo is held; no verdict, confirmation or figure is ever owed.
        expect(held.requirements).toEqual({ ...bare.requirements, nodes: ['TextField'], capture: true })
        expect(held.requirements.actions).toEqual([{ intent: 'ask', target: 'about-step' }])
        expect(held.facts.some((fact) => fact.basis === 'result')).toBe(false)
    })
})

describe('the deterministic held Question puts the photo first in every variant', () => {
    it.each(SHEETS)('%s: one photo at one spine, the one its Answer and Result keep', (_name, ui) => {
        const inputs = sheet(ui)
        const document = build(inputs)
        expect(variantsOfV2(document).map(({ name }) => name)).toEqual(['ready', ...WAITING_AND_FAILURE])
        const spine = photoSpineV2(build(answerAfter(inputs)))
        expect(spine).toMatch(/Stack\.0$/u)
        expect(photoSpineV2(build(checkAfter(inputs)))).toBe(spine)
        for (const { name, variant } of variantsOfV2(document)) {
            expect(photosIn(variant), name).toHaveLength(1)
            expect(photoSpineV2(variant), name).toBe(spine)
        }
        expect(document.bound.captureId).toBe('cap-1')
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it('leads the ready sheet with the photo, then its heading and the question field', () => {
        const children = stackOf(build(sheet())).children
        expect(isHeldPhoto(children[0])).toBe(true)
        expect(children[1]).toMatchObject({ type: 'Text', role: 'heading' })
        expect(children.some((child) => child.type === 'TextField')).toBe(true)
    })

    it('never says no photo in an empty variant that holds the witnessed photo', () => {
        const inputs = sheet()
        const empty = build(inputs).states.empty!
        const literals: string[] = []
        visitVariantNodesV2(empty, '', ({ node }) => {
            if (node.type === 'Text' && node.content.kind === 'literal') literals.push(node.content.text)
        })
        expect(literals).toContain('Ask anything about this step.')
        expect(literals).not.toContain('No photo yet')
        expect(literals).not.toContain('Take a photo of your work first.')
        expect(allowedLiteralsV2(documentMaterialV2(inputs), 'empty')).not.toContain('No photo yet')
        expect(allowedLiteralsV2(documentMaterialV2(sheet({}, { captureId: null })), 'empty')).toContain('No photo yet')
    })

    it('states no verdict, answer or confirmation anywhere and offers none', () => {
        const document = build(sheet())
        expect(document.requirements.nodes).not.toContain('VerdictCard')
        expect(document.requirements.facts.some((id) => id.startsWith('result:'))).toBe(false)
        for (const { name, variant } of variantsOfV2(document)) {
            const types: string[] = []
            visitVariantNodesV2(variant, '', ({ node }) => types.push(node.type))
            expect(types, name).not.toContain('VerdictCard')
            const offered = new Set([...offeredBy(variant), variant.bar.primary.intent.intent])
            if (variant.bar.secondary) offered.add(variant.bar.secondary.intent.intent)
            expect(
                [...offered].filter((intent) => ['confirm', 'check'].includes(intent)),
                name,
            ).toEqual([])
        }
    })

    it.each<[string, ScreenContextInputsV2]>([
        ['no photo held', sheet({}, { captureId: null })],
        ['a named photo with no held-capture state', sheet({ capture: null })],
    ])('%s: no photo anywhere and the heading first, as before', (_name, inputs) => {
        const document = build(inputs)
        expect(document.requirements.capture).toBe(false)
        expect(document.bound.captureId).toBeNull()
        for (const { name, variant } of variantsOfV2(document)) {
            expect(photosIn(variant), name).toEqual([])
            expect(photoSpineV2(variant), name).toBeNull()
        }
        expect(stackOf(document).children[0]).toMatchObject({ type: 'Text', role: 'heading' })
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })
})

describe('the gates refuse a held Question that drops or moves its photo', () => {
    const inputs = sheet()
    const material = documentMaterialV2(inputs)
    const variantOf = (draft: ScreenProposalV2, name: 'ready' | (typeof WAITING_AND_FAILURE)[number]): Body =>
        name === 'ready' ? draft : draft.states[name]!
    const dropPhoto = (variant: Body): void => {
        const stack = stackOf(variant)
        stack.children = stack.children.filter((child) => !isHeldPhoto(child))
    }
    /** A lead spacer: the photo keeps existing but its child index changes. */
    const movePhoto = (variant: Body): void => {
        stackOf(variant).children.unshift({ type: 'Spacer', size: 'sm' })
    }
    /** What the shared schema and the request-bound client say about the document a producer published for `inputs`. */
    const published = (edit: (draft: ScreenProposalV2) => void): { shared: string[]; client: string[] } => {
        const draft = structuredClone(buildFallbackProposalV2(material))
        edit(draft)
        const document = assembleDocumentV2(material, draft, FALLBACK, deps)
        return { shared: messages(document), client: verifyDocumentAgainstInputsV2(document, inputs, sha256Hex) }
    }

    it.each(['ready', ...WAITING_AND_FAILURE] as const)('refuses a %s variant without the held photo', (name) => {
        const { shared, client } = published((draft) => dropPhoto(variantOf(draft, name)))
        expect(shared).toContain(`The held photo is missing from the ${name} variant`)
        expect(client).toEqual([])
    })

    it.each(WAITING_AND_FAILURE)('refuses a %s variant that moves the held photo', (name) => {
        const { shared } = published((draft) => movePhoto(variantOf(draft, name)))
        expect(shared).toContain(`The ${name} variant moves the held photo`)
    })

    it('refuses a ready sheet that moves the photo away from the spine every other variant keeps', () => {
        const { shared } = published((draft) => movePhoto(draft))
        expect(shared).toEqual(WAITING_AND_FAILURE.map((name) => `The ${name} variant moves the held photo`))
    })

    it('refuses, for the request-bound client, a document that predates the requirement', () => {
        const draft = structuredClone(buildFallbackProposalV2(material))
        for (const name of WAITING_AND_FAILURE) dropPhoto(variantOf(draft, name))
        // What an older producer published: no photo in the waiting and failure variants and a requirement saying none.
        const older = { ...material, requirements: { ...material.requirements, capture: false } }
        const stale = assembleDocumentV2(older, draft, FALLBACK, deps)
        // It is consistent with itself (the schema only owes what the document says it owes), so only the client,
        // which recomputes the requirements from its own inputs, can see what it leaves out.
        expect(messages(stale)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(stale, inputs, sha256Hex)).toContain('requirements_mismatch')
    })
})
