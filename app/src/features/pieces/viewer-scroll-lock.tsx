import { useSyncExternalStore, type ComponentPropsWithRef, type ReactElement } from 'react'
import { ScrollView } from 'react-native'

// Module-level so nested, repeated and separately mounted 3D views share one answer; a set keeps each owner idempotent.
const owners = new Set<object>()
const listeners = new Set<() => void>()

function notify(): void {
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return (): void => {
        listeners.delete(listener)
    }
}

function pageLocked(): boolean {
    return owners.size > 0
}

/** A 3D view holds the page still for its own live drag. Repeated or unknown owners change nothing. */
export function lockPageScroll(owner: object): void {
    if (owners.has(owner)) return
    owners.add(owner)
    notify()
}

export function unlockPageScroll(owner: object): void {
    if (!owners.delete(owner)) return
    notify()
}

/** A page scroller that may wrap a 3D view: native scrolling stops while any view owns a drag, and resumes after it. */
export function ViewerScrollView(props: ComponentPropsWithRef<typeof ScrollView>): ReactElement {
    const locked = useSyncExternalStore(subscribe, pageLocked)
    return <ScrollView {...props} scrollEnabled={(props.scrollEnabled ?? true) && !locked} />
}
