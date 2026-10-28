import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { INERT_WORKFLOW_CONTROLLER, WorkflowPreview } from './workflow-preview'
import { WORKFLOW_PREVIEW_BANNER } from './workflow-fixtures'
import { Linking } from 'react-native'

// A phone-sized window at normal text, so the camera panel is the full (non-compact) layout the app shows.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; fontScale: number; scale: number } => ({
        width: 390,
        height: 844,
        fontScale: 1,
        scale: 2,
    }),
}))
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

it('keeps settings inspection inert, including the device settings action', async () => {
    const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)
    try {
        await render(<WorkflowPreview initialCase="settings" />)
        expect(screen.getByText('What leaves this phone')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Open device settings' }))
        expect(settings).not.toHaveBeenCalled()
    } finally {
        settings.mockRestore()
    }
})

it('wires the camera preview guide exactly as the app does: one cue over the viewfinder, every fact in the sheet', async () => {
    await render(<WorkflowPreview initialCase="camera-check" />)
    const panel = within(screen.getByTestId('assembly-panel'))
    // One bounded cue: the first visible check. The orientation, connection and diagram are not repeated in the panel.
    const cue = panel.getByText('Visible check: The inward-facing groove is visible.')
    expect(cue.props.numberOfLines).toBe(2)
    expect(panel.queryByText(/^Orientation: /)).toBeNull()
    expect(panel.queryByText('Connection: Keep the panel free before seating the divider.')).toBeNull()
    expect(panel.queryByText('Current step instructions and diagram')).toBeNull()
    expect(screen.getByLabelText('Current step instructions and diagram')).toBe(screen.getByTestId('assembly-panel'))
    expect(screen.queryByTestId('diagram')).toBeNull()
    // The shutter and the whole privacy hint stay readable beneath the viewfinder.
    expect(screen.getByRole('button', { name: 'Capture photo' })).toBeTruthy()
    expect(screen.getByText(/^Frame the current assembly step\. A check sends the frozen photo/)).toBeTruthy()
    await fireEvent.press(panel.getByRole('button', { name: 'All step facts' }))
    expect(screen.getByText('Orientation: Groove faces inward toward the divider.')).toBeTruthy()
    expect(screen.getByText('Visible check: The inward-facing groove is visible.')).toBeTruthy()
    expect(screen.getByText('Connection: Keep the panel free before seating the divider.')).toBeTruthy()
    expect(screen.getByText('Expected diagram · page 1')).toBeTruthy()
})
