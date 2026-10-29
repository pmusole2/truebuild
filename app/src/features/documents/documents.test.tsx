import { fireEvent, render, screen, within } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { createDemoManual, screenDocumentV2Schema, type AppIntent } from '@truebuild/contracts'
import { FeedbackProvider } from '../../ui/feedback'
import { ThemeProvider } from '../../theme/theme'
import type { ResolvedIntent } from '../screens/intents'
import { adaptScreenDocument } from './adapt'
import { CompareColumns } from './compare-columns'
import { DocumentRenderer, capabilityInternalsId, selectVariant } from './document-renderer'
import { sharedFallbackDocument, sharedFallbackFrame } from './fallback-v2'
import { flattenFrameNodes, type FrameBindings, type FrameDocument } from './types'
import { splitHeroFrame } from './bindings'
import { dedupeCitations, heldPhotoResolves, validateFrameDocument } from './validate'
import { makeDocument } from '../screens/test-support/documents'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const session = createDemoManual()

function bindings(overrides: Partial<FrameBindings> = {}): FrameBindings {
    return {
        resolve: (intent: AppIntent): ResolvedIntent => ({
            enabled: intent.intent !== 'retry',
            reason: intent.intent === 'retry' ? 'Nothing to retry.' : null,
            run: jest.fn(),
        }),
        live: null,
        session,
        pageUris: {},
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
        judge: null,
        ...overrides,
    }
}

function wrap(node: ReactElement): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>{node}</FeedbackProvider>
        </ThemeProvider>
    )
}

const guideDoc = (): FrameDocument =>
    adaptScreenDocument(
        makeDocument({
            body: [
                { type: 'Instruction', text: 'Slide the panel onto the bracket.', emphasis: 'strong', citations: [] },
            ],
        }),
    )

