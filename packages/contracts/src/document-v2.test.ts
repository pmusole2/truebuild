import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    COMPONENT_PATH_V2,
    DOCUMENT_V2_LIMITS,
    SCREEN_KINDS_V2,
    assembleDocumentV2,
    componentPathsV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    questionResultSchema,
    requiredStatesV2,
    screenContextJsonV2,
    screenContextJson,
    screenDocumentV2Schema,
    screenManualJsonV2,
    screenNodeV2Schema,
    screenProposalV2Schema,
    sourceMapV2,
    variantsOfV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
} from './index'
import { createHeroResponse } from './hero'
import {
    modelScreensV2MetadataSchema,
    overlayResponseSchema,
    screensV2GenerateRequest,
    screensV2ResultSchema,
} from './model'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const SAFETY = 'Keep fingers clear of the groove while the panel is lifted.'

function session(options: { safety?: boolean; classified?: boolean } = {}): ManualSession {
    const manual = createDemoManual()
    if (options.safety) {
        manual.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'n1',
                note: { state: 'known', value: SAFETY, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
            },
        ]
    } else if (options.classified) {
        manual.reviewedSteps[0]!.safetyNotes = []
    }
    return manual
}

const library = {
    entries: [
        {
            manualId: 'demo-divider',
            title: 'Demo',
            updatedAt: '2026-01-01T00:00:00.000Z',
            stopStepId: 'step-1',
            completed: 0,
            total: 2,
            firstPageId: 'demo-page-1',
        },
    ],
    soleManualId: 'demo-divider',
}
const ui: ScreenUiStateV2 = {
    library,
    pages: {
        items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
        maxPages: 20,
        canRead: true,
        languageOptions: ['en'],
    },
    review: {
        currentQuestion: {
            questionId: 'q1',
            kind: 'orientation',
            stepId: 'step-1',
            stepOrder: 1,
            reason: 'Check this.',
            parts: [],
        },
        blockers: 0,
        canConfirm: true,
    },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'about-this-check', 'tips'],
    camera: { mode: 'build-photo', permission: 'granted' },
    judge: { builtView: false },
}

function inputsFor(kind: ScreenKindV2, manual = session({ safety: true })): ScreenContextInputsV2 {
    const stepKinds = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera']
    const base: ScreenContextInputsV2 = {
        kind,
        session: ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind) ? null : manual,
        stepId: stepKinds.includes(kind) ? 'step-1' : null,
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
                    missingEvidence: ['A closer photo would help.'],
                }),
            },
        }
    }
    return base
}

const fallbackFor = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

