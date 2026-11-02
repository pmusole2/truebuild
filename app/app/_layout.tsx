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
import { FeedbackProvider, useFeedback } from '../src/ui/feedback'
import { nativeHaptics } from '../src/ui/haptics'
import { DocumentNavigationRoot, DocumentOwnershipProvider } from '../src/features/documents/ownership'

// Documents own the visible header. The native Stack retains Back gestures and transitions when motion is enabled.
// The controller above it preserves the held photo, result and draft across pushes, pops and swipes.
function ThemedStack(): ReactElement {
    const header = useHeaderStyle()
    const { colors } = useTheme()
    const { reduceMotion } = useFeedback()
    return (
        <>
            <StatusBar style={statusBarStyleFor(colors)} />
            <Stack
                screenOptions={{
                    ...header,
                    headerShown: false,
                    headerBackButtonDisplayMode: 'minimal',
                    animation: reduceMotion ? 'none' : undefined,
                }}
            >
                <Stack.Screen name="index" options={{ title: 'TrueBuild' }} />
                <Stack.Screen
                    name="camera"
                    options={{
                        headerShown: false,
                        presentation: 'fullScreenModal',
                        gestureEnabled: false,
                        animation: reduceMotion ? 'none' : 'slide_from_bottom',
                    }}
                />
                <Stack.Protected
                    guard={
                        __DEV__ &&
                        process.env.EXPO_PUBLIC_PIECE_VIEWER_TEST === '1' &&
                        process.env.EXPO_PUBLIC_PROVIDER_MODE === 'fixture'
                    }
                >
                    <Stack.Screen name="piece-viewer-test" options={{ headerShown: false }} />
                </Stack.Protected>
                <Stack.Protected guard={__DEV__ && process.env.EXPO_PUBLIC_PIECES_TEST === '1'}>
                    <Stack.Screen name="pieces-test" options={{ headerShown: false }} />
                </Stack.Protected>
            </Stack>
        </>
    )
}

export default function RootLayout(): ReactElement {
    return (
        <DocumentOwnershipProvider>
            <DocumentNavigationRoot>
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
            </DocumentNavigationRoot>
        </DocumentOwnershipProvider>
    )
}
