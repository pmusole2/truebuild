import { useRouter } from 'expo-router'
import type { ReactElement } from 'react'
import { ConnectionScreen } from '../src/features/connection/connection-screen'

export default function ConnectionRoute(): ReactElement {
    const router = useRouter()
    return <ConnectionScreen onBack={() => router.back()} />
}
