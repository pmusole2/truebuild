import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { Text } from 'react-native'
import { CameraStage, type CameraPresentation } from './camera-stage'
import { ShutterButton } from '../../ui/camera-chrome'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const noop = (): void => undefined
const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 2 }),
}))
beforeEach(() => Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 }))

it.each([
    ['permission', { status: 'permission', canAskAgain: true, error: false }, 'Allow camera', 'request'],
    ['denied', { status: 'permission', canAskAgain: false, error: false }, 'Open Settings', 'settings'],
    ['unavailable', { status: 'error' }, 'Try again', 'retry'],
] as const)('keeps %s recovery explicit and returns without capturing', async (_name, presentation, label, action) => {
    const request = jest.fn()
    const settings = jest.fn()
    const retry = jest.fn()
    const cancel = jest.fn()
    await render(
        <CameraStage
            intent={{ kind: 'page' }}
            presentation={presentation}
            onCancel={cancel}
            onRequestPermission={request}
            onOpenSettings={settings}
            onRetry={retry}
        />,
    )
    await fireEvent.press(screen.getByRole('button', { name: label }))
    expect({ request, settings, retry }[action]).toHaveBeenCalledTimes(1)
    await fireEvent.press(screen.getByRole('button', { name: 'Go back' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Capture photo' })).toBeNull()
})

it.each([false, true])('retains assembly guidance and shutter availability (busy=%s)', async (busy) => {
    const capture = jest.fn()
    const presentation: CameraPresentation = {
        status: 'preview',
        media: <Text>Synthetic viewfinder</Text>,
        shutter: (
            <ShutterButton label={busy ? 'Preparing photo…' : 'Capture photo'} disabled={busy} onPress={capture} />
        ),
    }
    await render(
        <CameraStage
            intent={{ kind: 'check' }}
            guide={{ progress: 'Step 1 of 2', title: 'Side panel', instructions: <Text>Groove faces inward.</Text> }}
            presentation={presentation}
            onCancel={noop}
            onRequestPermission={noop}
            onOpenSettings={noop}
            onRetry={noop}
        />,
    )
    expect(screen.getByTestId('assembly-camera')).toBeTruthy()
    // No instruction panel over the preview: one line to aim by, and the step one tap away in More.
    expect(screen.queryByTestId('assembly-panel')).toBeNull()
    expect(screen.queryByText('Groove faces inward.')).toBeNull()
    expect(screen.getByTestId('camera-cue')).toBeTruthy()
    expect(screen.getByText('Step 1 of 2')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: busy ? 'Preparing photo…' : 'Capture photo' }))
    expect(capture).toHaveBeenCalledTimes(busy ? 0 : 1)
})

it.each([
    ['a short phone', { height: 568, width: 320, fontScale: 1 }],
    ['larger system text', { height: 844, width: 390, fontScale: 2 }],
])(
    'keeps the viewfinder, one-line cue and shutter available with %s and the full instructions in More',
    async (_label, dimensions) => {
        Object.assign(mockWindow, dimensions)
        const capture = jest.fn()
        await render(
            <CameraStage
                intent={{ kind: 'check' }}
                guide={{
                    progress: 'Step 1 of 2',
                    title: 'Side panel',
                    instructions: <Text>All original facts remain here.</Text>,
                }}
                presentation={{
                    status: 'preview',
                    media: <Text>Synthetic viewfinder</Text>,
                    shutter: <ShutterButton label="Capture photo" disabled={false} onPress={capture} />,
                }}
                onCancel={noop}
                onRequestPermission={noop}
                onOpenSettings={noop}
                onRetry={noop}
            />,
        )
        expect(screen.queryByTestId('assembly-panel')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Capture photo' }))
        expect(capture).toHaveBeenCalledTimes(1)
        await fireEvent.press(screen.getByRole('button', { name: 'Step details' }))
        expect(screen.getByText('All original facts remain here.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        // The sheet slides away first, then leaves.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(screen.queryByText('All original facts remain here.')).toBeNull()
    },
)

it('names a check camera correctly even when no step guide is available', async () => {
    await render(
        <CameraStage
            intent={{ kind: 'check' }}
            presentation={{ status: 'preview', media: null, shutter: null }}
            onCancel={noop}
            onRequestPermission={noop}
            onOpenSettings={noop}
            onRetry={noop}
        />,
    )
    expect(screen.getByText('Show the step you just built.')).toBeTruthy()
    expect(screen.queryByText('Fill the frame with one page.')).toBeNull()
})

it('does not reopen an instructions sheet after a camera error and retry', async () => {
    const guide = {
        progress: 'Step 1 of 2',
        title: 'Side panel',
        instructions: <Text>Step instructions retained.</Text>,
    }
    const stage = (presentation: CameraPresentation): ReactElement => (
        <CameraStage
            intent={{ kind: 'check' }}
            guide={guide}
            presentation={presentation}
            onCancel={noop}
            onRequestPermission={noop}
            onOpenSettings={noop}
            onRetry={noop}
        />
    )
    const preview: CameraPresentation = { status: 'preview', media: null, shutter: null }
    const { rerender } = await render(stage(preview))
    await fireEvent.press(screen.getByRole('button', { name: 'Step details' }))
    expect(screen.getByTestId('more-sheet')).toBeTruthy()
    await rerender(stage({ status: 'error' }))
    expect(screen.queryByTestId('more-sheet')).toBeNull()
    await rerender(stage(preview))
    expect(screen.queryByTestId('more-sheet')).toBeNull()
})

it.each([
    ['page', { kind: 'page' as const }, undefined, 'Fill the frame with one page.', 'Page photo'],
    ['question', { kind: 'question' as const }, undefined, 'Show the part you are asking about.', 'Ask photo'],
    [
        'check with a cue',
        { kind: 'check' as const },
        { progress: 'Step 2 of 8', title: 'Divider', cue: 'The groove is on the long side.', instructions: null },
        'The groove is on the long side.',
        'Step 2 of 8',
    ],
])('shows one line to aim by and a step pill for a %s photo', async (_name, intent, guide, cue, pill) => {
    await render(
        <CameraStage
            intent={intent}
            guide={guide}
            presentation={{ status: 'preview', media: null, shutter: null }}
            onCancel={noop}
            onRequestPermission={noop}
            onOpenSettings={noop}
            onRetry={noop}
        />,
    )
    const line = screen.getByText(cue)
    expect(line).toHaveProp('numberOfLines', 1)
    expect(screen.getByText(pill)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close camera' })).toBeTruthy()
})

it('closes with the floating close control and names loading, permission and error plainly', async () => {
    const cancel = jest.fn()
    const view = (presentation: CameraPresentation): ReactElement => (
        <CameraStage
            intent={{ kind: 'page' }}
            presentation={presentation}
            onCancel={cancel}
            onRequestPermission={noop}
            onOpenSettings={noop}
            onRetry={noop}
        />
    )
    const { rerender } = await render(view({ status: 'checking-access' }))
    expect(screen.getByText('Getting the camera ready.')).toBeTruthy()
    await rerender(view({ status: 'permission', canAskAgain: true, error: false }))
    expect(screen.getByText('We need the camera to take photos of your manual and your work.')).toBeTruthy()
    expect(screen.getByTestId('camera-permission')).toBeTruthy()
    await rerender(view({ status: 'error' }))
    expect(screen.getByText('The camera is not working. Close other apps and try again.')).toBeTruthy()
    await rerender(view({ status: 'preview', media: null, shutter: null }))
    await fireEvent.press(screen.getByTestId('camera-close'))
    expect(cancel).toHaveBeenCalledTimes(1)
})
