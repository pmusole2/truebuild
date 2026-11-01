import { lazy, Suspense, type ReactElement } from 'react'
import { ActivityIndicator } from 'react-native'

// The fixture import is behind compile-time development and explicit fixture-mode gates.
// This route has no entry in product navigation and never opens in live mode.
const Fixture =
    __DEV__ && process.env.EXPO_PUBLIC_PIECE_VIEWER_TEST === '1' && process.env.EXPO_PUBLIC_PROVIDER_MODE === 'fixture'
        ? lazy(() => import('../src/features/pieces/__fixtures__/piece-viewer-fixture'))
        : null

export default function PieceViewerTestRoute(): ReactElement | null {
    if (Fixture === null) return null
    return (
        <Suspense fallback={<ActivityIndicator accessibilityLabel="Opening test fixture" />}>
            <Fixture />
        </Suspense>
    )
}