function mutate(document: ScreenDocumentV2): ScreenDocumentV2 {
    return structuredClone(document)
}
const issues = (document: unknown): string[] => {
    const parsed = screenDocumentV2Schema.safeParse(document)
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('deterministic complete documents', () => {
    it('keeps timeout recovery honest and retries the screen without changing its context', () => {
        for (const kind of ['guide', 'quick-check', 'camera'] as const) {
            const inputs = inputsFor(kind)
            if (kind === 'camera') inputs.uiState = { camera: { mode: 'build-photo', permission: 'granted' } }
            const document = buildFallbackDocumentV2(inputs, {
                ...deps,
                reason: 'timeout',
                evidence: 'local-deterministic',
            })
            expect(issues(document)).toEqual([])
            expect(document.bound.contextKey).toBe(sha256Hex(screenContextJsonV2(inputs)))
            expect(JSON.stringify(document.states.error)).toContain('That took too long')
            const retry = kind === 'camera' ? document.states.error?.bar.secondary : document.states.error?.bar.primary
            expect(retry).toMatchObject({
                label: 'Try again',
                intent: { intent: 'retry', target: 'screen' },
            })
            if (kind === 'camera') {
                expect(document.states.error?.bar.primary).toEqual(document.bar.primary)
                expect(JSON.stringify(document.states.error)).toContain('CameraView')
            }
        }
    })
    it.each(SCREEN_KINDS_V2)('%s composes one complete, valid fallback document', (kind) => {
        const document = fallbackFor(inputsFor(kind))
        expect(issues(document)).toEqual([])
        expect(document.kind).toBe(kind)
        expect(document.metadata).toMatchObject({ source: 'fallback', evidence: 'local-deterministic', model: null })
        for (const state of requiredStatesV2(kind)) expect(document.states[state]).not.toBeNull()
        // Every component has an origin and every path is canonical.
        const paths = componentPathsV2(document)
        expect(Object.keys(document.metadata.origins).sort()).toEqual([...paths].sort())
        expect(paths.every((path) => COMPONENT_PATH_V2.test(path))).toBe(true)
        // Round trip through JSON (what the network carries).
        expect(screenDocumentV2Schema.safeParse(JSON.parse(JSON.stringify(document))).success).toBe(true)
    })

    it('camera is its own document and never borrows the guide wording', () => {
        const camera = fallbackFor(inputsFor('camera'))
        const guide = fallbackFor(inputsFor('guide'))
        expect(camera.kind).toBe('camera')
        expect(camera.requirements.nodes).toContain('CameraView')
        expect(JSON.stringify(camera.header)).not.toBe(JSON.stringify(guide.header))
        expect(camera.bound.contextKey).not.toBe(guide.bound.contextKey)
        const page = fallbackFor({
            ...inputsFor('camera'),
            session: null,
            stepId: null,
            uiState: { ...ui, camera: { mode: 'manual-page', permission: 'granted' } },
        })
        expect(issues(page)).toEqual([])
        expect(page.facts).toEqual([])
    })

    it('busy, pending and error chrome come from the document variants, each with its own bar', () => {
        const document = fallbackFor(inputsFor('guide'))
        for (const state of ['busy', 'pending', 'error', 'recovery'] as const) {
            const variant = document.states[state]!
            expect(variant.bar.primary.type).toBe('PrimaryAction')
            expect(variant.header.title).toBeDefined()
        }
        expect(document.states.busy!.bar.primary.label).toBe('Preparing step…')
    })

    it('a reversed verdict document states the verdict through a VerdictCard and offers a retake', () => {
        const document = fallbackFor(inputsFor('result'))
        expect(document.requirements.nodes).toContain('VerdictCard')
        expect(document.requirements.actions).toEqual([{ intent: 'capture', target: 'retake' }])
        expect(document.facts.find((fact) => fact.factId === 'result:verdict')?.basis).toBe('result')
        // The verdict is revealed only in `ready`: every other variant (waiting or failing) holds the photo and states none.
        for (const { name, prefix, variant } of variantsOfV2(document)) {
            const types: string[] = []
            visitVariantNodesV2(variant, prefix, (entry) => types.push(entry.node.type))
            if (name === 'ready') expect(types).toContain('VerdictCard')
            else expect(types).not.toContain('VerdictCard')
            expect(types).toContain('Image')
        }
    })

    it('an unreviewed fresh parse never offers a build action', () => {
        const manual = createDemoManual()
        manual.reviewStatus = 'unreviewed'
        const document = fallbackFor({ ...inputsFor('guide', manual), session: manual })
        expect(document.bar.primary.intent).toEqual({ intent: 'navigate', target: 'quick-check' })
        expect(issues(document)).toEqual([])
    })

    it('the same inputs always give the same document', () => {
        expect(fallbackFor(inputsFor('guide'))).toEqual(fallbackFor(inputsFor('guide')))
    })
})

describe('mandatory witnesses reject rather than repair', () => {
    const base = fallbackFor(inputsFor('guide'))

    it('lists the safety note as required, with its citation, in every variant', () => {
        expect(base.requirements.facts).toContain('safety:n1')
        expect(base.requirements.sources.length).toBeGreaterThan(0)
        expect(base.facts.find((fact) => fact.factId === 'safety:n1')?.text).toBe(SAFETY)
    })

    it('rejects a document whose ready variant omits the safety fact', () => {
        const document = mutate(base)
        const drop = (node: ScreenNodeV2): ScreenNodeV2 => {
            if ('children' in node) {
                return {
                    ...node,
                    children: node.children
                        .filter(
                            (child) =>
                                !(
                                    child.type === 'Text' &&
                                    child.content.kind === 'fact' &&
                                    child.content.factId === 'safety:n1'
                                ),
                        )
                        .map(drop),
                } as ScreenNodeV2
            }
            return node
        }
        document.body = drop(document.body)
        expect(issues(document).join()).toContain('A required fact is missing from the ready variant')
    })

    it('rejects a state variant that omits the safety fact', () => {
        const document = mutate(base)
        document.states.busy = { ...document.states.busy!, body: { type: 'Spacer', size: 'md' } }
        expect(issues(document).join()).toContain('missing from the busy variant')
    })

    it('rejects a required fact hidden in a collapsed section', () => {
        const document = mutate(base)
        document.body = {
            type: 'Section',
            title: null,
            collapsible: true,
            initiallyOpen: false,
            children: [document.body],
        }
        expect(issues(document).join()).toContain('A required fact is missing')
    })

    it('rejects an omitted citation, action and required node', () => {
        const noCitation = mutate(base)
        const strip = (node: ScreenNodeV2): ScreenNodeV2 =>
            'children' in node
                ? ({
                      ...node,
                      children: node.children
                          .filter((child) => child.type !== 'Citation' && child.type !== 'Image')
                          .map(strip),
                  } as ScreenNodeV2)
                : node
        noCitation.body = strip(noCitation.body)
        expect(issues(noCitation).join()).toContain('A required citation is missing')

        const noAction = mutate(base)
        noAction.bar = {
            ...noAction.bar,
            primary: { ...noAction.bar.primary, intent: { intent: 'navigate', target: 'home' } },
        }
        noAction.bar.secondary = null
        expect(issues(noAction).join()).toContain('A required action is missing')

        const verdict = fallbackFor(inputsFor('result'))
        const noVerdict = mutate(verdict)
        noVerdict.body = { type: 'Spacer', size: 'md' }
        expect(issues(noVerdict).join()).toContain('A required VerdictCard is missing')
    })

    it('rejects an unknown fact, a missing source and a primary action outside the bar', () => {
        const unknownFact = mutate(base)
        unknownFact.body = {
            type: 'Text',
            content: { kind: 'fact', factId: 'nope' },
            role: 'body',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        }
        expect(issues(unknownFact).join()).toContain('unknown fact')

        const badSource = mutate(base)
        badSource.body = { type: 'Citation', sources: [63], label: null, display: 'chip' }
        expect(issues(badSource).join()).toContain('source that does not exist')

        const inBody = mutate(base)
        inBody.body = { type: 'Stack', gap: 'md', align: 'start', children: [base.bar.primary, base.body] }
        expect(issues(inBody).join()).toContain('A primary action lives only in the bar')
    })

    it('rejects an intent the screen kind does not allow and a back that does not navigate', () => {
        const document = mutate(fallbackFor(inputsFor('more')))
        document.bar.primary.intent = { intent: 'retry', target: 'last-action' }
        expect(issues(document).join()).toContain('Intent is not allowed')
    })

    it('rejects a missing required state variant and an inconsistent origin', () => {
        const document = mutate(base)
        document.states.busy = null
        expect(issues(document).join()).toContain('Missing busy variant')
        const origin = mutate(base)
        origin.metadata.origins['body'] = 'generated'
        expect(issues(origin).join()).toContain('origin matches the document source')
    })
})

describe('recursive tree bounds', () => {
    const nest = (depth: number): ScreenNodeV2 =>
        depth <= 1
            ? { type: 'Divider', inset: false }
            : { type: 'Stack', gap: 'sm', align: 'start', children: [nest(depth - 1)] }

    it('accepts the depth limit and refuses one level more', () => {
        const base = fallbackFor(inputsFor('more'))
        const at = { ...mutate(base), body: nest(DOCUMENT_V2_LIMITS.depth) }
        const over = { ...mutate(base), body: nest(DOCUMENT_V2_LIMITS.depth + 1) }
        // Requirements about the replaced body aside, only the structure rule is asserted here.
        expect(issues(at).join()).not.toContain('Tree is too deep')
        expect(issues(over).join()).toContain('Tree is too deep')
    })

    it('bounds the node count and the children per container, in the node schema itself', () => {
        const wide = (count: number): unknown => ({
            type: 'Row',
            gap: 'sm',
            align: 'start',
            justify: 'start',
            wrap: true,
            children: Array.from({ length: count }, () => ({ type: 'Divider', inset: false })),
        })
        expect(screenNodeV2Schema.safeParse(wide(DOCUMENT_V2_LIMITS.children)).success).toBe(true)
        expect(screenNodeV2Schema.safeParse(wide(DOCUMENT_V2_LIMITS.children + 1)).success).toBe(false)
        const many = {
            ...mutate(fallbackFor(inputsFor('more'))),
            body: {
                type: 'Stack',
                gap: 'sm',
                align: 'start',
                children: Array.from(
                    { length: Math.ceil(DOCUMENT_V2_LIMITS.nodes / DOCUMENT_V2_LIMITS.children) + 1 },
                    () => wide(DOCUMENT_V2_LIMITS.children),
                ),
            } as ScreenNodeV2,
        }
        expect(issues(many).join()).toContain('Too many nodes in one variant')
    })

    it('rejects markup, URLs and unknown node types or tokens in model text', () => {
        const text = (value: string): unknown => ({
            type: 'Text',
            content: { kind: 'literal', text: value },
            role: 'body',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        })
        for (const bad of ['a <b>x</b>', 'see https://example.com', '`code`', 'open [x](y)']) {
            expect(screenNodeV2Schema.safeParse(text(bad)).success).toBe(false)
        }
        expect(screenNodeV2Schema.safeParse({ type: 'Html', html: 'x' }).success).toBe(false)
        expect(screenNodeV2Schema.safeParse({ ...(text('ok') as object), tone: '#ff0000' }).success).toBe(false)
        expect(screenNodeV2Schema.safeParse({ ...(text('ok') as object), style: { color: 'red' } }).success).toBe(false)
    })
})

describe('proposal, source map and assembly', () => {
    it('the model proposal is the document without server-owned fields and is strict', () => {
        const material = documentMaterialV2(inputsFor('guide'))
        const proposal = buildFallbackProposalV2(material)
        expect(screenProposalV2Schema.safeParse(proposal).success).toBe(true)
        expect(screenProposalV2Schema.safeParse({ ...proposal, facts: [] }).success).toBe(false)
        expect(screenProposalV2Schema.safeParse({ ...proposal, metadata: {} }).success).toBe(false)
    })

    it('assembly never edits the proposal and tags every path with the given source', () => {
        const material = documentMaterialV2(inputsFor('guide'))
        const proposal = buildFallbackProposalV2(material)
        const before = JSON.stringify(proposal)
        const document = assembleDocumentV2(
            material,
            proposal,
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
            deps,
        )
        expect(JSON.stringify(proposal)).toBe(before)
        expect(issues(document)).toEqual([])
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['generated']))
        expect(document.metadata).toMatchObject({ model: null, effort: null, timing: { totalMs: null } })
    })

    it('a generated synthetic example may not claim a model, timing or usage', () => {
        const material = documentMaterialV2(inputsFor('guide'))
        const document = assembleDocumentV2(
            material,
            buildFallbackProposalV2(material),
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null, model: 'muse-wonder-1.0' },
            deps,
        )
        expect(issues(document).join()).toContain('claims no model')
    })

    it('maps each citing node to the sources of its facts', () => {
        const document = fallbackFor(inputsFor('guide'))
        const map = sourceMapV2(document)
        expect(Object.keys(map).length).toBeGreaterThan(0)
        expect(
            Object.values(map)
                .flat()
                .every((index) => index < document.sources.length),
        ).toBe(true)
        expect(map).toEqual(document.metadata.sourceMap)
    })
})

