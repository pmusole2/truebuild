/** @type {import('jest').Config} */
module.exports = {
    preset: 'jest-expo',
    rootDir: __dirname,
    // Vitest owns the *.test.ts non-UI suites (storage, domain, API client); Jest runs every *.test.tsx under src (components, features, demo, media).
    testMatch: ['<rootDir>/src/**/*.test.tsx'],
    // UI tests execute web byte/multipart adapters against their existing fetch boundary; native file IO needs device QA.
    moduleNameMapper: {
        '^\\./read-image$': '<rootDir>/src/media/read-image.ts',
        '^\\./multipart-image$': '<rootDir>/src/api/multipart-image.ts',
    },
    transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|expo-.*|@expo/.*|react-native-.*)',
    ],
}
