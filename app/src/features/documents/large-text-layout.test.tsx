import { createHash } from 'node:crypto'
import { render, screen } from '@testing-library/react-native'
import { Dimensions, StyleSheet, type ViewStyle } from 'react-native'
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
import { CompareColumns } from './compare-columns'
import { DocumentRenderer } from './document-renderer'
import type { FrameBindings } from './types'
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const initial = Dimensions.get('window')
const NORMAL = 1
const LARGEST = 3

function setWindow(width: number, fontScale: number): void {
    Dimensions.set({ window: { ...initial, width, fontScale }, screen: { ...initial, width, fontScale } })
}

const word = (text: string): ScreenNodeV2 => ({
    type: 'Text',
    content: { kind: 'literal', text },
    role: 'body',
    emphasis: 'normal',
    tone: 'neutral',
    align: 'start',
})

async function renderWith(extra: ScreenNodeV2[]): Promise<void> {
    const session = createDemoManual()
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
    proposal.body.children.push(...extra)
    const document = assembleDocumentV2(
        material,
        proposal,
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
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

function directionAround(text: string): unknown {
    let node = screen.getByText(text).parent
    while (node !== null) {
        const direction = (StyleSheet.flatten(node.props.style) as ViewStyle | undefined)?.flexDirection
        if (direction !== undefined) return direction
        node = node.parent
    }
    return undefined
}

afterEach(() => {
    Dimensions.set({ window: initial, screen: initial })
})

describe('accessibility text sizes', () => {
    it.each([
        [NORMAL, 'row'],
        [LARGEST, 'column'],
    ])('lays out side-by-side children for text scale %s as a %s', async (fontScale, direction) => {
        setWindow(390, fontScale)
        const row: ScreenNodeV2 = {
            type: 'Row',
            gap: 'sm',
            align: 'center',
            justify: 'start',
            wrap: false,
            children: [word('Post bracket'), word('Comparison')],
        }
        await renderWith([row])
        expect(directionAround('Post bracket')).toBe(direction)
        expect(directionAround('Comparison')).toBe(direction)
    })

    it.each([
        [NORMAL, 'See it in the manual'],
        [LARGEST, 'Manual page'],
    ])(
        'keeps the manual opener to one short line for text scale %s, with its full spoken label',
        async (fontScale, shown) => {
            setWindow(390, fontScale)
            await renderWith([{ type: 'ManualPage', sources: [0], fit: 'contain', label: null, initiallyOpen: false }])
            const opener = screen.getByRole('button', { name: 'See it in the manual' })
            expect(opener.props.accessibilityLabel).toBe('See it in the manual')
            expect(screen.queryByRole('header', { name: shown })).toBeNull()
            expect(screen.getByText(shown)).toBeTruthy()
            expect(screen.queryByText(shown === 'Manual page' ? 'See it in the manual' : 'Manual page')).toBeNull()
        },
    )

    it.each([
        [NORMAL, true],
        [LARGEST, false],
    ])(
        'puts compared manuals side by side on a wide screen only at text scale %s: %s',
        async (fontScale, sideBySide) => {
            setWindow(1032, fontScale)
            await render(
                (
                    <ThemeProvider>
                        <CompareColumns panes={[]} />
                    </ThemeProvider>
                ) as ReactElement,
            )
            expect(screen.queryByTestId('compare-narrow') === null).toBe(sideBySide)
        },
    )
})