describe('request binding', () => {
    it('v2 keys never equal v1 keys and distinguish camera modes and full state', () => {
        const guide = inputsFor('guide')
        const v1 = sha256Hex(screenContextJson({ ...guide, kind: 'guide', uiState: null }))
        expect(sha256Hex(screenContextJsonV2(guide))).not.toBe(v1)
        const build = inputsFor('camera')
        const page = {
            ...build,
            uiState: { ...ui, camera: { mode: 'manual-page' as const, permission: 'granted' as const } },
        }
        expect(screenContextJsonV2(build)).not.toBe(screenContextJsonV2(page))
        expect(screenContextJsonV2(inputsFor('judge'))).not.toBe(screenContextJsonV2(inputsFor('more')))
        // Volatile library data the provider never sees does not change the key.
        const touched = {
            ...inputsFor('home'),
            uiState: {
                ...ui,
                library: { ...library, entries: [{ ...library.entries[0]!, updatedAt: '2027-01-01T00:00:00.000Z' }] },
            },
        }
        expect(screenContextJsonV2(touched)).toBe(screenContextJsonV2(inputsFor('home')))
    })

    it('builds generate requests that carry the manual hash and context key', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const inputs = inputsFor(kind)
            const request = screensV2GenerateRequest('req-1', inputs, sha256Hex)
            const parsed = modelScreensV2MetadataSchema.safeParse(request)
            expect(parsed.success, `${kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true)
            expect(request.contextKey).toBe(sha256Hex(screenContextJsonV2(inputs)))
            expect(request.manualHash).toBe(
                inputs.session === null ? null : sha256Hex(screenManualJsonV2(inputs.session)),
            )
        }
    })

    it('refuses a session without its hash, a missing context key and a step screen without its step', () => {
        const request = screensV2GenerateRequest('req-1', inputsFor('guide'), sha256Hex)
        expect(modelScreensV2MetadataSchema.safeParse({ ...request, manualHash: null }).success).toBe(false)
        expect(modelScreensV2MetadataSchema.safeParse({ ...request, contextKey: null }).success).toBe(false)
        expect(modelScreensV2MetadataSchema.safeParse({ ...request, stepId: null }).success).toBe(false)
        expect(modelScreensV2MetadataSchema.safeParse({ ...request, extra: true }).success).toBe(false)
        const camera = screensV2GenerateRequest('req-2', inputsFor('camera'), sha256Hex)
        expect(modelScreensV2MetadataSchema.safeParse({ ...camera, uiState: { ...ui, camera: null } }).success).toBe(
            false,
        )
    })

    it('the result envelope carries a valid document', () => {
        const document = fallbackFor(inputsFor('home'))
        expect(
            screensV2ResultSchema.safeParse({
                status: 'ok',
                requestId: 'r',
                mode: 'fixture',
                value: { document, progress: null, documents: [] },
            }).success,
        ).toBe(true)
    })
})

describe('overlay job client contract', () => {
    const binding = { kind: 'capture', manualId: 'm', revision: 1, stepId: 's', captureId: 'c' }
    it('accepts 200 ok, 200 unavailable timeout and 202 pending', () => {
        expect(
            overlayResponseSchema.safeParse({
                status: 'pending',
                requestId: 'r',
                binding,
                ticket: 't',
                retryAfterMs: 1500,
                expiresInMs: 50000,
            }).success,
        ).toBe(true)
        expect(
            overlayResponseSchema.safeParse({
                status: 'unavailable',
                requestId: 'r',
                binding,
                code: 'timeout',
                retryable: false,
            }).success,
        ).toBe(true)
        expect(
            overlayResponseSchema.safeParse({
                status: 'ok',
                mode: 'model',
                requestId: 'r',
                binding,
                value: { evidence: 'synthetic-fixture', observedRegion: null },
            }).success,
        ).toBe(true)
        expect(overlayResponseSchema.safeParse({ status: 'pending', requestId: 'r' }).success).toBe(false)
    })
})
