import { fireEvent, render, screen } from '@testing-library/react-native'
import { INERT_WORKFLOW_CONTROLLER, WorkflowPreview } from './workflow-preview'
import { WORKFLOW_PREVIEW_BANNER } from './workflow-fixtures'

jest.mock('react-native-reanimated', () => jest.requireActual('../test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

it('selects actual workflow screens and changes appearance from local controls', async () => {
    await render(<WorkflowPreview />)
    expect(screen.getByText(WORKFLOW_PREVIEW_BANNER)).toBeTruthy()
    expect(screen.getByTestId('library-screen')).toBeTruthy()
    await fireEvent.press(screen.getByRole('radio', { name: 'Dark' }))
    expect(screen.getByRole('radio', { name: 'Dark' }).props.accessibilityState).toEqual({ checked: true })
    await fireEvent.press(screen.getByRole('radio', { name: 'Pages' }))
    expect(screen.getByTestId('pages-screen')).toBeTruthy()
    await fireEvent.press(screen.getByRole('radio', { name: 'Review' }))
    expect(screen.getByTestId('overview-screen')).toBeTruthy()
    await fireEvent.press(screen.getByRole('radio', { name: 'Guide' }))
    expect(screen.getByTestId('guide-screen')).toBeTruthy()
})

it('opens the real guide instructions sheet and keeps every controller action inert', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preview must never fetch'))
    try {
        await render(<WorkflowPreview initialCase="guide-instructions" />)
        await fireEvent.press(screen.getByRole('button', { name: 'Step instructions' }))
        expect(screen.getByText('Step 1 instructions')).toBeTruthy()
        for (const action of Object.values(INERT_WORKFLOW_CONTROLLER)) {
            if (typeof action === 'function') {
                await action()
            }
        }
        expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
        fetchSpy.mockRestore()
    }
})

it('renders camera recovery through the pure stage without opening hardware or sending a request', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preview must never fetch'))
    try {
        await render(<WorkflowPreview initialCase="camera-denied" />)
        expect(screen.getByTestId('camera-screen')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Allow camera' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Open device settings' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Back' }))
        expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
        fetchSpy.mockRestore()
    }
})
