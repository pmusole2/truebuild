import { fireEvent, render, screen } from '@testing-library/react-native'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import type { SourceImageAsset } from '../../media/normalize-image'
import { CameraScreen, proofCamera } from './camera-screen'
import { createController, proofPorts } from './controller-factory'

const mockApi = { url: 'http://127.0.0.1:3101' }
jest.mock('../../config', () => ({
    get API_BASE_URL(): string {
        return mockApi.url
    },
    API_SECRET: '',
    GENERATIVE_UI: 'full',
}))
jest.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    digest: jest.fn(),
    digestStringAsync: jest.fn(),
    randomUUID: jest.fn(),
}))
const mockDevice = new Map<string, string>([['library/real-key', 'real']])
jest.mock('./device-storage', () => ({
    deviceStorage: {
        getItem: async (key: string): Promise<string | null> => mockDevice.get(key) ?? null,
        setItem: async (key: string, value: string): Promise<void> => void mockDevice.set(key, value),
        removeItem: async (key: string): Promise<void> => void mockDevice.delete(key),
        getAllKeys: async (): Promise<string[]> => [...mockDevice.keys()],
    },
}))
jest.mock('../../media/normalize-image', () => ({ normalizeImage: jest.fn(async () => 'device-normalizer') }))
jest.mock('../assembly/localize', () => ({ locateInPhoto: jest.fn() }))
// The hardware camera must never start in a proof run; if it does, the test fails loudly.
jest.mock('expo-camera', () => ({
    useCameraPermissions: (): never => {
        throw new Error('hardware camera started')
    },
    CameraView: 'CameraView',
}))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const env = ['EXPO_PUBLIC_AI_EFFORT_PROOF', 'EXPO_PUBLIC_PROVIDER_MODE', 'EXPO_PUBLIC_AI_EFFORT_PROOF_RUN'] as const
const saved = env.map((name) => process.env[name])
const globals = globalThis as { __DEV__?: boolean }
const devWas = globals.__DEV__
function selectProof(): void {
    process.env.EXPO_PUBLIC_AI_EFFORT_PROOF = '1'
    process.env.EXPO_PUBLIC_PROVIDER_MODE = 'fixture'
}
beforeEach(() => {
    for (const name of env) delete process.env[name]
    mockApi.url = 'http://127.0.0.1:3101'
    globals.__DEV__ = true
})
afterAll(() => {
    env.forEach((name, index) => {
        const value = saved[index]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    })
    globals.__DEV__ = devWas
})

describe('the native proof is off unless every guard holds', () => {
    it('uses the real storage, normalizer and hardware camera in an ordinary run', () => {
        expect(proofPorts()).toBeNull()
        expect(proofCamera()).toBeNull()
        expect(() => createController()).not.toThrow()
    })

    it.each([
        ['a production bundle', (): void => void (globals.__DEV__ = false)],
        ['a flag that is not exactly 1', (): void => void (process.env.EXPO_PUBLIC_AI_EFFORT_PROOF = 'true')],
    ])('stays off for %s', (_name, change) => {
        selectProof()
        change()
        if (_name === 'a production bundle') {
            expect(proofPorts()).toBeNull()
            expect(proofCamera()).toBeNull()
        } else {
            expect(() => proofPorts()).toThrow('explicit development fixture mode')
        }
    })

    it.each([
        ['no provider mode', (): void => void delete process.env.EXPO_PUBLIC_PROVIDER_MODE],
        ['the live provider mode', (): void => void (process.env.EXPO_PUBLIC_PROVIDER_MODE = 'meta')],
        ['a non-loopback API', (): void => void (mockApi.url = 'https://api.example.com')],
        ['another loopback port', (): void => void (mockApi.url = 'http://127.0.0.1:3002')],
    ])('refuses to start with %s, rather than falling back to a half-configured app', (_name, change) => {
        selectProof()
        change()
        expect(() => createController()).toThrow()
        expect(() => proofCamera()).toThrow()
    })
})

describe('the native proof replaces only storage and the picture source', () => {
    it('keeps the real library apart in its own namespace and accepts only bundled pictures', async () => {
        selectProof()
        process.env.EXPO_PUBLIC_AI_EFFORT_PROOF_RUN = 'build-a'
        const ports = proofPorts()!
        expect(ports).not.toBeNull()
        await ports.storage.setItem('library/manifest', 'proof')
        expect(await ports.storage.getAllKeys()).toEqual(['library/manifest'])
        expect(mockDevice.get('truebuild/ai-effort-proof/build-a/library/manifest')).toBe('proof')
        // The person's own library is neither listed nor reachable through the proof storage.
        expect(await ports.storage.getItem('library/real-key')).toBeNull()
        await expect(ports.normalize({ uri: 'file:///device/photo.jpg', width: 10, height: 10 })).rejects.toThrow()
        expect(() => createController()).not.toThrow()
    })

    it('selects the synthetic camera on the real stage, hands the capture to the real callback and never starts hardware', async () => {
        selectProof()
        let taken: SourceImageAsset | undefined
        const onCapture = jest.fn(async (take: () => Promise<SourceImageAsset>): Promise<void> => {
            taken = await take()
        })
        await render(
            <ThemeProvider>
                <FeedbackProvider reduceMotion>
                    <CameraScreen
                        busy={false}
                        intent={{ kind: 'check' }}
                        guide={{ progress: 'Step 1 of 2', title: 'Side panel', instructions: null }}
                        onCancel={jest.fn()}
                        onCapture={onCapture}
                        wording={{
                            cue: { text: 'Line the groove up.', nativeID: 'truebuild-render-origin:generated' },
                            pill: null,
                            tips: new Map(),
                        }}
                    />
                </FeedbackProvider>
            </ThemeProvider>,
        )
        expect(screen.getByLabelText('Synthetic fixture camera image')).toBeTruthy()
        // The guide's camera wording reaches the real stage through the proof camera too.
        expect(screen.getByText('Line the groove up.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Capture photo' }))
        expect(onCapture).toHaveBeenCalledTimes(1)
        expect(taken?.uri.startsWith('data:image/png;base64,')).toBe(true)
    })
})
