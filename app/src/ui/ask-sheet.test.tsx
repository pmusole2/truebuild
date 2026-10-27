import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { AskSheet, type AskPart } from './ask-sheet'

const PARTS: readonly AskPart[] = [
    { id: 'side-panel', label: 'Side panel' },
    { id: 'divider', label: 'Divider shelf' },
]

function renderAsk(overrides: Partial<Parameters<typeof AskSheet>[0]> = {}): ReturnType<typeof render> {
    return render(
        <AskSheet
            question="Which way should this part face?"
            onQuestionChange={(): void => undefined}
            parts={PARTS}
            target={null}
            onTargetChange={(): void => undefined}
            onSubmit={(): void => undefined}
            {...overrides}
        />,
    )
}

describe('AskSheet', () => {
    it('targets the whole step by default and lets the user pick one part instead', async () => {
        const onTargetChange = jest.fn()
        await renderAsk({ onTargetChange })
        expect(screen.getByRole('radio', { name: 'Whole step' }).props.accessibilityState).toEqual({ checked: true })
        await fireEvent.press(screen.getByRole('radio', { name: 'Side panel' }))
        expect(onTargetChange).toHaveBeenCalledWith('side-panel')
    })

    it('submits the question once through a named button', async () => {
        const onSubmit = jest.fn()
        await renderAsk({ onSubmit })
        await fireEvent.press(screen.getByRole('button', { name: 'Ask question' }))
        expect(onSubmit).toHaveBeenCalledTimes(1)
    })

    it('an empty question cannot be sent, and a stated reason is shown as text', async () => {
        const onSubmit = jest.fn()
        await renderAsk({ question: '   ', onSubmit, disabledReason: 'Take a photo of the assembly first.' })
        expect(screen.getByRole('button', { name: 'Ask question' })).toHaveProp('accessibilityState', {
            disabled: true,
            busy: false,
        })
        expect(screen.getByText('Take a photo of the assembly first.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Ask question' }))
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it('shows a previous answer below the controls when one is supplied', async () => {
        await renderAsk({ answer: <Text>Answer: the groove faces inward.</Text> })
        expect(screen.getByText('Answer: the groove faces inward.')).toBeTruthy()
    })
})
