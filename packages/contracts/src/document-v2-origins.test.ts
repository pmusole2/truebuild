import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    SCREEN_KINDS_V2,
    assembleDocumentV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    componentPathsV2,
    createDemoManual,
    documentMaterialV2,
    questionResultSchema,
    screenDocumentV2Schema,
    variantsOfV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'
import { createHeroResponse } from './hero'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const ui: ScreenUiStateV2 = {
    library: { entries: [], soleManualId: null },
    pages: { items: [], maxPages: 20, canRead: false, languageOptions: ['en'] },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'about-this-check', 'tips'],
    camera: { mode: 'build-photo', permission: 'granted' },
    judge: { builtView: false },
    reading: { cancellation: 'confirm-before-stop' },
}

function inputsFor(kind: ScreenKindV2): ScreenContextInputsV2 {
    const sessionless = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind)
    const base: ScreenContextInputsV2 = {
        kind,
        session: sessionless ? null : createDemoManual(),
        stepId: ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind) ? 'step-1' : null,
        captureId: ['result', 'answer', 'questions'].includes(kind) ? 'cap-1' : null,
        result: null,
        failure: kind === 'error' ? 'timeout' : null,
        uiState: ui,
    }
    if (kind === 'result') return { ...base, result: { kind: 'check', value: createHeroResponse('reversed') } }
    if (kind === 'answer') {
        return {
            ...base,
            result: {
                kind: 'question',
                question: 'Which way?',
                value: questionResultSchema.parse({
                    answer: 'The groove faces inward toward the divider.',
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    missingEvidence: [],
                }),
            },
        }
    }
    return base
}

/**
 * The paths `NativeDocumentRenderer` asks `marked()` for, written out independently of `componentPathsV2`
 * (app/src/features/documents/native-document.tsx): the header copy, its back and its actions, the body root and each
 * child as `<parent>.<index>`, and the two bar actions. Every one is looked up under the selected variant's prefix, and
 * a missing origin throws there, so each must exist in `metadata.origins`.
 */
function rendererPaths(prefix: string, variant: ScreenVariantV2): string[] {
    const paths = [`${prefix}header`]
    if (variant.header.back !== null) paths.push(`${prefix}header.back`)
    variant.header.actions.forEach((_action, index) => paths.push(`${prefix}header.actions.${index}`))
    const walk = (node: ScreenNodeV2, path: string): void => {
        paths.push(path)
        if ('children' in node) node.children.forEach((child, index) => walk(child, `${path}.${index}`))
    }
    walk(variant.body, `${prefix}body`)
    paths.push(`${prefix}bar.primary`)
    if (variant.bar.secondary !== null) paths.push(`${prefix}bar.secondary`)
    return paths
}

describe('assembled origins match the paths the renderer looks up', () => {
    it.each(SCREEN_KINDS_V2)(
        '%s: every renderer path has an origin, and only coach overlays are origin-only',
        (kind): void => {
            const inputs = inputsFor(kind)
            const material = documentMaterialV2(inputs)
            const proposal = buildFallbackProposalV2(material)
            // The same proposal published as a model document and as the deterministic fallback.
            const documents: ScreenDocumentV2[] = [
                assembleDocumentV2(
                    material,
                    proposal,
                    { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
                    deps,
                ),
                buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' }),
            ]
            for (const document of documents) {
                expect(screenDocumentV2Schema.safeParse(document).success, document.metadata.source).toBe(true)
                const emitted = variantsOfV2(document).flatMap(({ prefix, variant }) => rendererPaths(prefix, variant))
                const origins = Object.keys(document.metadata.origins)
                // Nothing the renderer asks for is missing (it would throw `missing-origin:<path>` on screen) ...
                expect(origins.filter((path) => !emitted.includes(path) && !/(^|\.)overlays\./u.test(path))).toEqual([])
                expect(emitted.filter((path) => document.metadata.origins[path] === undefined)).toEqual([])
                // ... and every origin the document publishes is either rendered or a coach mark the coach layer owns.
                expect(new Set(origins.filter((path) => !/(^|\.)overlays\./u.test(path)))).toEqual(new Set(emitted))
                expect(new Set(componentPathsV2(document))).toEqual(new Set(origins))
            }
        },
    )
})

describe('the published origin map must name exactly the emitted components', () => {
    const inputs = inputsFor('reading')
    const base = buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
    const messages = (origins: Record<string, unknown>): string[] => {
        const candidate = structuredClone(base) as unknown as { metadata: { origins: Record<string, unknown> } }
        candidate.metadata.origins = origins
        const parsed = screenDocumentV2Schema.safeParse(candidate)
        return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
    }
    const without = (path: string): Record<string, unknown> => {
        const { [path]: _omitted, ...rest } = base.metadata.origins
        return rest
    }

    it('accepts the exact map', () => {
        expect(messages({ ...base.metadata.origins })).toEqual([])
    })

    it.each([
        ['a body leaf', 'body.0.0'],
        ['the fixed bar action', 'bar.primary'],
        ['the header', 'header'],
        ['a state variant header', 'states.busy.header'],
        ['a state variant bar action', 'states.pending.bar.primary'],
        ['the confirming variant body', 'states.confirming.body'],
    ])('rejects an omitted origin: %s', (_label, path) => {
        expect(base.metadata.origins[path], `fixture must emit ${path}`).toBeDefined()
        expect(messages(without(path)).join()).toContain('Origins must name every component exactly')
    })

    it.each([
        ['a child index past the container', 'body.0.99'],
        ['a header action the header does not have', 'header.actions.2'],
        ['an overlay the variant does not have', 'overlays.3'],
        ['a state variant the document does not carry', 'states.empty.body'],
    ])('rejects an origin for a component that is not emitted: %s', (_label, path) => {
        expect(base.metadata.origins[path]).toBeUndefined()
        expect(messages({ ...base.metadata.origins, [path]: 'fallback' }).join()).toContain(
            'Origins must name every component exactly',
        )
    })

    it.each([
        ['a path outside the component grammar', 'body..0'],
        ['a state the catalog does not define', 'states.loading.body'],
        ['a header action index past the grammar', 'header.actions.7'],
    ])('rejects a malformed origin path: %s', (_label, path) => {
        expect(messages({ ...base.metadata.origins, [path]: 'fallback' }).length).toBeGreaterThan(0)
    })

    it.each(['shell', 'live', '', null])('rejects an origin value outside generated|fallback: %j', (value) => {
        expect(messages({ ...base.metadata.origins, body: value }).length).toBeGreaterThan(0)
    })
})
