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
                    'Take a photo of your assembly to check it against the manual. The photo stays on this device until you choose to send it for a check.',
            },
        ],
        [
            'expo-image-picker',
            {
                photosPermission:
                    'Choose manual pages from your photo library. Pages are kept on this device until you choose to send relevant pages for extraction.',
            },
        ],
    ],
}

export default config
