import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ReactElement } from 'react'
import { Text, View } from 'react-native'
import { palette, space } from '../../src/components/theme'
import { ManualScreen } from '../../src/features/manuals/manual-screen'
import { useManualSession } from '../../src/features/manuals/use-manual-session'

export default function ManualRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const router = useRouter()
    const load = useManualSession(manualId)

    if (load.status === 'ready') {
        return (
            <ManualScreen
                key={`${manualId}-${load.session.revision}-${load.savedRevision ?? 'none'}`}
                initialSession={load.session}
                initialSavedRevision={load.savedRevision}
                onOpenCheck={(stepId) => router.push(`/assembly/${manualId}/${stepId}`)}
                onDeleted={() => router.replace('/')}
            />
        )
    }

    const message =
        load.status === 'loading'
            ? 'Loading manual…'
            : load.status === 'missing'
              ? 'This manual is not saved on this device.'
              : 'This manual could not be read from local storage.'
    return (
        <View
            style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                padding: space.md,
                backgroundColor: palette.paper,
            }}
        >
            <Text style={{ color: palette.charcoal, fontSize: 16 }}>{message}</Text>
        </View>
    )
}
