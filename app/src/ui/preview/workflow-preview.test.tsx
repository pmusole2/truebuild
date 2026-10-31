import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { INERT_WORKFLOW_CONTROLLER, WorkflowPreview, type NativeChrome } from './workflow-preview'
import { useMoreState } from '../../features/capture/screen-header'
import type { SharedValue } from 'react-native-reanimated'
import type { ReactElement } from 'react'
import { WORKFLOW_PREVIEW_BANNER, workflowPreviewFixture } from './workflow-fixtures'
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
        expect(screen.getByTestId('preview-more-document')).toBeTruthy()
        await fireEvent.press(within(screen.getByTestId('preview-more-document')).getByTestId('close-sheet'))
        expect(screen.queryByTestId('preview-more-document')).toBeNull()
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

it('renders camera recovery through the actual v2 document without opening hardware or sending a request', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preview must never fetch'))
    try {
        await render(<WorkflowPreview initialCase="camera-denied" />)
        expect(screen.getByTestId('camera-screen')).toBeTruthy()
        // The denied fixture cannot ask again, so Settings is its one recovery and Go back is the fixed close icon.
        expect(screen.queryByRole('button', { name: 'Allow camera' })).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Open settings' }))
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
        expect(screen.getByText('What leaves this device')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Open device settings' }))
        expect(settings).not.toHaveBeenCalled()
    } finally {
        settings.mockRestore()
    }
})

it('renders the camera node, its real document bar and complete cited facts over hardware-free fixture media', async () => {
    await render(<WorkflowPreview initialCase="camera-check" />)
    expect(screen.getAllByText('Keep the whole step in view')).toHaveLength(1)
    expect(screen.getByLabelText('Synthetic camera preview')).toBeTruthy()
    expect(screen.queryByTestId('assembly-panel')).toBeNull()
    expect(screen.queryByText(/^Frame the current assembly step/u)).toBeNull()
    expect(screen.queryByText(/frozen photo/iu)).toBeNull()
    expect(screen.getByTestId('camera-shutter').props.accessibilityLabel).toBe('Take photo')
    expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(2)
    expect(screen.getByText('Groove faces inward toward the divider.')).toBeTruthy()
    expect(screen.getByText('The inward-facing groove is visible.')).toBeTruthy()
    expect(screen.getByText('Keep the panel free before seating the divider.')).toBeTruthy()
    await fireEvent.press(screen.getAllByTestId('fact-source')[0]!)
    expect(screen.getByText('Picture from your manual · Page 1')).toBeTruthy()
})

describe('native chrome for hidden-controls captures', () => {
    // Stands in for the gallery route: it owns the More control, and its header More opens the same control.
    function Host({
        id,
    }: {
        id: 'guide-instructions' | 'pages-populated' | 'camera-check' | 'home-populated'
    }): ReactElement {
        const more = useMoreState()
        const native: NativeChrome = {
            more,
            scrollY: { value: 0 } as unknown as SharedValue<number>,
            onCollapsedChange: (): void => undefined,
            progress: {
                questions: [],
                current: undefined,
                position: 0,
                total: 0,
                skipped: [],
                skip: (): void => undefined,
                unskip: (): void => undefined,
                label: undefined,
            },
        }
        return (
            <>
                <WorkflowPreview initialCase={id} showControls={false} native={native} />
            </>
        )
    }

    it.each(['guide-instructions', 'pages-populated', 'home-populated'] as const)(
        'draws only the product screen for %s: no banner, no controls, no second header',
        async (id) => {
            await render(<Host id={id} />)
            expect(screen.queryByText(/Synthetic visual preview/u)).toBeNull()
            expect(screen.queryByRole('radio')).toBeNull()
            expect(screen.queryByTestId('inline-header')).toBeNull()
            expect(screen.getByTestId('workflow-preview')).toBeTruthy()
        },
    )

    it("opens the document's own More sheet from its single document header and keeps the state unchanged", async () => {
        await render(<Host id="guide-instructions" />)
        expect(screen.queryByTestId('more-sheet')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
        expect(screen.getByTestId('more-sheet')).toBeTruthy()
        expect(screen.getByTestId('preview-more-document')).toBeTruthy()
    })

    it('draws the camera full bleed with no gallery chrome around it', async () => {
        await render(<Host id="camera-check" />)
        expect(screen.getByTestId('camera-screen')).toBeTruthy()
        expect(screen.queryByText(/Synthetic visual preview/u)).toBeNull()
    })

    it('keeps debug controls around the same document header without a legacy inline header', async () => {
        await render(<WorkflowPreview initialCase="guide-pass" />)
        expect(screen.getByText(WORKFLOW_PREVIEW_BANNER)).toBeTruthy()
        expect(screen.getAllByRole('radio').length).toBeGreaterThan(0)
        expect(screen.queryByTestId('inline-header')).toBeNull()
        expect(screen.getAllByTestId('document-header-copy')).toHaveLength(1)
    })
})

it.each([
    ['review-blocked', 'Back to pages', false],
    ['guide-needs-check', 'Quick check', false],
    ['guide-needs-pages', 'Take photo', true],
    ['guide-earlier-open', 'Take photo', false],
] as const)('uses the actual v2 document primary and controller guard for %s', async (fixture, label, disabled) => {
    await render(<WorkflowPreview initialCase={fixture} showControls={false} />)
    const primary = within(screen.getByTestId('bottom-bar')).getByRole('button', { name: label })
    expect(primary.props.accessibilityState.disabled).toBe(disabled)
    if (fixture === 'guide-needs-pages')
        expect(screen.getByText('More manual pages are needed before a photo can be checked.')).toBeTruthy()
    if (fixture === 'guide-earlier-open') expect(screen.getByText('Step 2 of 2')).toBeTruthy()
})

it('opts into a delayed inert result for native motion capture, without changing the default gallery', async () => {
    jest.useFakeTimers()
    try {
        await render(<WorkflowPreview initialCase="guide-pending" reveal="pass" showControls={false} />)
        expect(screen.queryByText(workflowPreviewFixture('guide-pass').state.check!.reason)).toBeNull()
        await act(async () => jest.advanceTimersByTime(1600))
        expect(screen.queryByText(workflowPreviewFixture('guide-pass').state.check!.reason)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(workflowPreviewFixture('guide-pass').state.check!.reason)).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Next step' })).toBeTruthy()
    } finally {
        jest.useRealTimers()
    }
})