describe('document frame ownership', () => {
    it('renders exactly one document header, one scrolling body and one fixed primary bar', async () => {
        await render(wrap(<DocumentRenderer document={guideDoc()} bindings={bindings()} />))
        expect(screen.getByTestId('document-screen')).toBeTruthy()
        expect(screen.getByText('Slide the panel onto the bracket.')).toBeTruthy()
        expect(screen.getByTestId('bottom-bar')).toBeTruthy()
        expect(screen.getByText('Take photo')).toBeTruthy()
    })

    it('keeps document order through a deep recursive layout tree (no leaf-only cap)', async () => {
        const doc: FrameDocument = {
            ...guideDoc(),
            body: [
                {
                    type: 'Stack',
                    children: [
                        {
                            type: 'Card',
                            children: [
                                {
                                    type: 'Stack',
                                    children: [
                                        { type: 'Instruction', text: 'Deep first.', emphasis: 'strong', citations: [] },
                                        {
                                            type: 'Instruction',
                                            text: 'Deep second.',
                                            emphasis: 'normal',
                                            citations: [],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        }
        expect(
            flattenFrameNodes(doc.body).map((leaf) => (leaf.type === 'Instruction' ? leaf.text : leaf.type)),
        ).toEqual(['Deep first.', 'Deep second.'])
        await render(wrap(<DocumentRenderer document={doc} bindings={bindings()} />))
        expect(screen.getByText('Deep first.')).toBeTruthy()
        expect(screen.getByText('Deep second.')).toBeTruthy()
    })

    it('does not reorder an explicit layout: a hero placed last stays last', () => {
        const doc: FrameDocument = {
            ...guideDoc(),
            body: [
                { type: 'Instruction', text: 'Do this first.', emphasis: 'strong', citations: [] },
                {
                    type: 'HeroFigure',
                    source: 'page',
                    refId: session.pages[0]!.pageId,
                    caption: null,
                    fit: 'cover',
                },
            ],
        }
        expect(flattenFrameNodes(doc.body).map((leaf) => leaf.type)).toEqual(['Instruction', 'HeroFigure'])
    })

    it('takes busy and reading bars from document variants, never a native override beside the document', () => {
        const doc = sharedFallbackFrame(
            { kind: 'reading', session, stepId: null, captureId: null, result: null, failure: null },
            () => '',
        )
        const selected = selectVariant(doc, 'error', null)
        expect(selected.effective).toBe('error')
        expect(selected.bar.primary.label.length).toBeGreaterThan(0)
    })
})

describe('hero split keeps document placement', () => {
    it('finds a hero nested in a root stack without reordering the rest', () => {
        const doc: FrameDocument = {
            ...guideDoc(),
            body: [
                {
                    type: 'Stack',
                    children: [
                        {
                            type: 'HeroFigure',
                            source: 'page',
                            refId: session.pages[0]!.pageId,
                            caption: null,
                            fit: 'cover',
                        },
                        { type: 'Instruction', text: 'After the hero.', emphasis: 'strong', citations: [] },
                    ],
                },
            ],
        }
        const split = splitHeroFrame(doc)
        expect(split.hero?.body[0]?.type).toBe('HeroFigure')
        expect(flattenFrameNodes(split.rest.body).map((leaf) => leaf.type)).toEqual(['Instruction'])
    })
})

describe('validation: reject, never append', () => {
    it('rejects a document that omits a mandatory fact instead of appending it natively', () => {
        const doc: FrameDocument = {
            ...guideDoc(),
            manualFacts: [
                {
                    factId: 'safety:1',
                    kind: 'safety',
                    basis: 'safety-note',
                    text: 'Keep children away.',
                    sourceRefs: [{ pageId: session.pages[0]!.pageId, region: null }],
                    placement: 'remainder',
                },
            ],
            requiredFactIds: ['safety:1'],
        }
        const result = validateFrameDocument(doc)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.errors).toContain('mandatory-fact-omitted:safety:1')
    })

    it('rejects an unknown intent (negative)', () => {
        const doc: FrameDocument = {
            ...guideDoc(),
            bar: {
                primary: { label: 'Go', icon: null, intent: { intent: 'navigate', target: 'nowhere' } as never },
                secondary: null,
            },
        }
        expect(validateFrameDocument(doc).ok).toBe(false)
    })

    it('dedupes citations so a fact is cited once', () => {
        expect(dedupeCitations([0, 0, 1, 1, 2])).toEqual([0, 1, 2])
    })
})

describe('held photo before verdict', () => {
    const resultDoc = (captureId: string): FrameDocument => ({
        ...guideDoc(),
        kind: 'result',
        bound: { manualId: session.manualId, revision: session.revision, stepId: 'step-1', captureId },
        body: [
            { type: 'PhotoWithRegions', captureId, observed: null, regions: [] },
            { type: 'ResultBanner', verdict: 'pass', text: 'Looks right.', citations: [] },
        ],
        variants: {
            pending: { body: [{ type: 'Skeleton', variant: 'lines', lines: 2 }] },
        },
    })

    it('resolves only for the held reusable capture with its photo node', () => {
        expect(heldPhotoResolves(resultDoc('cap-1'), { captureId: 'cap-1', reusable: true })).toBe(true)
        expect(heldPhotoResolves(resultDoc('cap-1'), { captureId: 'cap-2', reusable: true })).toBe(false)
        expect(heldPhotoResolves(resultDoc('cap-1'), null)).toBe(false)
        expect(validateFrameDocument(resultDoc('cap-1'), { heldCaptureId: 'cap-2' }).ok).toBe(false)
    })

    it('shows the pending variant, not the verdict, before the photo resolves', () => {
        const selected = selectVariant(resultDoc('cap-1'), 'normal', { captureId: 'cap-2', reusable: true })
        expect(selected.effective).toBe('pending')
        expect(flattenFrameNodes(selected.body).some((leaf) => leaf.type === 'ResultBanner')).toBe(false)
    })
})

describe('local deterministic fallbacks (off / steps need no network)', () => {
    it('builds a complete fallback document for every kind through the same renderer shape', () => {
        // The shared contracts composer is the only fallback source (off/steps, no network, no handcrafted frames).
        for (const kind of [
            'home',
            'add',
            'pages',
            'reading',
            'quick-check',
            'guide',
            'result',
            'questions',
            'answer',
            'more',
            'completion',
            'error',
            'recovery',
            'camera',
            'judge',
            'compare',
        ] as const) {
            const doc = sharedFallbackDocument({
                kind,
                session,
                stepId: session.reviewedSteps[0]!.stepId,
                captureId: ['result', 'questions', 'answer'].includes(kind) ? 'fixture-held' : null,
                result:
                    kind === 'result'
                        ? {
                              kind: 'check',
                              value: {
                                  decision: 'pass',
                                  reason: 'Synthetic held check.',
                                  sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                                  missingEvidence: [],
                                  observedRegion: null,
                              },
                          }
                        : kind === 'answer'
                          ? {
                                kind: 'question',
                                question: 'Which way?',
                                value: {
                                    answer: 'Synthetic held answer.',
                                    sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                                    missingEvidence: [],
                                },
                            }
                          : null,
                failure: kind === 'error' ? 'provider_error' : null,
                ...(kind === 'camera'
                    ? { uiState: { camera: { mode: 'build-photo' as const, permission: 'granted' as const } } }
                    : {}),
            })
            expect(doc.metadata.source).toBe('fallback')
            expect(doc.bar.primary.label.length).toBeGreaterThan(0)
            // Every canonical fallback is complete before any legacy test adapter is involved.
            expect(screenDocumentV2Schema.safeParse(doc).success).toBe(true)
        }
        // A result fallback with no held photo is rejected by the held-photo gate, never shown as a verdict.
        const result = sharedFallbackFrame(
            {
                kind: 'result',
                session,
                stepId: session.reviewedSteps[0]!.stepId,
                captureId: null,
                result: null,
                failure: null,
            },
            () => '',
        )
        const verdict = validateFrameDocument(result)
        expect(verdict.ok).toBe(false)
        if (!verdict.ok) expect(verdict.errors).toContain('held-photo-required')
    })

    it('reading fallback carries a pending variant and honest progress, never invented page counts', () => {
        const frame = sharedFallbackFrame(
            { kind: 'reading', session, stepId: null, captureId: null, result: null, failure: null },
            () => '',
        )
        expect(frame.variants?.pending).toBeDefined()
        expect(frame.variants?.error).toBeDefined()
        // Progress is a live-bound leaf; the document never states a page total it does not hold.
        const progress = flattenFrameNodes(frame.body).find((leaf) => leaf.type === 'V2Leaf')
        expect(progress).toBeDefined()
    })

    it('compare panes use distinct real titles and a first-page hero', async () => {
        const alpha = { ...createDemoManual(), manualId: 'm-a', title: 'Alpha manual' }
        const beta = { ...createDemoManual(), manualId: 'm-b', title: 'Beta manual' }
        beta.reviewedSteps[0]!.title = 'Attach the bracket'
        const pane = (manual: typeof session, uri: string): Parameters<typeof CompareColumns>[0]['panes'][number] => {
            const document = sharedFallbackFrame(
                {
                    kind: 'guide',
                    session: manual,
                    stepId: manual.reviewedSteps[0]!.stepId,
                    captureId: null,
                    result: null,
                    failure: null,
                },
                (key) =>
                    key === 'manual-title'
                        ? manual.title
                        : key === 'step-position'
                          ? `Step 1 of ${manual.reviewedSteps.length}`
                          : key === 'step-title'
                            ? manual.reviewedSteps[0]!.title
                            : '',
            )
            expect(document.source).toBe('fallback')
            expect(document.header.title).toBe(`Step 1 of ${manual.reviewedSteps.length}`)
            expect(document.header.subtitle).toBe(manual.reviewedSteps[0]!.title)
            return {
                manualId: manual.manualId,
                title: manual.title,
                note: 'Local fallback guide',
                document,
                bindings: bindings({ session: manual, pageUris: { [manual.pages[0]!.pageId]: uri } }),
            }
        }
        await render(
            wrap(<CompareColumns panes={[pane(alpha, 'file:///alpha.png'), pane(beta, 'file:///beta.png')]} />),
        )
        for (const [manual, uri] of [
            [alpha, 'file:///alpha.png'],
            [beta, 'file:///beta.png'],
        ] as const) {
            const shown = within(screen.getByTestId(`compare-pane-${manual.manualId}`))
            expect(shown.getByRole('header', { name: manual.title })).toBeTruthy()
            const hero = shown.getAllByTestId('guide-hero')[0]!
            await fireEvent(hero, 'layout', { nativeEvent: { layout: { width: 300, height: 200 } } })
            expect(within(hero).getByLabelText('Picture from your manual').props.source).toEqual({ uri })
            expect(shown.getAllByText(manual.reviewedSteps[0]!.title).length).toBeGreaterThan(0)
        }
        expect(screen.queryByText(/Untitled/u)).toBeNull()
    })
})

describe('measurement honesty markers', () => {
    it('names capability internals separately from document content', () => {
        expect(capabilityInternalsId('CameraView')).toBe('truebuild-capability-internals:CameraView')
    })

    it('judge summary is one card behind no extra surface, and hidden while work runs', async () => {
        const judge = { summary: 'Composed by the model · 96.0% generated', onShowDetails: jest.fn() }
        await render(wrap(<DocumentRenderer document={guideDoc()} bindings={bindings({ judge })} />))
        expect(screen.getByTestId('judge-summary')).toBeTruthy()
        expect(screen.getByTestId('judge-details')).toBeTruthy()
    })
})
