import { Stack } from 'expo-router'
import type { ReactElement } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider } from '../src/theme/theme'
import { FeedbackProvider } from '../src/ui/feedback'
import { nativeHaptics } from '../src/ui/haptics'

// Screens draw their own top bars with the safe-area shell, so the native header stays hidden everywhere.
export default function RootLayout(): ReactElement {
    return (
        <SafeAreaProvider>
            <ThemeProvider>
                <FeedbackProvider haptics={nativeHaptics}>
                    <Stack screenOptions={{ headerShown: false }}>
                        <Stack.Screen name="index" />
                    </Stack>
                </FeedbackProvider>
            </ThemeProvider>
        </SafeAreaProvider>
    )
}
