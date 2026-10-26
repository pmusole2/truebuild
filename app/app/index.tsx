import { useRouter } from 'expo-router'
import type { ReactElement } from 'react'
import { LibraryScreen } from '../src/features/manuals/library-screen'

export default function IndexRoute(): ReactElement {
    const router = useRouter()
    return (
        <LibraryScreen
            onOpenManual={(manualId) => router.push(`/manual/${manualId}`)}
            onOpenConnection={() => router.push('/connection')}
        />
    )
}
