import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    cameraAccessV2,
    createDemoManual,
    verifyDocumentAgainstInputsV2,
    variantsOfV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import { recordedDocument } from './recorded-runtime'
import { sha256Hex } from '../documents/sha256'

const base: ScreenContextInputsV2 = {
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: { library: { entries: [], soleManualId: null } },
}

describe('bound recorded model documents', () => {
    it.each(['working', null] as const)('binds the held Reading problem notice with activity=%s', (activity) => {
        const inputs: ScreenContextInputsV2 = {
            ...base,
            kind: 'reading',
            session: createDemoManual(),
            uiState: {
                reading: { cancellation: 'confirm-before-stop' },
                failure: { notice: true },
                busy: activity === null ? null : { activity },
            },
        }
        const document = recordedDocument(inputs)
        expect(document).not.toBeNull()
        expect(document!.metadata.authoring?.fixtureId).toBe('recorded-reading-notice-sol-v1')
        expect(verifyDocumentAgainstInputsV2(document!, inputs, sha256Hex)).toEqual([])
        for (const { name, variant, prefix } of variantsOfV2(document!)) {
            let notices = 0
            visitVariantNodesV2(variant, prefix, ({ node }) => {
                if (node.type === 'Text' && node.content.kind === 'bound' && node.content.key === 'operation-notice')
                    notices++
            })
            expect(notices).toBe(name === 'error' || name === 'recovery' ? 1 : 0)
        }
    })

    const globals: ScreenContextInputsV2[] = [
        {
            ...base,
            kind: 'more',
            uiState: {
                sections: ['how-it-works', 'settings', 'tips', 'about-this-check'],
                language: { options: ['en', 'es', 'fr', 'de', 'pt-BR'] },
                settings: { storage: true },
            },
        },
        {
            ...base,
            kind: 'judge',
            uiState: { sections: ['how-it-works', 'settings', 'tips', 'about-this-check'] },
        },
        {
            ...base,
            kind: 'camera',
            uiState: {
                camera: { mode: 'manual-page', permission: 'granted', failed: false, canAskAgain: true },
            },
        },
    ]

    it.each(globals)('binds a complete initial nonfactual $kind without a donor or provider receipt', (inputs) => {
        const doc = recordedDocument(inputs)
        expect(doc).not.toBeNull()
        expect(doc!.metadata.source).toBe('generated')
        expect(doc!.metadata.evidence).toBe('synthetic-fixture')
        expect(doc!.metadata.model).toBeNull()
        expect(doc!.facts).toEqual([])
        expect(verifyDocumentAgainstInputsV2(doc!, inputs, sha256Hex)).toEqual([])
    })

    it('keeps the page camera mounted in its actual saving sibling and pending variant', () => {
        const inputs: ScreenContextInputsV2 = {
            ...globals[2]!,
            uiState: { ...globals[2]!.uiState, busy: { activity: 'saving' } },
        }
        const doc = recordedDocument(inputs)
        expect(doc).not.toBeNull()
        expect(doc!.metadata.authoring?.fixtureId).toBe('recorded-camera-page-saving-sol-v1')
        expect(doc!.states.busy!.header.title).toEqual({ kind: 'literal', text: 'Saving your progress' })
        expect(verifyDocumentAgainstInputsV2(doc!, inputs, sha256Hex)).toEqual([])
    })

    it.each(globals)('rejects held/factual context on global $kind', (inputs) => {
        expect(recordedDocument({ ...inputs, stepId: 'step-1', session: createDemoManual() })).toBeNull()
        expect(recordedDocument({ ...inputs, captureId: 'held-photo' })).toBeNull()
        expect(recordedDocument({ ...inputs, failure: 'provider_error' })).toBeNull()
        expect(
            recordedDocument({
                ...inputs,
                result: {
                    kind: 'question',
                    question: 'Which way?',
                    value: { answer: 'Follow the cited diagram.', sourceRefs: [], missingEvidence: [] },
                },
            }),
        ).toBeNull()
        expect(
            recordedDocument({
                ...inputs,
                companionAnswer: {
                    question: 'Which way?',
                    value: { answer: 'Follow the cited diagram.', sourceRefs: [], missingEvidence: [] },
                },
            }),
        ).toBeNull()
        expect(
            recordedDocument({
                ...inputs,
                uiState: {
                    ...inputs.uiState,
                    capture: { captureId: 'held-photo', reusable: true, target: null, questionDraftPresent: false },
                },
            }),
        ).toBeNull()
        if (inputs.kind !== 'camera') expect(recordedDocument({ ...inputs, session: createDemoManual() })).toBeNull()
    })

    it('rejects build camera mode and unavailable global settings rather than borrowing another raw family', () => {
        for (const camera of [
            { mode: 'build-photo', permission: 'undetermined' },
            { mode: 'build-photo', permission: 'denied', canAskAgain: false },
            { mode: 'build-photo', permission: 'granted', failed: true },
            { mode: 'build-photo', permission: 'granted', failed: false },
        ] as const) {
            expect(recordedDocument({ ...globals[2]!, uiState: { camera } })).toBeNull()
        }
        expect(recordedDocument({ ...globals[0]!, uiState: { ...globals[0]!.uiState, settings: null } })).toBeNull()
        expect(recordedDocument({ ...globals[0]!, uiState: { ...globals[0]!.uiState, language: null } })).toBeNull()
        expect(recordedDocument({ ...globals[0]!, uiState: { ...globals[0]!.uiState, sections: [] } })).toBeNull()
    })
    it('keeps the authored Home while an ordinary working activity is running', () => {
        const doc = recordedDocument({ ...base, uiState: { ...base.uiState, busy: { activity: 'working' } } })
        expect(doc).not.toBeNull()
        expect(doc!.metadata.authoring?.fixtureId).toBe('recorded-home-sol-v1')
    })
    it('keeps the actual authored Saving state during Home persistence, with no new provider claim', () => {
        const doc = recordedDocument({ ...base, uiState: { ...base.uiState, busy: { activity: 'saving' } } })
        expect(doc).not.toBeNull()
        expect(doc!.metadata.authoring?.fixtureId).toBe('recorded-home-saving-sol-v1')
        expect(doc!.states.busy!.header.title).toEqual({ kind: 'literal', text: 'Saving your progress' })
        expect(doc!.metadata.model).toBeNull()
    })
    it.each([
        ['Home with a step', { ...base, stepId: 'unexpected-step' }],
        [
            'Reading with a failure',
            {
                ...base,
                kind: 'reading' as const,
                failure: 'provider_error' as const,
                uiState: { reading: { cancellation: 'confirm-before-stop' as const } },
            },
        ],
    ])('rejects launch-family inputs outside its witnessed scope: %s', (_label, inputs) => {
        expect(recordedDocument(inputs)).toBeNull()
    })
    it('does not earn Read manual from a recording when the current pages cannot be read', () => {
        const session = createDemoManual()
        expect(
            recordedDocument({
                ...base,
                kind: 'pages',
                session,
                uiState: {
                    pages: {
                        items: session.pages.map(({ pageId, width, height }) => ({ pageId, width, height })),
                        maxPages: 20,
                        canRead: false,
                        languageOptions: ['en'],
                    },
                },
            }),
        ).toBeNull()
    })
    it('serves a validated generated first Home with original author provenance and unknown provider metrics', () => {
        const doc = recordedDocument(base)
        expect(doc).not.toBeNull()
        expect(doc!.metadata.source).toBe('generated')
        expect(doc!.metadata.evidence).toBe('synthetic-fixture')
        expect(doc!.metadata.model).toBeNull()
        expect(doc!.metadata.effort).toBeNull()
        expect(doc!.metadata.authoring).toMatchObject({
            model: 'Test fixture',
            effort: 'ultra',
            fixtureId: 'recorded-home-sol-v1',
        })
        expect(Object.values(doc!.metadata.timing).every((value) => value === null)).toBe(true)
        expect(Object.values(doc!.metadata.usage).every((value) => value === null)).toBe(true)
        expect(verifyDocumentAgainstInputsV2(doc!, base, sha256Hex)).toEqual([])
    })

    it('binds the authored cancelled Pages to actual page identities and keeps the stopped-state witness', () => {
        const session = { ...createDemoManual(), manualId: 'actual-manual', revision: 8 }
        const inputs: ScreenContextInputsV2 = {
            ...base,
            kind: 'pages',
            session,
            uiState: {
                cancelled: { reading: true },
                pages: {
                    items: session.pages.map(({ pageId, width, height }) => ({ pageId, width, height })),
                    maxPages: 20,
                    canRead: true,
                    languageOptions: ['en', 'es'],
                },
            },
        }
        const doc = recordedDocument(inputs)
        expect(doc).not.toBeNull()
        expect(doc!.bound.manualId).toBe('actual-manual')
        expect(doc!.bound.revision).toBe(8)
        expect(doc!.requirements.notice).toBe(true)
        expect(doc!.metadata.authoring?.fixtureId).toBe('recorded-pages-cancelled-sol-v1')
        expect(verifyDocumentAgainstInputsV2(doc!, inputs, sha256Hex)).toEqual([])
    })

    it('does not turn a factual Guide into an initial-screen recording', () => {
        expect(recordedDocument({ ...base, kind: 'guide', session: createDemoManual(), stepId: 'step-1' })).toBeNull()
    })
})

