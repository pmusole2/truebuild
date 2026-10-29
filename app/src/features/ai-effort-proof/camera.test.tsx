import { fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { Text } from 'react-native'
import type { SourceImageAsset } from '../../media/normalize-image'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { ProofCamera } from './camera'

jest.mock('../../config', () => ({ API_BASE_URL: 'http://127.0.0.1:3101' }))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: 390,
        height: 844,
        scale: 2,
        fontScale: 1,
    }),
}))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const oldFlag = process.env.EXPO_PUBLIC_AI_EFFORT_PROOF
const oldProvider = process.env.EXPO_PUBLIC_PROVIDER_MODE
beforeEach(() => {
    process.env.EXPO_PUBLIC_AI_EFFORT_PROOF = '1'
    process.env.EXPO_PUBLIC_PROVIDER_MODE = 'fixture'
})
afterAll(() => {
    if (oldFlag === undefined) delete process.env.EXPO_PUBLIC_AI_EFFORT_PROOF
    else process.env.EXPO_PUBLIC_AI_EFFORT_PROOF = oldFlag
    if (oldProvider === undefined) delete process.env.EXPO_PUBLIC_PROVIDER_MODE
    else process.env.EXPO_PUBLIC_PROVIDER_MODE = oldProvider
})

function wrap(node: ReactElement): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>{node}</FeedbackProvider>
        </ThemeProvider>
    )
}

it('uses the ordinary CameraStage and shutter to hand one labelled fixture asset to the real capture callback', async () => {
    let taken: SourceImageAsset | undefined
    const capture = jest.fn(async (take: () => Promise<SourceImageAsset>): Promise<void> => {
        taken = await take()
    })
    const cancel = jest.fn()
    await render(wrap(<ProofCamera busy={false} intent={{ kind: 'page' }} onCancel={cancel} onCapture={capture} />))
    expect(screen.getByTestId('camera-screen')).toBeTruthy()
    expect(screen.getByLabelText('Synthetic fixture camera image')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Capture photo' }))
    expect(capture).toHaveBeenCalledTimes(1)
    expect(taken?.uri.startsWith('data:image/png;base64,')).toBe(true)
    expect(taken).toMatchObject({ width: 960, height: 1280 })
    await fireEvent.press(screen.getByTestId('camera-close'))
    expect(cancel).toHaveBeenCalledTimes(1)
})

it('keeps the existing busy shutter disabled and never captures twice during preparation', async () => {
    const capture = jest.fn()
    await render(wrap(<ProofCamera busy intent={{ kind: 'check' }} onCancel={jest.fn()} onCapture={capture} />))
    const shutter = screen.getByRole('button', { name: 'Preparing photo…' })
    expect(shutter.props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(shutter)
    expect(capture).not.toHaveBeenCalled()
})

it('forwards the generated camera cue, pill and their origins through the ordinary CameraStage', async () => {
    await render(
        wrap(
            <ProofCamera
                busy={false}
                intent={{ kind: 'check' }}
                guide={{ progress: 'Step 1 of 2', title: 'Fixture step', instructions: <Text>Fixture details</Text> }}
                wording={{
                    cue: { text: 'Center the connection.', nativeID: 'truebuild-render-origin:generated' },
                    pill: { text: 'Ready to check', nativeID: 'truebuild-render-origin:generated' },
                    tips: new Map(),
                }}
                onCancel={jest.fn()}
                onCapture={jest.fn()}
            />,
        ),
    )
    expect(screen.getByText('Center the connection.')).toBeTruthy()
    expect(screen.getByTestId('camera-cue').props.nativeID).toBe('truebuild-render-origin:generated')
    expect(screen.getByLabelText('Ready to check').props.nativeID).toBe('truebuild-render-origin:generated')
    expect(screen.getByRole('button', { name: 'Capture photo' })).toBeTruthy()
})
