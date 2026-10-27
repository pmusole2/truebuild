import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
    name: 'TrueBuild',
    slug: 'truebuild',
    scheme: 'truebuild',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    web: {
        bundler: 'metro',
        output: 'single',
    },
    plugins: [
        'expo-router',
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
                    'Choose manual pages from your photo library. Pages are kept on this device until you choose to send relevant pages for extraction.',
            },
        ],
    ],
}

export default config
