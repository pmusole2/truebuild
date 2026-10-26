/** @type {import('jest').Config} */
module.exports = {
    preset: 'jest-expo',
    rootDir: __dirname,
    // Vitest owns the *.test.ts non-UI suites (storage, domain, API client); Jest runs only UI-owner *.test.tsx files.
    testMatch: [
        '<rootDir>/app/**/*.test.tsx',
        '<rootDir>/src/features/**/*.test.tsx',
        '<rootDir>/src/components/**/*.test.tsx',
    ],
    transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|expo-.*|@expo/.*|react-native-.*)',
    ],
}
