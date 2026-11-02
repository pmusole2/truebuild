import { fireEvent, render, screen, within } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    screenDocumentV2Schema,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import { FeedbackProvider } from '../../ui/feedback'
import { ThemeProvider } from '../../theme/theme'
import { activeDocumentVariant } from '../document-runtime/use-document'
import { CompareColumns } from './compare-columns'
import { DocumentRenderer, capabilityInternalsId } from './document-renderer'
import { sharedFallbackDocument } from './fallback-v2'
import { sha256Hex } from './sha256'
import type { FrameBindings } from './types'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
const session = createDemoManual()
const inputs: ScreenContextInputsV2 = {
    kind: 'guide',
    session,
    stepId: session.reviewedSteps[0]!.stepId,
    captureId: null,
    result: null,
    failure: null,
}
const literal = (text: string): ScreenNodeV2 => ({
    type: 'Text',
    role: 'body',
    content: { kind: 'literal', text },
    emphasis: 'normal',
    tone: 'neutral',
    align: 'start',
})
function compose(extras: readonly ScreenNodeV2[] = []): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    const proposal = buildFallbackProposalV2(material)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            {
                ...proposal,
                body: { type: 'Stack', gap: 'md', align: 'stretch', children: [...extras, proposal.body] },
            },
            { source: 'fallback', evidence: 'synthetic-fixture', fallbackReason: 'disabled' },
            { sha256Hex, now: () => new Date('2026-10-29T00:00:00Z') },
        ),
    )
}
function bindings(overrides: Partial<FrameBindings> = {}): FrameBindings {
    return {
        resolve: () => ({ enabled: true, reason: null, run: jest.fn() }),
        live: null,
        session,
        pageUris: {},
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
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

describe('v2 document ownership without frame or slot conversion', () => {
    it('renders the intact document with one header, one scroll and exactly its primary bar identity', async () => {
        const document = compose([literal('Slide the panel onto the bracket.')])
        await render(
            wrap(
                <DocumentRenderer document={document} bindings={bindings({ testIds: { primary: 'guide-primary' } })} />,
            ),
        )
        expect(screen.getByTestId('document-screen')).toBeTruthy()
        expect(screen.getByText('Slide the panel onto the bracket.')).toBeTruthy()
        expect(screen.getAllByTestId('bottom-bar')).toHaveLength(1)
        expect(screen.getByTestId('guide-primary').props.accessibilityLabel).toBe(document.bar.primary.label)
    })
    it('retains more than fourteen nested authored nodes in document and native order', async () => {
        const texts = Array.from({ length: 17 }, (_, index) => `Authored instruction ${index + 1}.`)
        const document = compose([
            {
                type: 'Stack',
                gap: 'sm',
                align: 'stretch',
                children: [{ type: 'Stack', gap: 'sm', align: 'stretch', children: texts.map(literal) }],
            },
        ])
        const authored: string[] = []
        visitVariantNodesV2(document, '', ({ node }) => {
            if (
                node.type === 'Text' &&
                node.content.kind === 'literal' &&
                node.content.text.startsWith('Authored instruction')
            )
                authored.push(node.content.text)
        })
        expect(authored).toEqual(texts)
        await render(wrap(<DocumentRenderer document={document} bindings={bindings()} />))
        expect(screen.getAllByText(/^Authored instruction/u).map((node) => node.props.children)).toEqual(texts)
    })
    it('leaves an authored instruction before the document figure instead of splitting a pinned hero', () => {
        const document = compose([literal('Do this before the figure.')])
        const leaves: ScreenNodeV2[] = []
        visitVariantNodesV2(document, '', ({ node }) => {
            if (!('children' in node)) leaves.push(node)
        })
        const instruction = leaves.findIndex(
            (node) =>
                node.type === 'Text' &&
                node.content.kind === 'literal' &&
                node.content.text === 'Do this before the figure.',
        )
        const figure = leaves.findIndex((node) => node.type === 'Image' || node.type === 'ManualPage')
        expect(instruction).toBeGreaterThanOrEqual(0)
        expect(figure).toBeGreaterThan(instruction)
    })
    it('selects the whole reading error variant including its own bar', () => {
        const document = sharedFallbackDocument({ ...inputs, kind: 'reading', stepId: null })
        const chosen = activeDocumentVariant(document, 'error')
        expect(chosen.activeState).toBe('error')
        expect(chosen.variant).toBe(document.states.error)
        expect(chosen.variant.bar.primary.label.length).toBeGreaterThan(0)
    })
    it('never gains a secondary action absent from the v2 document', async () => {
        const document = sharedFallbackDocument({
            ...inputs,
            kind: 'completion',
            stepId: null,
            completedStepIds: session.reviewedSteps.map((step) => step.stepId),
        })
        expect(document.bar.secondary).toBeNull()
        await render(wrap(<DocumentRenderer document={document} bindings={bindings()} />))
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
    })
})

describe('v2 validation rejects whole documents', () => {
    it('rejects omission of required manual facts instead of appending native content', () => {
        const document = compose()
        expect(document.requirements.facts.length).toBeGreaterThan(0)
        expect(
            screenDocumentV2Schema.safeParse({ ...document, body: literal('No required facts here.') }).success,
        ).toBe(false)
    })
    it('rejects an unknown intent in the real primary action schema', () => {
        const document = compose()
        expect(
            screenDocumentV2Schema.safeParse({
                ...document,
                bar: {
                    ...document.bar,
                    primary: { ...document.bar.primary, intent: { intent: 'navigate', target: 'nowhere' } },
                },
            }).success,
        ).toBe(false)
    })
    it('keeps a result behind its pending variant when no matching held photo is available', async () => {
        const document = sharedFallbackDocument({
            ...inputs,
            kind: 'result',
            captureId: 'cap-1',
            result: {
                kind: 'check',
                value: {
                    decision: 'pass',
                    reason: 'Looks right.',
                    sourceRefs: [],
                    missingEvidence: [],
                    observedRegion: null,
                },
            },
        })
        await render(wrap(<DocumentRenderer document={document} bindings={bindings()} />))
        expect(screen.queryByText('Looks right.')).toBeNull()
        expect(screen.getByTestId('document-screen')).toBeTruthy()
    })
})

describe('shared complete deterministic v2 fallbacks', () => {
    it('builds every supported kind through the unchanged public composer without a legacy adapter', () => {
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
            const document = sharedFallbackDocument({
                ...inputs,
                kind,
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
                ...(kind === 'camera' ? { uiState: { camera: { mode: 'build-photo', permission: 'granted' } } } : {}),
            })
            expect(document.metadata.source).toBe('fallback')
            expect(document.bar.primary.label.length).toBeGreaterThan(0)
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        }
    })
    it('reading carries pending/error variants and live progress instead of invented counts', () => {
        const document = sharedFallbackDocument({ ...inputs, kind: 'reading', stepId: null })
        expect(document.states.pending).not.toBeNull()
        expect(document.states.error).not.toBeNull()
        const progress: ScreenNodeV2[] = []
        visitVariantNodesV2(document, '', ({ node }) => {
            if (node.type === 'Progress') progress.push(node)
        })
        expect(progress.length).toBeGreaterThan(0)
        expect(progress.every((node) => node.type === 'Progress' && node.binding === 'reading')).toBe(true)
    })
    it('compare panes retain distinct real manual titles and each actual first-page image', async () => {
        const alpha = { ...createDemoManual(), manualId: 'm-a', title: 'Alpha manual' }
        const beta = { ...createDemoManual(), manualId: 'm-b', title: 'Beta manual' }
        beta.reviewedSteps[0]!.title = 'Attach the bracket'
        const pane = (manual: typeof session, uri: string): Parameters<typeof CompareColumns>[0]['panes'][number] => ({
            manualId: manual.manualId,
            title: manual.title,
            note: 'Local fallback guide',
            document: sharedFallbackDocument({ ...inputs, session: manual, stepId: manual.reviewedSteps[0]!.stepId }),
            bindings: bindings({ session: manual, pageUris: { [manual.pages[0]!.pageId]: uri } }),
        })
        await render(
            wrap(<CompareColumns panes={[pane(alpha, 'file:///alpha.png'), pane(beta, 'file:///beta.png')]} />),
        )
        for (const [manual, uri] of [
            [alpha, 'file:///alpha.png'],
            [beta, 'file:///beta.png'],
        ] as const) {
            const shown = within(screen.getByTestId(`compare-pane-${manual.manualId}`))
            expect(shown.getByRole('header', { name: manual.title })).toBeTruthy()
            const hero = shown.getAllByTestId('guide-hero-picture')[0]!
            await fireEvent(hero, 'layout', { nativeEvent: { layout: { width: 300, height: 200 } } })
            expect(shown.getByLabelText('Picture from your manual').props.source).toEqual({ uri })
            expect(shown.getAllByText(manual.reviewedSteps[0]!.title).length).toBeGreaterThan(0)
        }
        expect(screen.queryByText(/Untitled/u)).toBeNull()
    })
})
it('keeps actual capability exclusion ids separate from document content', () => {
    expect(capabilityInternalsId('CameraView')).toBe('truebuild-capability-internals:CameraView')
})
