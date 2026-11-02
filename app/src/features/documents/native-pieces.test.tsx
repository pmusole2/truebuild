import { render, screen } from '@testing-library/react-native'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    documentMaterialV2,
    pieceSpecSchema,
    screenDocumentV2Schema,
    semanticIssuesV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { DocumentRenderer } from './document-renderer'
import { sha256Hex } from './sha256'
import type { FrameBindings } from './types'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const piece = pieceSpecSchema.parse({
    id: 'bracket-1',
    name: 'Bracket',
    color: '#4a7fb0',
    parts: [{ type: 'box', dimensions: { width: 2, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] }],
})
const home = (pieces?: ScreenContextInputsV2['pieces']): ScreenContextInputsV2 => ({
    kind: 'home',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    ...(pieces === undefined ? {} : { pieces }),
})
const viewer = (pieceId: string): ScreenNodeV2 => ({ type: 'PieceViewer', pieceId })
const grid = (pieceIds: string[]): ScreenNodeV2 => ({ type: 'PiecesGrid', pieceIds })
const bindings: FrameBindings = {
    resolve: () => ({ enabled: true, reason: null, run: () => undefined }),
    live: null,
    session: undefined,
    pageUris: {},
    capture: null,
    marks: [],
    heroMode: 'inline',
    inspect: false,
}

/** The deterministic home screen with the given native nodes placed above its own body (the same way the app composes). */
function compose(inputs: ScreenContextInputsV2, extras: ScreenNodeV2[]): ScreenDocumentV2 {
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

function renderDocument(document: ScreenDocumentV2): ReturnType<typeof render> {
    return render(
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <DocumentRenderer document={document} bindings={{ ...bindings, pieces: [piece] }} variant="ready" />
            </FeedbackProvider>
        </ThemeProvider>,
    )
}

describe('native piece nodes against the supplied registry', () => {
    it('renders a registered id, shows the fallback for an unknown id, and states the registry in the context', async () => {
        // Context availability: the ids exist only where a registry was supplied (none otherwise).
        expect(documentMaterialV2(home([piece])).pieceIds).toEqual(['bracket-1'])
        expect(documentMaterialV2(home()).pieceIds).toEqual([])

        // A registered id resolves to its own piece. Under Jest the GL attempt fails and the viewer falls back to its named
        // card (the piece's own name), so this proves the id reached the registry, not that a 3D scene was drawn.
        const valid = compose(home([piece]), [viewer('bracket-1'), grid(['bracket-1'])])
        const first = await renderDocument(valid)
        expect(screen.getAllByLabelText('Bracket').length).toBeGreaterThan(0)
        expect(screen.getByTestId('pieces-grid')).toBeTruthy()
        expect(screen.getByTestId('piece-tile-bracket-1')).toBeTruthy()
        await first.unmount()

        // An id the registry does not hold is a semantic issue for the composer, and at render time a fallback card.
        const ghost = compose(home([piece]), [viewer('ghost-9')])
        const material = documentMaterialV2(home([piece]))
        const proposal = buildFallbackProposalV2(material)
        const issues = semanticIssuesV2(
            { ...proposal, body: { type: 'Stack', gap: 'md', align: 'stretch', children: [viewer('ghost-9')] } },
            material,
        )
        expect(issues).toContain('body.0:unknown_piece_id')
        expect(issues).not.toContain('body.0:piece_unavailable')
        const second = await renderDocument(ghost)
        expect(screen.getByLabelText('Assembly piece')).toBeTruthy()
        expect(screen.queryByLabelText('Bracket')).toBeNull()
        await second.unmount()

        // With no registry at all, the same node is reported as unavailable rather than unknown.
        const noRegistry = documentMaterialV2(home())
        const bare = buildFallbackProposalV2(noRegistry)
        const unavailable = semanticIssuesV2(
            { ...bare, body: { type: 'Stack', gap: 'md', align: 'stretch', children: [viewer('bracket-1')] } },
            noRegistry,
        )
        expect(unavailable).toContain('body.0:piece_unavailable')
    })
})
