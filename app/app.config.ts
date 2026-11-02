import type { ExpoConfig } from 'expo/config'

/**
 * Build-time guard for the EAS production profile. A store build must use a real HTTPS API origin, the meta provider
 * path, and no fixture-only build flags. Local `expo start` runs (no EAS_BUILD_PROFILE) are not restricted.
 */
function assertProductionEnvironment(env: NodeJS.ProcessEnv): void {
    if (env.EAS_BUILD_PROFILE !== 'production') return

    const apiBaseUrl = env.EXPO_PUBLIC_API_BASE_URL ?? ''
    if (apiBaseUrl.includes('REPLACE_ME')) {
        throw new Error('Replace the REPLACE_ME placeholder in app/eas.json with the deployed API origin.')
    }

    let url: URL
    try {
        url = new URL(apiBaseUrl)
    } catch {
        throw new Error('EXPO_PUBLIC_API_BASE_URL must be an absolute https origin for production builds.')
    }
    if (
        url.protocol !== 'https:' ||
        /^(?:localhost\.?|.*\.localhost\.?|127\..*|0\.0\.0\.0|\[::(?:1|ffff:7f[\da-f]{2}:[\da-f]{1,4})?\])$/iu.test(
            url.hostname,
        ) ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== ''
    ) {
        throw new Error(
            'EXPO_PUBLIC_API_BASE_URL must be a bare https origin with no credentials, path, query or hash.',
        )
    }

    if (env.EXPO_PUBLIC_PROVIDER_MODE !== undefined && env.EXPO_PUBLIC_PROVIDER_MODE !== 'meta') {
        throw new Error('Production builds must use EXPO_PUBLIC_PROVIDER_MODE=meta.')
    }
    if (env.EXPO_PUBLIC_RELEASE_FIXTURE !== undefined && !['', '0'].includes(env.EXPO_PUBLIC_RELEASE_FIXTURE)) {
        throw new Error('Production builds must not enable EXPO_PUBLIC_RELEASE_FIXTURE.')
    }
    if (env.EXPO_PUBLIC_DOCUMENT_FIXTURES !== undefined && !['', '0'].includes(env.EXPO_PUBLIC_DOCUMENT_FIXTURES)) {
        throw new Error('Production builds must not enable EXPO_PUBLIC_DOCUMENT_FIXTURES.')
    }
}

assertProductionEnvironment(process.env)

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
    version: '0.1.0',
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
