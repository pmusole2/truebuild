import { render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { PaneNotes, type PaneNote } from './pane-notes'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

const NOTES: readonly PaneNote[] = [
    { kind: 'next', text: 'Next part: Divider' },
    { kind: 'target', text: 'Target for Divider' },
    { kind: 'move', text: 'Move Divider to the marked area' },
    'Plain caption.',
]

describe('PaneNotes', () => {
    it('leads with the instruction and keeps every line in its own words, plain strings included', async () => {
        const { toJSON } = await render(<PaneNotes notes={NOTES} />)
        const tree = JSON.stringify(toJSON())
        const order = ['Move Divider to the marked area', 'Next part: Divider', 'Target for Divider', 'Plain caption.']
        expect(order.map((text) => tree.indexOf(text))).toEqual(
            [...order.map((text) => tree.indexOf(text))].sort((a, b) => a - b),
        )
        expect(order.every((text) => tree.includes(text))).toBe(true)
    })

    it('tells next from target by dashed against solid swatches, so colour is never the only cue', async () => {
        await render(<PaneNotes notes={NOTES} />)
        const border = (kind: string): unknown =>
            StyleSheet.flatten(
                screen.getByTestId(`pane-note-swatch-${kind}`, { includeHiddenElements: true }).props.style,
            ).borderStyle
        expect(border('next')).toBe('dashed')
        expect(border('target')).toBe('solid')
    })

    it('draws nothing for no notes', async () => {
        const { toJSON } = await render(<PaneNotes notes={undefined} />)
        expect(toJSON()).toBeNull()
    })
})
