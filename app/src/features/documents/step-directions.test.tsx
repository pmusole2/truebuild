import { createHash } from 'node:crypto'
import { fireEvent, render, screen, within } from '@testing-library/react-native'
import type * as ReactModule from 'react'
import type * as ReactNative from 'react-native'
import type { ReactElement, ReactNode } from 'react'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    verifyDocumentAgainstInputsV2,
} from '@truebuild/contracts'
import { ThemeProvider } from '../../theme/theme'
import { DocumentRenderer } from './document-renderer'
import type { FrameBindings } from './types'
let mockMotionStatus: 'motion' | 'fallback' = 'fallback'
jest.mock('../step-motion/guide-step-motion', () => {
    const React = jest.requireActual<typeof ReactModule>('react')
    const { View } = jest.requireActual<typeof ReactNative>('react-native')
    return {
        GuideStepMotion: ({
            fallback,
            onAvailabilityChange,
        }: {
            fallback?: ReactNode
            onAvailabilityChange?: (status: 'motion' | 'fallback') => void
        }): ReactElement => {
            React.useEffect(() => {
                onAvailabilityChange?.(mockMotionStatus)
            }, [onAvailabilityChange])
            return React.createElement(
                View,
                { testID: 'fixture-motion-boundary' },
                mockMotionStatus === 'motion' ? null : fallback,
            )
        },
    }
})
beforeEach(() => {
    mockMotionStatus = 'fallback'
})
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

const ACTIONS = [
    'Turn the panel so the groove faces inward.',
    'Lift the divider and reseat its edge inside the groove.',
    'Tighten the upper bolt until the panel stops moving.',
]
const OPENER = 'See it in the manual'

/** The demo step one, with its procedure actions replaced by the given instructions in order. */
function sessionWithActions(instructions: readonly string[]): ManualSession {
    const session = createDemoManual()
    const step = session.reviewedSteps[0]!
    const sourceRefs = step.correction!.actions[0]!.sourceRefs
    step.actions = instructions.map((instruction, index) => ({
        actionId: `turn-${index + 1}`,
        instruction,
        sourceRefs,
    }))
    step.correction = null
    return session
}

/**
 * The demo step one with two distinct exact regions: its facts cite the first, and the second is left for an opener
 * the test adds. Mirrors the witness move used by the citation dedupe suite.
 */
function sessionWithSeparateRegions(): ManualSession {
    const session = sessionWithActions(ACTIONS)
    const factRef = { pageId: session.pages[0]!.pageId, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }
    const moveKnownWitness = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return
        const object = value as Record<string, unknown>
        if (object.state === 'known' && Array.isArray(object.sourceRefs)) object.sourceRefs = [factRef]
        for (const [key, child] of Object.entries(object)) if (key !== 'sourceRefs') moveKnownWitness(child)
    }
    moveKnownWitness(session.reviewedSteps[0])
    for (const action of session.reviewedSteps[0]!.actions ?? []) action.sourceRefs = [factRef]
    session.reviewedSteps[0]!.safetyNotes = []
    moveKnownWitness(session.parts)
    return session
}

type Shape = (proposal: ReturnType<typeof buildFallbackProposalV2>) => void

/** The composed Guide: the plain-action layout (`stepActions: 1` echo), or the compatibility layout with no echo. */
function guideInputs(session: ManualSession): ScreenContextInputsV2 {
    return {
        kind: 'guide',
        session,
        stepId: 'step-1',
        captureId: null,
        result: null,
        failure: null,
        uiState: { capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false } },
    }
}

function composeGuide(session: ManualSession, shape: Shape | undefined, legacy: boolean): ScreenDocumentV2 {
    const inputs = guideInputs(session)
    const material = documentMaterialV2(inputs, legacy)
    const proposal = buildFallbackProposalV2(material)
    shape?.(proposal)
    return assembleDocumentV2(
        material,
        proposal,
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
        { sha256Hex, now: () => new Date('2026-02-03T04:05:06.000Z') },
    )
}

