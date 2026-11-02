import type { ExpoConfig } from 'expo/config'

/** The only API origin a store build or OTA update may ship with. */
export const PRODUCTION_API_BASE_URL = 'https://truebuild-suhsi.sevalla.app'

/** Process-style environment; `process.env` satisfies it, and tests can pass a partial record. */
export type ReleaseEnvironment = Readonly<Record<string, string | undefined>>

/** Fixture, proof and test-only switches. A production release must leave each one unset, empty or '0'. */
const FIXTURE_AND_TEST_FLAGS: readonly string[] = [
    'EXPO_PUBLIC_RELEASE_FIXTURE',
    'EXPO_PUBLIC_DOCUMENT_FIXTURES',
    'EXPO_PUBLIC_AI_EFFORT_PROOF',
    'EXPO_PUBLIC_AI_EFFORT_PROOF_RUN',
    'EXPO_PUBLIC_PIECES_TEST',
    'EXPO_PUBLIC_PIECE_VIEWER_TEST',
    'EXPO_PUBLIC_SCREENS_TEST_DELAY_MS',
    'EXPO_PUBLIC_SCREENS_TEST_FAIL',
]

function isSet(value: string | undefined): boolean {
    return value !== undefined && !['', '0'].includes(value)
}

/**
 * A production release is a store build (EAS_BUILD_PROFILE=production) or the `expo export` that `eas update` spawns.
 * `eas update --environment` merges the remote environment into that child process, where it is the only copy of the
 * server-side values. Local `expo start` and other commands are not restricted.
 */
export function isProductionReleaseContext(env: ReleaseEnvironment, argv: readonly string[]): boolean {
    return env.EAS_BUILD_PROFILE === 'production' || argv[2] === 'export'
}

/** Throws unless the environment names the exact production API origin, the meta provider, steps and no fixtures. */
export function assertProductionEnvironment(env: ReleaseEnvironment): void {
    if (env.EXPO_PUBLIC_API_BASE_URL !== PRODUCTION_API_BASE_URL) {
        throw new Error(`EXPO_PUBLIC_API_BASE_URL must be exactly ${PRODUCTION_API_BASE_URL} for production releases.`)
    }
    if (env.EXPO_PUBLIC_PROVIDER_MODE !== 'meta') {
        throw new Error('Production releases must set EXPO_PUBLIC_PROVIDER_MODE=meta.')
    }
    if (env.EXPO_PUBLIC_GENERATIVE_UI !== 'steps') {
        throw new Error('Production releases must set EXPO_PUBLIC_GENERATIVE_UI=steps.')
    }
    for (const flag of FIXTURE_AND_TEST_FLAGS) {
        if (isSet(env[flag])) {
            throw new Error(`Production releases must not enable ${flag}.`)
        }
    }
}

// Runs inside the store-build and EAS Update export processes; the EAS environment is merged there, not before.
if (isProductionReleaseContext(process.env, process.argv)) {
    assertProductionEnvironment(process.env)
}

const config: ExpoConfig = {
    name: 'TrueBuild',
    slug: 'truebuild',
    owner: 'princezuko9222',
    extra: {
        eas: {
            projectId: 'ae1a9376-1863-4338-b717-14adf7ba7126',
        },
    },
    scheme: 'truebuild',
    version: '0.1.1',
    runtimeVersion: {
        policy: 'appVersion',
    },
    updates: {
        url: 'https://u.expo.dev/ae1a9376-1863-4338-b717-14adf7ba7126',
        checkAutomatically: 'ON_LOAD',
        fallbackToCacheTimeout: 0,
    },
    icon: './assets/icon.png',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    ios: {
        supportsTablet: true,
        bundleIdentifier: 'com.princemusole.truebuild',
        config: {
            // Standard HTTPS only; no custom or proprietary encryption.
            usesNonExemptEncryption: false,
        },
    },
    web: {
        bundler: 'metro',
        output: 'single',
    },
    plugins: [
        'expo-router',
        [
            'expo-splash-screen',
            {
                image: './assets/icon.png',
                imageWidth: 200,
                resizeMode: 'contain',
                backgroundColor: '#0057C2',
            },
        ],
        [
            'expo-camera',
            {
                cameraPermission:
                    'Photograph your manual pages and current assembly step. A frozen photo is sent only when you request extraction, a check, or a question.',
                recordAudioAndroid: false,
                microphonePermission: false,
                barcodeScannerEnabled: false,
            },
        ],
        [
            'expo-image-picker',
            {
                cameraPermission: 'Photograph your manual pages and assembly steps.',
                microphonePermission: false,
                photosPermission:
                    'Choose manual pages or assembly photos from your photo library. Selected images stay on this device until you choose to send them for manual extraction, a step check, or a question.',
            },
        ],
    ],
}

export default config
