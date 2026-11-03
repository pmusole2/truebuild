import { lazy, Suspense, type ReactElement } from 'react'

// Offline scene gallery, excluded from release bundles and never linked from product navigation.
const Preview =
    __DEV__ && process.env.EXPO_PUBLIC_PROVIDER_MODE === 'fixture'
        ? lazy(() => import('../src/ui/preview/blueprint-preview'))
        : null

export default function LoadersTestRoute(): ReactElement | null {
    return Preview === null ? null : (
        <Suspense fallback={null}>
            <Preview />
        </Suspense>
    )
}