async function renderGuide(
    session: ManualSession,
    shape?: Shape,
    legacy = false,
): Promise<Awaited<ReturnType<typeof render>>> {
    const document = composeGuide(session, shape, legacy)
    const bindings: FrameBindings = {
        resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
        live: null,
        session,
        pageUris: {},
        pageImageStatus: 'unavailable',
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
    }
    return render(
        (
            <ThemeProvider>
                <DocumentRenderer document={document} bindings={bindings} />
            </ThemeProvider>
        ) as ReactElement,
    )
}

/** A section holding two openers of distinct regions, labelled so that only its own openers match the name. */
const partPictures = (collapsible: boolean): ScreenNodeV2 => ({
    type: 'Section',
    title: { kind: 'literal', text: 'Pictures' },
    collapsible,
    initiallyOpen: !collapsible,
    children: [0, 1].map((index) => ({
        type: 'ManualPage',
        sources: [index],
        fit: 'contain',
        label: { kind: 'literal', text: 'Part pictures' },
        initiallyOpen: false,
    })),
})

type Tree = string | { children?: Tree[] | null } | null
/** Every rendered string in tree order: the order a reader meets them on screen. */
const textsOf = (node: Tree): string[] =>
    node === null ? [] : typeof node === 'string' ? [node] : (node.children ?? []).flatMap(textsOf)
const shownTexts = (): string[] => textsOf(screen.toJSON() as Tree)

