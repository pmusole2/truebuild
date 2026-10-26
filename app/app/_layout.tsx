import { Stack } from 'expo-router'
import type { ReactElement } from 'react'
import { palette } from '../src/components/theme'

export default function RootLayout(): ReactElement {
    return (
        <Stack
            screenOptions={{
                headerStyle: { backgroundColor: palette.paper },
                headerTintColor: palette.charcoal,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: palette.paper },
            }}
        >
            <Stack.Screen name="index" options={{ title: 'TrueBuild' }} />
            <Stack.Screen name="manual/[manualId]" options={{ title: 'Manual' }} />
            <Stack.Screen name="assembly/[manualId]/[stepId]" options={{ title: 'Step check' }} />
            <Stack.Screen name="connection" options={{ title: 'Live backend' }} />
        </Stack>
    )
}
