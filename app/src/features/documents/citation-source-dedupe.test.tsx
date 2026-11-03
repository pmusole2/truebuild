import { createHash } from 'node:crypto'
import { fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import { ThemeProvider } from '../../theme/theme'
import { DocumentRenderer } from './document-renderer'
import type { FrameBindings } from './types'
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

async function renderSources(extra: ScreenNodeV2[] = [], separateFactRegion = false): Promise<void> {
    const session = createDemoManual()
    if (separateFactRegion) {
        const factRef = { pageId: session.pages[0]!.pageId, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }
        const moveKnownWitness = (value: unknown): void => {
            if (value === null || typeof value !== 'object') return
            const object = value as Record<string, unknown>
            if (object.state === 'known' && Array.isArray(object.sourceRefs)) {
                object.sourceRefs = [factRef]
            }
            for (const [key, child] of Object.entries(object)) if (key !== 'sourceRefs') moveKnownWitness(child)
        }
        moveKnownWitness(session.reviewedSteps[0])
        // Correction directions are now visible too; keep their witnesses with the other fixture facts.
        for (const action of session.reviewedSteps[0]!.correction?.actions ?? []) action.sourceRefs = [factRef]
        // No visible title/page-only citation may pre-offer source 0 in this closed-section test.
        // Directions and part pictures cite the other exact region; the diagram itself is not a citation opener.
        session.reviewedSteps[0]!.safetyNotes = []
        moveKnownWitness(session.parts)
    }
    const inputs: ScreenContextInputsV2 = {
        kind: 'guide',
        session,
        stepId: 'step-1',
        captureId: null,
        result: null,
        failure: null,
        uiState: { capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false } },
    }
    const material = documentMaterialV2(inputs)
    const proposal = buildFallbackProposalV2(material)
    if (proposal.body.type !== 'Scroll') throw new Error('fixture body must scroll')
    if (separateFactRegion) {
        // Offer the factual region once; the two source groups below refer to the distinct full-page source.
        proposal.body.children.push({ type: 'Citation', sources: [1], label: null, display: 'chip' })
    }
    proposal.body.children.push(...extra)
    const document = assembleDocumentV2(
        material,
        proposal,
        {
            source: 'fallback',
            evidence: 'local-deterministic',
            fallbackReason: 'disabled',
        },
        { sha256Hex, now: () => new Date('2026-02-03T04:05:06.000Z') },
    )
    const bindings: FrameBindings = {
        resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
        live: null,
        session,
        pageUris: {},
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
    }
    await render(
        (
            <ThemeProvider>
                <DocumentRenderer document={document} bindings={bindings} />
            </ThemeProvider>
        ) as ReactElement,
    )
}
it('renders one citation affordance per exact source, however many facts cite it', async () => {
    await renderSources()
    // Every demo fact cites the same single page region; exactly one citation affordance may offer
    // it (the part tile's own per-part page affordance is a separate catalog mechanism).
    const citations = screen
        .getAllByTestId('fact-source')
        .filter((item) => item.props.accessibilityLabel === 'See it in the manual')
    expect(citations).toHaveLength(1)
})

it('uses the production plan when a manual-page opener comes after fact citations', async () => {
    await renderSources([{ type: 'ManualPage', sources: [0], fit: 'contain', label: null, initiallyOpen: false }])
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(1)
})

it.each(['Hidden detail', 'Parts'])('keeps one opener per reference when %s opens first', async (first) => {
    const closed = (title: string, node: ScreenNodeV2): ScreenNodeV2 => ({
        type: 'Section',
        title: { kind: 'literal', text: title },
        collapsible: true,
        initiallyOpen: false,
        children: [node],
    })
    // This region is not already reachable from the visible fixture facts.
    await renderSources(
        [
            closed('Hidden detail', { type: 'Citation', sources: [0], label: null, display: 'chip' }),
            closed('Parts', { type: 'ManualPage', sources: [0], label: null, fit: 'contain', initiallyOpen: false }),
        ],
        true,
    )
    // The visible Directions section offers the fact region (source 0, its saved title direction) and the body offers
    // the distinct page reference (source 1): one opener each. The closed sections repeat source 0, so opening or
    // closing them never adds a second opener for that reference.
    const second = first === 'Hidden detail' ? 'Parts' : 'Hidden detail'
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(2)
    await fireEvent.press(screen.getByRole('button', { name: first }))
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(2)
    await fireEvent.press(screen.getByRole('button', { name: second }))
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(2)
    await fireEvent.press(screen.getByRole('button', { name: first }))
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(2)
    await fireEvent.press(screen.getByRole('button', { name: second }))
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(2)
})

it('replans the single source affordance when its section opens and restores it when closed', async () => {
    await renderSources([
        {
            type: 'Section',
            title: { kind: 'literal', text: 'Parts' },
            collapsible: true,
            initiallyOpen: false,
            children: [{ type: 'ManualPage', sources: [0], fit: 'contain', label: null, initiallyOpen: false }],
        },
    ])
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(1)
    await fireEvent.press(screen.getByRole('button', { name: 'Parts' }))
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(1)
    await fireEvent.press(screen.getByRole('button', { name: 'Parts' }))
    expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(1)
})

it('shares a page opener across part tiles and factual citations that reference that exact source', async () => {
    await renderSources()
    expect(screen.getAllByRole('button', { name: /^See it in the manual(?:$|:)/u })).toHaveLength(1)
})
