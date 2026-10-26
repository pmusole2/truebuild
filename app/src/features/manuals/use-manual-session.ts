import { createDemoManual, type ManualSession } from '@truebuild/contracts'
import { useEffect, useState } from 'react'
import { localStore } from './local-store'
import { DEMO_MANUAL_ID } from './workspace-state'

export type SessionLoad =
    | { readonly status: 'loading' }
    | { readonly status: 'ready'; readonly session: ManualSession; readonly savedRevision: number | null }
    | { readonly status: 'missing' }
    | { readonly status: 'failed' }

// The built-in demo is code-defined and never read from storage. Saved manuals come only from local storage.
export function useManualSession(manualId: string): SessionLoad {
    const [load, setLoad] = useState<SessionLoad>({ status: 'loading' })

    useEffect(() => {
        let active = true
        setLoad({ status: 'loading' })
        if (manualId === DEMO_MANUAL_ID) {
            const demo = createDemoManual()
            setLoad({ status: 'ready', session: demo, savedRevision: demo.revision })
            return (): void => {
                active = false
            }
        }
        localStore
            .loadManual(manualId)
            .then((session) => {
                if (!active) {
                    return
                }
                setLoad(
                    session === null
                        ? { status: 'missing' }
                        : { status: 'ready', session, savedRevision: session.revision },
                )
            })
            .catch(() => {
                if (active) {
                    setLoad({ status: 'failed' })
                }
            })
        return (): void => {
            active = false
        }
    }, [manualId])

    return load
}
