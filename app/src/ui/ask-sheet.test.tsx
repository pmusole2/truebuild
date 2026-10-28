import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { AskSheet, type AskPart } from './ask-sheet'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

const PARTS: readonly AskPart[] = [
    { id: 'side-panel', label: 'Side panel' },
    { id: 'divider', label: 'Divider shelf' },
]

function renderAsk(overrides: Partial<Parameters<typeof AskSheet>[0]> = {}): ReturnType<typeof render> {
    return render(
        <AskSheet
            question="Which way should this part face?"
            questionLabel="Question about frozen photo"
            onQuestionChange={(): void => undefined}
            parts={PARTS}
            selectedPartId={null}
            onSelectPart={(): void => undefined}
            targetSummary="Choose a point or part."
            hasTarget={true}
            onSubmit={(): void => undefined}
            {...overrides}
        />,
    )
}

describe('AskSheet', () => {
    it('reports the chosen part, never a whole-step target', async () => {
        const onSelectPart = jest.fn()
        await renderAsk({ onSelectPart, selectedPartId: null })
        expect(screen.queryByRole('radio', { name: 'Whole step' })).toBeNull()
        await fireEvent.press(screen.getByRole('radio', { name: 'Side panel' }))
        expect(onSelectPart).toHaveBeenCalledWith('side-panel')
    })

    it('does not send without a target, and sends once with one', async () => {
        const onSubmit = jest.fn()
        await renderAsk({ hasTarget: false, onSubmit })
        await fireEvent.press(screen.getByRole('button', { name: 'Send question' }))
        expect(onSubmit).not.toHaveBeenCalled()
        await renderAsk({ hasTarget: true, onSubmit })
        await fireEvent.press(screen.getAllByRole('button', { name: 'Send question' }).at(-1)!)
        expect(onSubmit).toHaveBeenCalledTimes(1)
    })

    it('an empty question cannot be sent, and a stated reason is shown as text', async () => {
        const onSubmit = jest.fn()
        await renderAsk({ question: '   ', onSubmit, disabledReason: 'Take a photo of the assembly first.' })
        expect(screen.getByRole('button', { name: 'Send question' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        expect(screen.getByText('Take a photo of the assembly first.')).toBeTruthy()
    })

    it('shows the dictation hint and a previous answer below the controls', async () => {
        await renderAsk({ answer: <Text>Answer: the groove faces inward.</Text> })
        expect(screen.getByText(/keyboard’s dictation/)).toBeTruthy()
        expect(screen.getByText('Answer: the groove faces inward.')).toBeTruthy()
    })
})

describe('AskSheet composition limits', () => {
    it('disables sending and part choices when the composer is not editable, and caps the question at 500', async () => {
        const onSubmit = jest.fn()
        const onSelectPart = jest.fn()
        await renderAsk({ editable: false, onSubmit, onSelectPart, hasTarget: true, question: 'Which way?' })
        expect(screen.getByRole('button', { name: 'Send question' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        expect(screen.getByRole('radio', { name: 'Side panel' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        expect(screen.getByLabelText('Question about frozen photo').props.maxLength).toBe(500)
    })
})
