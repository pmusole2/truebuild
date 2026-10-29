import {
    createContext,
    useContext,
    useEffect,
    useState,
    useSyncExternalStore,
    type ReactElement,
    type ReactNode,
} from 'react'
import { judgeStorage } from './judge-storage'
import { createJudgeStore, type JudgeStore } from './judge-store'

const OFF = Object.freeze({ ready: true, showBuilt: false })
const JudgeContext = createContext<JudgeStore | null>(null)

/** The app's one judge preference store, restored once. Screens never wait for it. */
export function JudgeProvider({
    store: provided,
    children,
}: {
    readonly store?: JudgeStore
    readonly children: ReactNode
}): ReactElement {
    const [store] = useState(() => provided ?? createJudgeStore(judgeStorage))
    useEffect(() => {
        void store.restore()
    }, [store])
    return <JudgeContext.Provider value={store}>{children}</JudgeContext.Provider>
}

/** `showBuilt` is false without a provider, so a screen in a test or preview shows nothing extra. */
export function useJudge(): { readonly showBuilt: boolean; readonly setShowBuilt: (on: boolean) => void } {
    const store = useContext(JudgeContext)
    const snapshot = useSyncExternalStore(
        store?.subscribe ?? ((): (() => void) => (): void => undefined),
        store?.getSnapshot ?? ((): typeof OFF => OFF),
        store?.getSnapshot ?? ((): typeof OFF => OFF),
    )
    return { showBuilt: snapshot.showBuilt, setShowBuilt: (on: boolean): void => store?.setShowBuilt(on) }
}
