import { lazy, Suspense, type ReactElement } from 'react'
import { ActivityIndicator } from 'react-native'

// Development-only live registry view. Gated at compile time here and by the layout guard; it never opens in production
// and it imports the real registry and viewer only, never the viewer fixtures.
const Gallery =
    __DEV__ && process.env.EXPO_PUBLIC_PIECES_TEST === '1'
        ? lazy(() => import('../src/features/pieces/pieces-test-screen'))
        : null

export default function PiecesTestRoute(): ReactElement | null {
    if (Gallery === null) return null
    return (
        <Suspense fallback={<ActivityIndicator accessibilityLabel="Opening registry view" />}>
            <Gallery />
        </Suspense>
    )
}
