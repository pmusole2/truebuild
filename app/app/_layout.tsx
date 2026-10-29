import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import type { ReactElement } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { NativeRouteSync } from '../src/features/capture/native-routes'
import { useHeaderStyle } from '../src/features/capture/route-screens'
import { WorkflowProvider } from '../src/features/capture/workflow-provider'
import { ThemeProvider, useTheme } from '../src/theme/theme'
import { statusBarStyleFor } from '../src/features/capture/header-options'
import { AppCoachProvider } from '../src/features/onboarding/coach-root'
import { JudgeProvider } from '../src/features/screens/judge-context'
import { MeterTriggers, NativeMeterProvider } from '../src/features/screens/native-meter'
import { proofEvidenceLabel } from '../src/features/screens/proof-mode'
import { ColdStartProvider } from '../src/ui/cold-start'
import { FeedbackProvider } from '../src/ui/feedback'
import { nativeHaptics } from '../src/ui/haptics'

// One fixed native header for every screen but the camera. The capture controller lives above the Stack, so pushing,
// popping and swiping back never recreate it or clear a photo, a result or a draft.
function ThemedStack(): ReactElement {
    const header = useHeaderStyle()
    const { colors } = useTheme()
    return (
        <>
            <StatusBar style={statusBarStyleFor(colors)} />
            <Stack screenOptions={{ ...header, headerBackButtonDisplayMode: 'minimal' }}>
                <Stack.Screen name="index" options={{ title: 'TrueBuild' }} />
                <Stack.Screen
                    name="camera"
                    options={{
                        headerShown: false,
                        presentation: 'fullScreenModal',
                        gestureEnabled: false,
                        animation: 'slide_from_bottom',
                    }}
                />
            </Stack>
        </>
    )
}

export default function RootLayout(): ReactElement {
    return (
        <SafeAreaProvider>
            <ThemeProvider>
                <FeedbackProvider haptics={nativeHaptics}>
                    <JudgeProvider>
                        <NativeMeterProvider enabled={proofEvidenceLabel() === null ? undefined : true}>
                            <WorkflowProvider>
                                <ColdStartProvider>
                                    <AppCoachProvider>
                                        <ThemedStack />
                                        <MeterTriggers />
                                    </AppCoachProvider>
                                </ColdStartProvider>
                                <NativeRouteSync />
                            </WorkflowProvider>
                        </NativeMeterProvider>
                    </JudgeProvider>
                </FeedbackProvider>
            </ThemeProvider>
        </SafeAreaProvider>
    )
}
