import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

// The cold-start lease belongs to the provider that lives as long as the process: a force-quit starts a new one, a warm
// resume, a pop back to Home or a background trip never does. Nothing here is persisted.
type ColdStartLease = { readonly take: () => boolean }

const ColdStartContext = createContext<ColdStartLease | null>(null)

export function ColdStartProvider({ children }: { readonly children: ReactNode }): ReactElement {
    const taken = useRef(false)
    const lease = useRef<ColdStartLease>({
        take: (): boolean => {
            const available = !taken.current
            taken.current = true
            return available
        },
    })
    return <ColdStartContext.Provider value={lease.current}>{children}</ColdStartContext.Provider>
}

/**
 * True once, for the one screen that is ready on the first cold start. The lease is consumed the first time `ready`
 * becomes true, whether or not the screen may animate at that moment (`held`): a later focus, pop or resume never
 * gets a launch entrance. Without a provider (previews, tests) there is no lease and nothing plays.
 */
export function useColdEntrance(ready: boolean, held: boolean): boolean {
    const lease = useContext(ColdStartContext)
    const consumed = useRef(false)
    const [granted, setGranted] = useState(false)
    // Claim only after a ready render commits; an abandoned render must not spend the process lease.
    useLayoutEffect(() => {
        if (ready && !consumed.current && lease !== null) {
            consumed.current = true
            setGranted(lease.take() && !held)
        }
    }, [ready, held, lease])
    return granted
}
