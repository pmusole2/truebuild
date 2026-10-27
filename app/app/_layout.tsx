import { Stack } from 'expo-router'
import type { ReactElement } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

export default function RootLayout(): ReactElement {
    return (
        <SafeAreaProvider>
            <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
            </Stack>
        </SafeAreaProvider>
    )
}
