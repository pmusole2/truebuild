import type { ReactElement } from 'react'
import { Stack } from 'expo-router'
import { ComponentPreview } from '../src/ui/preview/component-preview'

// Development-only gallery. Production builds render a plain notice instead of the static examples.
export default function ComponentsRoute(): ReactElement {
    return (
        <>
            <Stack.Screen options={{ title: 'Component preview' }} />
            {__DEV__ ? <ComponentPreview /> : null}
        </>
    )
}
