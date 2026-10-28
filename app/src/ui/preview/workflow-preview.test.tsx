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

it('opens the real More sheet and keeps every controller action inert', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preview must never fetch'))
    try {
        await render(<WorkflowPreview initialCase="guide-instructions" />)
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
        expect(screen.getByText('More about this step')).toBeTruthy()
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
        // The denied fixture cannot ask again, so Settings is its one recovery and Go back is the fixed close icon.
        expect(screen.queryByRole('button', { name: 'Allow camera' })).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Go back' }))
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

it('wires the camera preview guide exactly as the app does: one cue over the viewfinder, every fact in More', async () => {
    await render(<WorkflowPreview initialCase="camera-check" />)
    // One line to aim by: the first visible check, in the step's own words. Nothing else sits over the viewfinder.
    const cue = within(screen.getByTestId('camera-cue')).getByText('The inward-facing groove is visible.')
    expect(cue.props.numberOfLines).toBe(1)
    expect(screen.queryByTestId('assembly-panel')).toBeNull()
    expect(screen.queryByText(/^Frame the current assembly step/)).toBeNull()
    expect(screen.queryByText(/frozen photo/iu)).toBeNull()
    expect(screen.getByText('Step 1 of 2')).toBeTruthy()
    expect(screen.getByTestId('camera-thumbnail')).toBeTruthy()
    // The shutter stays readable beneath the viewfinder; the full step is one tap away.
    expect(screen.getByRole('button', { name: 'Capture photo' })).toBeTruthy()
    // The picture opens the details; there is no second info control beside it.
    expect(screen.queryByRole('button', { name: 'Step details' })).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'See the step picture' }))
    expect(screen.getByText(/^Which way it faces: Groove faces inward toward the divider\./u)).toBeTruthy()
    expect(screen.getByText('1. Look for: The inward-facing groove is visible.')).toBeTruthy()
    expect(screen.getByText('How it joins: Keep the panel free before seating the divider.')).toBeTruthy()
    expect(screen.getByText('Expected diagram · page 1')).toBeTruthy()
})