describe('initial manual-page camera consent witnesses', () => {
    const cases: NonNullable<ScreenUiStateV2['camera']>[] = [
        { mode: 'manual-page', permission: 'undetermined', canAskAgain: true },
        { mode: 'manual-page', permission: 'undetermined', failed: true, canAskAgain: true },
        { mode: 'manual-page', permission: 'undetermined', failed: true, canAskAgain: null },
        { mode: 'manual-page', permission: 'denied' },
        { mode: 'manual-page', permission: 'denied', canAskAgain: true },
        { mode: 'manual-page', permission: 'denied', failed: true, canAskAgain: true },
        { mode: 'manual-page', permission: 'denied', canAskAgain: false },
        { mode: 'manual-page', permission: 'undetermined', failed: true, canAskAgain: false },
        { mode: 'manual-page', permission: 'granted', failed: true, canAskAgain: true },
        { mode: 'manual-page', permission: 'granted', failed: true, canAskAgain: false },
    ]
    it.each(cases)('selects exact earned access, with missing permission winning over failure: %j', (camera) => {
        const access = cameraAccessV2(camera)
        expect(access).not.toBe('ready')
        for (const saving of [false, true]) {
            const inputs: ScreenContextInputsV2 = {
                ...base,
                kind: 'camera',
                uiState: { camera, ...(saving ? { busy: { activity: 'saving' } } : {}) },
            }
            const doc = recordedDocument(inputs)
            expect(doc).not.toBeNull()
            expect(doc!.metadata.authoring?.fixtureId).toBe(
                `recorded-camera-page-${access}${saving ? '-saving' : ''}-sol-v1`,
            )
            expect(doc!.bar.primary.intent).toEqual(
                access === 'allow'
                    ? { intent: 'confirm', target: 'camera-permission' }
                    : access === 'settings'
                      ? { intent: 'open-details', target: 'device-settings' }
                      : { intent: 'retry', target: 'camera' },
            )
            expect(verifyDocumentAgainstInputsV2(doc!, inputs, sha256Hex)).toEqual([])
            const changedPermission: ScreenContextInputsV2 = {
                ...inputs,
                uiState: {
                    ...inputs.uiState,
                    camera: { mode: 'manual-page', permission: 'granted', failed: false, canAskAgain: true },
                },
            }
            expect(verifyDocumentAgainstInputsV2(doc!, changedPermission, sha256Hex)).not.toEqual([])
            expect(doc!.facts).toEqual([])
            for (const { variant, prefix } of variantsOfV2(doc!)) {
                expect(variant.overlays).toEqual([])
                visitVariantNodesV2(variant, prefix, ({ node }) => expect(node.type).not.toBe('CameraView'))
            }
        }
    })

    afterEach(() => {
        for (const access of ['allow', 'settings', 'retry'])
            for (const suffix of ['', '-saving'])
                vi.doUnmock(`../documents/recorded/recorded-camera-page-${access}${suffix}.proposal.json`)
        vi.resetModules()
    })

    it.each([
        ['allow', 'recorded-camera-page', { mode: 'manual-page', permission: 'undetermined', canAskAgain: true }],
        ['settings', 'recorded-camera-page-allow', { mode: 'manual-page', permission: 'denied', canAskAgain: false }],
        ['retry', 'recorded-camera-page-settings', { mode: 'manual-page', permission: 'granted', failed: true }],
    ] as const)(
        'fails closed when %s raw source is replaced by a different access family',
        async (access, other, camera) => {
            for (const suffix of ['', '-saving']) {
                vi.resetModules()
                const raw = await vi.importActual<{ default: unknown }>(
                    `../documents/recorded/${other}${suffix}.proposal.json`,
                )
                vi.doMock(`../documents/recorded/recorded-camera-page-${access}${suffix}.proposal.json`, () => ({
                    default: raw.default,
                }))
                const isolated = await import('./recorded-runtime')
                expect(
                    isolated.recordedDocument({
                        ...base,
                        kind: 'camera',
                        uiState: { camera, ...(suffix === '' ? {} : { busy: { activity: 'saving' } }) },
                    }),
                ).toBeNull()
            }
        },
    )
})