describe('step directions', () => {
    it('uses the step title as the page heading and omits its duplicate direction while preserving other facts', async () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.correction = null
        await renderGuide(session)
        expect(screen.getByRole('header', { name: session.reviewedSteps[0]!.title })).toBeTruthy()
        expect(screen.getAllByText(session.reviewedSteps[0]!.title)).toHaveLength(1)
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual(['1.', '2.'])
        expect(screen.getByText('Do this')).toBeTruthy()
    })

    it('moves end-state facts to checks only when no action facts exist and a motion is available', async () => {
        mockMotionStatus = 'motion'
        const session = createDemoManual()
        session.reviewedSteps[0]!.correction = null
        const document = composeGuide(session, undefined, false)
        await renderGuide(session)
        const directions = within(screen.getByTestId('guide-directions'))
        expect(directions.getByText('Follow the motion above')).toBeTruthy()
        const checks = within(screen.getByTestId('guide-checks'))
        for (const fact of document.facts.filter((item) => item.kind === 'orientation' || item.kind === 'connection')) {
            expect(directions.queryByText(fact.text)).toBeNull()
            expect(checks.getByText(fact.text)).toBeTruthy()
        }
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual([])
        expect(screen.getAllByRole('link', { name: OPENER }).length).toBeGreaterThan(0)
    })

    it('keeps explicit action facts numbered when motion is available', async () => {
        mockMotionStatus = 'motion'
        await renderGuide(sessionWithActions(ACTIONS))
        const directions = within(screen.getByTestId('guide-directions'))
        for (const action of ACTIONS) expect(directions.getByText(action)).toBeTruthy()
        expect(directions.queryByText('Follow the motion above')).toBeNull()
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual(['1.', '2.', '3.'])
    })

    it('keeps legacy direction facts in their original group even with motion available', async () => {
        mockMotionStatus = 'motion'
        const session = createDemoManual()
        const document = composeGuide(session, undefined, true)
        await renderGuide(session, undefined, true)
        for (const fact of document.facts.filter((item) => item.kind === 'orientation' || item.kind === 'connection'))
            expect(screen.getByText(fact.text)).toBeTruthy()
        expect(screen.queryByText('Follow the motion above')).toBeNull()
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual([])
    })

    it('keeps a source opener reachable in a title-less non-collapsible section', async () => {
        await renderGuide(sessionWithSeparateRegions(), (proposal) => {
            if (proposal.body.type !== 'Scroll') throw new Error('fixture body must scroll')
            proposal.body.children.unshift({
                type: 'Section',
                title: null,
                collapsible: false,
                initiallyOpen: true,
                children: [
                    {
                        type: 'ManualPage',
                        sources: [0],
                        fit: 'contain',
                        label: { kind: 'literal', text: 'Part pictures' },
                        initiallyOpen: false,
                    },
                ],
            })
        })
        const opener = screen.getByRole('link', { name: 'Part pictures' })
        const before = screen.queryAllByText('This manual picture is unavailable.').length
        await fireEvent.press(opener)
        expect(screen.getAllByText('This manual picture is unavailable.')).toHaveLength(before + 1)
    })

    it('keeps every extra manual image reachable when motion is unavailable', async () => {
        await renderGuide(sessionWithSeparateRegions(), (proposal) => {
            if (proposal.body.type !== 'Scroll') throw new Error('fixture body must scroll')
            proposal.body.children.push({
                type: 'Image',
                source: { kind: 'source', index: 1 },
                fit: 'contain',
                ratio: 'wide',
                caption: null,
            })
        })
        const thumb = screen.getByTestId('guide-manual-thumb-1')
        expect(thumb).toBeTruthy()
        const button = thumb.parent
        if (button === null) throw new Error('Missing manual thumbnail control')
        await fireEvent.press(button)
        expect(screen.getByTestId('more-sheet')).toBeTruthy()
        expect(screen.getByTestId('diagram-0')).toBeTruthy()
    })

    it('shows sized and count-only parts once in compact parts using only this step’s quantities', async () => {
        const session = sessionWithActions(ACTIONS)
        const step = session.reviewedSteps[0]!
        session.parts[0]!.name = { state: 'known', value: 'Screw', sourceRefs: step.sourceRefs }
        session.parts[0]!.dimensions = '4 × 16 mm'
        session.parts[0]!.inventoryQuantity = 99
        step.parts[0]!.quantity = { state: 'known', value: 4, sourceRefs: step.sourceRefs }
        session.parts[1]!.name = { state: 'known', value: 'Washer', sourceRefs: step.sourceRefs }
        step.parts.push({
            partId: session.parts[1]!.partId,
            quantity: { state: 'known', value: 6, sourceRefs: step.sourceRefs },
        })
        session.parts.push({
            partId: 'other-screw',
            name: { state: 'known', value: 'Other screw', sourceRefs: step.sourceRefs },
            dimensions: '6 × 90 mm',
            inventoryQuantity: 50,
        })
        const document = composeGuide(session, undefined, false)
        expect(verifyDocumentAgainstInputsV2(document, guideInputs(session), sha256Hex)).toEqual([])
        await renderGuide(session)
        const parts = within(screen.getByTestId('pieces-grid'))
        expect(parts.getByText('Screw')).toBeTruthy()
        expect(parts.getByText('4 × 16 mm')).toBeTruthy()
        expect(parts.getByTestId('piece-tile-side-panel').props.nativeID).toContain('truebuild-render-origin:shell')
        expect(parts.getByText('×4')).toBeTruthy()
        expect(parts.getByText('Washer')).toBeTruthy()
        expect(parts.getByText('×6')).toBeTruthy()
        expect(parts.queryByText(/Other screw|6 × 90 mm|×99|×50|×1$/u)).toBeNull()
        expect(within(screen.getByTestId('guide-directions')).queryByText('Screw')).toBeNull()
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual(['1.', '2.', '3.'])
    })

    it('shows a printed size without inventing an unknown count', async () => {
        const session = sessionWithActions(ACTIONS)
        session.parts[0]!.dimensions = '12 × 24 cm'
        session.parts[0]!.inventoryQuantity = 99
        session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'Count is not printed.' }
        await renderGuide(session)
        expect(screen.getByText('Side panel')).toBeTruthy()
        const parts = within(screen.getByTestId('pieces-grid'))
        expect(parts.getByText('12 × 24 cm')).toBeTruthy()
        expect(parts.queryByText(/×99/u)).toBeNull()
        expect(parts.queryByTestId('piece-quantity-side-panel')).toBeNull()
    })

    it('names every current-step part, even with no size and an unknown count, without its inventory count', async () => {
        const session = sessionWithActions(ACTIONS)
        const step = session.reviewedSteps[0]!
        const names = ['Bolt', 'Washer', 'AA battery']
        const named = (partId: string, value: string): ManualSession['parts'][number] => ({
            ...session.parts[0]!,
            partId,
            name: { state: 'known', value, sourceRefs: step.sourceRefs },
            dimensions: null,
            inventoryQuantity: 5,
        })
        const bound = [named('side-panel', 'Bolt'), named('divider', 'Washer'), named('battery', 'AA battery')]
        session.parts = [...bound, named('stray-clip', 'Unrelated clip')]
        step.parts = bound.map((part) => ({
            partId: part.partId,
            quantity: { state: 'unknown', reason: 'Count is not printed.' },
        }))
        await renderGuide(session)
        const parts = within(screen.getByTestId('pieces-grid'))
        for (const name of names) expect(parts.getByLabelText(name)).toBeTruthy()
        expect(shownTexts()).not.toContain('Unrelated clip')
        expect(shownTexts().filter((text) => /×\s*5\b/u.test(text))).toEqual([])
    })

    it('numbers each action once, in order, beside its exact instruction', async () => {
        const session = sessionWithActions(ACTIONS)
        const step = session.reviewedSteps[0]!
        step.correction = {
            reviewed: true,
            actions: [{ actionId: 'reviewed-fix', instruction: 'Turn the panel back.', sourceRefs: step.sourceRefs }],
        }
        await renderGuide(session)
        const numbered = shownTexts().filter((text) => /^\d+\.$/u.test(text) || ACTIONS.includes(text))
        expect(numbered).toEqual(ACTIONS.flatMap((text, index) => [`${index + 1}.`, text]))
        expect(screen.getByText('Turn the panel back.')).toBeTruthy()
    })

    it('keeps visible numbering at one when a closed detail repeats an action', async () => {
        await renderGuide(sessionWithActions(ACTIONS), (proposal) => {
            proposal.body = {
                type: 'Stack',
                gap: 'md',
                align: 'stretch',
                children: [
                    {
                        type: 'Section',
                        title: { kind: 'literal', text: 'More detail' },
                        collapsible: true,
                        initiallyOpen: false,
                        children: [
                            {
                                type: 'Text',
                                content: { kind: 'fact', factId: 'action:turn-1' },
                                role: 'body',
                                tone: 'neutral',
                                emphasis: 'normal',
                                align: 'start',
                            },
                        ],
                    },
                    proposal.body,
                ],
            }
        })
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual(['1.', '2.', '3.'])
    })

    it('numbers orientation and connection when no motion is available, with the title in the header', async () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.correction = null
        await renderGuide(session)
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual(['1.', '2.'])
        expect(screen.getAllByText(session.reviewedSteps[0]!.title)).toHaveLength(1)
    })

    it('shows a saved step title once in the header before the first numbered direction', async () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        // An unclassified saved step with no actions: its title opens the Directions.
        step.safetyNotes = null
        step.correction = null
        await renderGuide(session)
        expect(screen.getAllByText(step.title)).toHaveLength(1)
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))[0]).toBe('1.')
        expect(shownTexts().indexOf(step.title)).toBeLessThan(shownTexts().indexOf('1.'))
    })

    it('speaks each numbered direction as one item: its step number, then the exact instruction', async () => {
        await renderGuide(sessionWithActions(ACTIONS))
        ACTIONS.forEach((instruction, index) => {
            expect(screen.getByLabelText(`Step ${index + 1}, ${instruction}`)).toBeTruthy()
        })
        expect(shownTexts()).toEqual(expect.arrayContaining(ACTIONS))
    })

    it('keeps a short check list open without an extra disclosure', async () => {
        const session = sessionWithActions(ACTIONS)
        const document = composeGuide(session, undefined, false)
        await renderGuide(session)
        expect(screen.getByRole('header', { name: 'Check your work' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Check your work' })).toBeNull()
        const checks = within(screen.getByTestId('guide-checks'))
        for (const fact of document.facts.filter((item) => ['orientation', 'connection', 'check'].includes(item.kind)))
            expect(checks.getByText(fact.text)).toBeTruthy()
    })

    it('normalizes whitespace and trailing punctuation in title duplicates and renumbers the remaining action', async () => {
        const session = sessionWithActions(ACTIONS)
        const step = session.reviewedSteps[0]!
        const duplicate = `  ${step.title.toUpperCase()} ;  `
        step.actions = [
            { actionId: 'title-copy', instruction: duplicate, sourceRefs: step.sourceRefs },
            { actionId: 'real-action', instruction: ACTIONS[1]!, sourceRefs: step.sourceRefs },
        ]
        await renderGuide(session)
        expect(screen.queryByText(duplicate)).toBeNull()
        expect(screen.getAllByText(step.title)).toHaveLength(1)
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual(['1.'])
        expect(screen.getByLabelText(`Step 1, ${ACTIONS[1]}`)).toBeTruthy()
    })

    it('keeps initiallyOpen semantics for a long Check your work disclosure, and collapses it on press', async () => {
        const session = sessionWithActions(ACTIONS)
        const step = session.reviewedSteps[0]!
        step.visibleChecks = Array.from({ length: 5 }, (_, index) => ({
            checkId: `long-${index}`,
            description: { state: 'known' as const, value: `Cited check ${index + 1}.`, sourceRefs: step.sourceRefs },
        }))
        await renderGuide(session)
        const check = screen.getByRole('button', { name: 'Check your work' })
        expect(check.props.accessibilityState).toMatchObject({ expanded: true })
        await fireEvent.press(check)
        expect(screen.getByRole('button', { name: 'Check your work' }).props.accessibilityState).toMatchObject({
            expanded: false,
        })
    })

    it('leaves a compatibility document with no stepActions echo unnumbered, and it still verifies', async () => {
        const session = sessionWithActions(ACTIONS)
        const document = composeGuide(session, undefined, true)
        expect(document.metadata.stepActions).toBeUndefined()
        expect(verifyDocumentAgainstInputsV2(document, guideInputs(session), sha256Hex)).toEqual([])
        await renderGuide(session, undefined, true)
        expect(shownTexts().filter((text) => /^\d+\.$/u.test(text))).toEqual([])
    })

    it('draws a section source opener in its header before the numbered directions', async () => {
        await renderGuide(sessionWithActions(ACTIONS), (proposal) => {
            const insertCitation = (node: ScreenNodeV2): void => {
                if (node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'Directions')
                    node.children.unshift({ type: 'Citation', sources: [0], label: null, display: 'chip' })
                else if ('children' in node) node.children.forEach(insertCitation)
            }
            insertCitation(proposal.body)
        })
        const texts = shownTexts()
        // A caption-sized opener: its visible words are either the full opener or its short form.
        const openers = texts.flatMap((text, index) => (text === OPENER || text === 'Manual page' ? [index] : []))
        expect(openers).toHaveLength(1)
        expect(openers[0]).toBeLessThan(texts.indexOf('1.'))
        expect(openers[0]).toBeLessThan(texts.indexOf('Check your work'))
    })

    it('shows the step title once when the step has actions', async () => {
        const session = sessionWithActions(ACTIONS)
        await renderGuide(session)
        expect(screen.getAllByText(session.reviewedSteps[0]!.title)).toHaveLength(1)
    })

    it('renders the manual opener as a small caption, never as a heading', async () => {
        await renderGuide(sessionWithActions(ACTIONS))
        const openers = screen.getAllByRole('link', { name: OPENER })
        expect(openers.length).toBeGreaterThan(0)
        for (const opener of openers) expect(within(opener).queryByRole('header')).toBeNull()
        expect(screen.queryByRole('header', { name: OPENER })).toBeNull()
    })

    it('draws one source opener for a section holding several distinct references', async () => {
        await renderGuide(sessionWithSeparateRegions(), (proposal) => {
            if (proposal.body.type !== 'Scroll') throw new Error('fixture body must scroll')
            proposal.body.children.push(partPictures(false))
        })
        expect(screen.getAllByRole('link', { name: 'Part pictures' })).toHaveLength(1)
    })

    it('combines adjacent openers for distinct regions of the same page outside sections', async () => {
        const session = sessionWithSeparateRegions()
        session.reviewedSteps[0]!.sourceRefs.push({
            pageId: session.pages[0]!.pageId,
            region: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
        })
        await renderGuide(session, (proposal) => {
            if (proposal.body.type !== 'Scroll') throw new Error('fixture body must scroll')
            proposal.body.children.push(
                ...[0, 2].map((index): ScreenNodeV2 => ({
                    type: 'ManualPage',
                    sources: [index],
                    fit: 'contain',
                    label: { kind: 'literal', text: 'Part pictures' },
                    initiallyOpen: false,
                })),
            )
        })
        const openers = screen.getAllByRole('link', { name: 'Part pictures' })
        expect(openers).toHaveLength(1)
        const missingPictures = screen.queryAllByText('This manual picture is unavailable.').length
        await fireEvent.press(openers[0]!)
        expect(screen.getAllByText('This manual picture is unavailable.')).toHaveLength(missingPictures + 2)
    })

    it('preserves a part page added to the source plan when its opener joins a figure citation', async () => {
        const session = sessionWithSeparateRegions()
        const pageId = session.pages[0]!.pageId
        const step = session.reviewedSteps[0]!
        step.sourceRefs = [
            step.actions![0]!.sourceRefs[0]!,
            { pageId, region: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } },
        ]
        for (const part of session.parts)
            if (part.name.state === 'known') part.name.sourceRefs = [{ pageId, region: null }]
        await renderGuide(session, (proposal) => {
            let wrapped = false
            const wrapPart = (node: ScreenNodeV2): ScreenNodeV2 => {
                if (!wrapped && node.type === 'PieceTile') {
                    wrapped = true
                    return {
                        type: 'Stack',
                        gap: 'sm',
                        align: 'stretch',
                        children: [
                            {
                                type: 'Citation',
                                sources: [1],
                                label: { kind: 'literal', text: 'Part pictures' },
                                display: 'chip',
                            },
                            node,
                        ],
                    }
                }
                return 'children' in node ? { ...node, children: node.children.map(wrapPart) } : node
            }
            proposal.body = wrapPart(proposal.body)
            expect(wrapped).toBe(true)
        })
        const opener = screen.getByRole('link', { name: 'Part pictures' })
        const missingPictures = screen.queryAllByText('This manual picture is unavailable.').length
        await fireEvent.press(opener)
        expect(screen.getAllByText('This manual picture is unavailable.')).toHaveLength(missingPictures + 2)
    })

    it("keeps a closed section's references behind its own disclosure", async () => {
        await renderGuide(sessionWithSeparateRegions(), (proposal) => {
            if (proposal.body.type !== 'Scroll') throw new Error('fixture body must scroll')
            proposal.body.children.push(partPictures(true))
        })
        expect(screen.queryAllByRole('link', { name: 'Part pictures' })).toHaveLength(0)
        await fireEvent.press(screen.getByRole('button', { name: 'Pictures' }))
        expect(screen.getAllByRole('link', { name: 'Part pictures' })).toHaveLength(1)
    })
})
