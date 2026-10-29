import {
    createContext,
    useContext,
    useLayoutEffect,
    useState,
    type Dispatch,
    type ReactElement,
    type ReactNode,
    type SetStateAction,
} from 'react'
import { View } from 'react-native'
import { screenDocumentV2Schema, type ScreenDocumentV2 } from '@truebuild/contracts'

type Owner = { document: ScreenDocumentV2 | null; publish: Dispatch<SetStateAction<ScreenDocumentV2 | null>> }
const Context = createContext<Owner | null>(null)

export function useDocumentOwnershipId(): string | null {
    return useContext(Context)?.document?.screenId ?? null
}

/** Ownership is distinct from attribution: navigation mechanics are shell, bound to the real focused document. */
export function DocumentOwnershipProvider({ children }: { children: ReactNode }): ReactElement {
    const [document, publish] = useState<ScreenDocumentV2 | null>(null)
    return <Context.Provider value={{ document, publish }}>{children}</Context.Provider>
}

export function useDocumentOwner(document: ScreenDocumentV2, focused: boolean): void {
    const owner = useContext(Context)
    const publish = owner?.publish
    useLayoutEffect(() => {
        if (!focused || publish === undefined) return undefined
        // Never establish ownership from a fabricated id or an unvalidated partial document.
        if (!screenDocumentV2Schema.safeParse(document).success) return undefined
        publish(document)
        return (): void => publish((current) => (current === document ? null : current))
    }, [publish, focused, document])
}

/** The native navigator renders this document's transitions/back stack. Its hosts retain default shell attribution. */
export function DocumentNavigationRoot({ children }: { children: ReactNode }): ReactElement {
    const owner = useContext(Context)
    return (
        <View
            testID="document-navigation-root"
            collapsable={false}
            nativeID={owner?.document == null ? undefined : `truebuild-document-navigation:${owner.document.screenId}`}
            style={{ flex: 1 }}
        >
            {children}
        </View>
    )
}

/** Route content must establish its own document root; the navigator cannot confer ownership on leftover content. */
export function DocumentRouteBoundary({ children }: { children: ReactNode }): ReactElement {
    const owner = useContext(Context)
    return (
        <View
            style={{ flex: 1 }}
            nativeID={
                owner?.document == null ? undefined : `truebuild-document-content-boundary:${owner.document.screenId}`
            }
        >
            {children}
        </View>
    )
}
