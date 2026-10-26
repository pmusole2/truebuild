import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ReactElement } from 'react'
import { Text, View } from 'react-native'
import { palette, space } from '../../../src/components/theme'
import { AssemblyScreen } from '../../../src/features/assembly/assembly-screen'
import { runCheck } from '../../../src/features/assembly/check-runner'
import { localStore } from '../../../src/features/manuals/local-store'
import { useManualSession } from '../../../src/features/manuals/use-manual-session'

export default function AssemblyRoute(): ReactElement {
    const { manualId, stepId } = useLocalSearchParams<{ manualId: string; stepId: string }>()
    const router = useRouter()
    const load = useManualSession(manualId)

    if (load.status !== 'ready') {
        const message = load.status === 'loading' ? 'Loading step…' : 'This manual is not available on this device.'
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

    const step = load.session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    if (step === undefined) {
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
                <Text style={{ color: palette.charcoal, fontSize: 16 }}>That step is not in this manual.</Text>
            </View>
        )
    }

    return (
        <AssemblyScreen
            key={`${manualId}-${load.session.revision}-${step.stepId}`}
            session={load.session}
            step={step}
            runCheck={runCheck}
            loadPageAsset={(assetId) => localStore.loadPageAsset(assetId)}
            onBack={() => router.back()}
        />
    )
}