describe('recorded-generation metadata boundary', () => {
    afterEach(() => {
        vi.doUnmock('../documents/recorded/recorded-home.runtime.json')
        vi.doUnmock('../documents/recorded/recorded-more-global.proposal.json')
        vi.resetModules()
    })

    it('refuses an otherwise valid synthetic proposal when its retained integrity pin differs', async () => {
        vi.resetModules()
        const runtime = await vi.importActual<{ default: Record<string, unknown> }>(
            '../documents/recorded/recorded-home.runtime.json',
        )
        vi.doMock('../documents/recorded/recorded-home.runtime.json', () => ({
            default: { ...runtime.default, proposalSha256: '0'.repeat(64) },
        }))
        const isolated = await import('./recorded-runtime')
        expect(isolated.recordedDocument(base)).toBeNull()
    })

    it('fails closed if an initial global source asks for an unavailable binding', async () => {
        vi.resetModules()
        const raw = await vi.importActual<{ default: { body: unknown } }>(
            '../documents/recorded/recorded-more-global.proposal.json',
        )
        vi.doMock('../documents/recorded/recorded-more-global.proposal.json', () => ({
            default: {
                ...raw.default,
                body: { type: 'Choice', prompt: null, options: { mode: 'bound', binding: 'part-target' } },
            },
        }))
        const isolated = await import('./recorded-runtime')
        expect(
            isolated.recordedDocument({
                ...base,
                kind: 'more',
                uiState: {
                    sections: ['how-it-works', 'settings', 'tips', 'about-this-check'],
                    language: { options: ['en', 'es', 'fr', 'de', 'pt-BR'] },
                    settings: { storage: true },
                },
            }),
        ).toBeNull()
    })

    it.each([
        ['accepts a recorded response without a synthetic author', false, true],
        ['rejects a recorded response carrying synthetic authoring', true, false],
    ] as const)('%s', async (_label, withAuthor, accepted) => {
        vi.resetModules()
        // Controlled metadata module boundary only. No injection surface is added to production or shipped records.
        vi.doMock('../documents/recorded/recorded-home.runtime.json', () => ({
            default: {
                evidence: 'recorded-generation',
                fixtureId: 'runtime-provenance-test',
                model: 'muse-wonder-1.0',
                effort: 'max',
                recordedAt: '2026-10-30T00:00:00.000Z',
                promptVersion: 0,
                repaired: false,
                ...(withAuthor
                    ? {
                          authoring: {
                              model: 'Test fixture',
                              effort: 'ultra',
                              recordedAt: '2026-10-30T00:00:00.000Z',
                              fixtureId: 'unexpected-synthetic-author',
                          },
                      }
                    : {}),
            },
        }))
        const isolated = await import('./recorded-runtime')
        const doc = isolated.recordedDocument(base)
        if (accepted) {
            expect(doc).not.toBeNull()
            expect(doc!.metadata.evidence).toBe('recorded-generation')
            expect(doc!.metadata.fixtureId).toBe('runtime-provenance-test')
            expect(doc!.metadata.authoring).toBeUndefined()
        } else {
            expect(doc).toBeNull()
        }
    })
})
