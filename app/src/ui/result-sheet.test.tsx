import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { AppButton } from './button'
import { ResultSheet } from './result-sheet'

describe('ResultSheet', () => {
    it.each([
        ['pass', 'Looks right'],
        ['refuse', 'Not yet'],
        ['cannot_verify', 'Can’t tell'],
    ] as const)('a %s result names its verdict in text and shows the full reason', async (verdict, label) => {
        await render(<ResultSheet verdict={verdict} reason="The groove faces the divider." />)
        expect(screen.getByText(label)).toBeTruthy()
        expect(screen.getByText('The groove faces the divider.')).toBeTruthy()
    })

    it('a refusal shows the cited manual page it rests on', async () => {
        await render(
            <ResultSheet
                verdict="refuse"
                reason="The panel is reversed."
                citedPage={<Text accessibilityRole="image">Cited manual page</Text>}
            />,
        )
        expect(screen.getByRole('image', { name: 'Cited manual page' })).toBeTruthy()
    })

    it('says when the page it rests on is not held in this session, rather than showing nothing', async () => {
        await render(
            <ResultSheet
                verdict="refuse"
                reason="The panel is reversed."
                citedPage={<Text>The cited page is not held in this session, so no image is shown.</Text>}
            />,
        )
        expect(screen.getByText('The cited page is not held in this session, so no image is shown.')).toBeTruthy()
    })

    it('a result that was simulated or unanalysed says so before the verdict', async () => {
        await render(
            <ResultSheet verdict="pass" reason="Demo result." provenance="Simulated result. Nothing was analysed." />,
        )
        expect(screen.getByText('Simulated result. Nothing was analysed.')).toBeTruthy()
    })

    it('lists missing evidence for a cannot-verify result', async () => {
        await render(
            <ResultSheet verdict="cannot_verify" reason="The side panel is not visible." missing={['inward groove']} />,
        )
        expect(screen.getByText('Missing: inward groove')).toBeTruthy()
    })

    it('announces the result politely and keeps its actions focusable', async () => {
        const onPress = jest.fn()
        await render(
            <ResultSheet
                verdict="pass"
                reason="Matches the manual."
                testID="result"
                actions={<AppButton label="Ask about this" onPress={onPress} />}
            />,
        )
        expect(screen.getByTestId('result')).toHaveProp('accessibilityLiveRegion', 'polite')
        await fireEvent.press(screen.getByRole('button', { name: 'Ask about this' }))
        expect(onPress).toHaveBeenCalledTimes(1)
    })
})
