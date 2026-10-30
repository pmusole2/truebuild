import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoManual, verifyDocumentAgainstInputsV2, type ScreenContextInputsV2 } from '@truebuild/contracts'
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
    it('keeps the authored Home while an ordinary working activity is running', () => {
        const doc = recordedDocument({ ...base, uiState: { ...base.uiState, busy: { activity: 'working' } } })
        expect(doc).not.toBeNull()
        expect(doc!.metadata.authoring?.fixtureId).toBe('recorded-home-sol-v1')
    })
    it('keeps the actual authored Saving state during Home persistence, with no new provider claim', () => {
        const doc = recordedDocument({ ...base, uiState: { ...base.uiState, busy: { activity: 'saving' } } })
        expect(doc).not.toBeNull()
        expect(doc!.metadata.authoring?.fixtureId).toBe('recorded-home-saving-sol-v1')
        expect(doc!.states.busy!.header.title).toEqual({ kind: 'literal', text: 'Saving…' })
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
            model: 'gpt-6.1-sol',
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

describe('recorded-generation metadata boundary', () => {
    afterEach(() => {
        vi.doUnmock('../documents/recorded/recorded-home.runtime.json')
        vi.resetModules()
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
                              model: 'gpt-6.1-sol',
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
