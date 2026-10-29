import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ComponentRef,
    type RefCallback,
    type RefObject,
} from 'react'
import type { HostInstance, View } from 'react-native'

/** What kind of root a component hands the host meter; it is only a label for the checkpoint's cause. */
export type MeterRootKind = 'app' | 'sheet' | 'coach' | 'camera'

/**
 * The part of the host meter a component needs: handing over a ref it already holds. The meter reads only the public
 * host instance API of those refs; nothing here touches React internals, observes mutations or polls.
 */
export interface MeterRoots {
    readonly registerRoot: (ref: HostInstance | null, kind: MeterRootKind) => () => void
}

export const MeterRootsContext = createContext<MeterRoots | null>(null)

/**
 * Registers a ref the component already holds as one of the document roots the host meter must count, while the
 * component is mounted. A modal or overlay registers its own content ref only while it is mounted, so a root that is
 * intentionally absent is not expected. A ref that has not attached when the component mounts is registered as missing,
 * which makes the measurement unavailable instead of silently leaving that root out. Inert without a meter.
 */
export function useMeterRoot(
    ref: RefObject<ComponentRef<typeof View> | null>,
    kind: MeterRootKind,
): RefCallback<ComponentRef<typeof View>> {
    const roots = useContext(MeterRootsContext)
    const [node, setNode] = useState(() => ref.current)
    const attach = useCallback(
        (next: ComponentRef<typeof View> | null): void => {
            ref.current = next
            // Ordinary runs keep the existing ref without paying for meter state updates.
            if (roots !== null) setNode(next)
        },
        [ref, roots],
    )
    useEffect(() => {
        if (roots === null) return undefined
        return roots.registerRoot(node, kind)
    }, [roots, node, kind])
    return attach
}
