import {
    createContext,
    useCallback,
    useContext,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ComponentRef,
    type ReactElement,
    type RefObject,
    type ReactNode,
} from 'react'
import { View } from 'react-native'
import { screenDocumentV2Schema, type ScreenDocumentV2, type VariantState } from '@truebuild/contracts'
import { mergeNativeIds, originId, type RenderOrigin } from '../../ui/render-origin'
import { nativeFrameOrigins, type NativeFrameOriginDiagnostic } from '../../ui/native-frame-origin'

interface Claim {
    readonly document: ScreenDocumentV2
    readonly origin: RenderOrigin
    readonly focused: boolean
    readonly state: 'ready' | VariantState
}
type Register = (token: object, claim: Claim | null) => void
interface Owner {
    readonly current: Claim | null
    readonly register: Register
}
const Context = createContext<Owner | null>(null)
const RouteContext = createContext<Owner | null>(null)

export interface DocumentFrameOwner {
    readonly documentId: string
    readonly origin: RenderOrigin
    readonly focused: boolean
}
function frameOf(claim: Claim | null): DocumentFrameOwner | null {
    return claim === null ? null : { documentId: claim.document.screenId, origin: claim.origin, focused: claim.focused }
}
/** The nearest real frame, rather than the last globally focused sheet. */
export function useDocumentFrameOwner(): DocumentFrameOwner | null {
    const local = useContext(RouteContext)
    const global = useContext(Context)
    return frameOf(local === null ? (global?.current ?? null) : local.current)
}

/** A modal owns its own published document and cannot borrow another route or nested modal's provenance. */
export function DocumentOwnershipScope({
    children,
}: {
    children: (owner: DocumentFrameOwner | null) => ReactNode
}): ReactElement {
    const owner = useOwners()
    return <RouteContext.Provider value={owner}>{children(frameOf(owner.current))}</RouteContext.Provider>
}

function latest(claims: ReadonlyMap<object, Claim>): Claim | null {
    const values = [...claims.values()]
    return values.findLast((claim) => claim.focused) ?? values.at(-1) ?? null
}
function useOwners(): Owner {
    const [claims, setClaims] = useState<ReadonlyMap<object, Claim>>(() => new Map())
    const register = useCallback<Register>((token, claim) => {
        setClaims((previous) => {
            if (claim === null && !previous.has(token)) return previous
            const next = new Map(previous)
            next.delete(token)
            if (claim !== null) next.set(token, claim)
            return next
        })
    }, [])
    return useMemo(() => ({ current: latest(claims), register }), [claims, register])
}

export function useDocumentOwnershipId(): string | null {
    return useContext(Context)?.current?.document.screenId ?? null
}

/** Multiple real publishers restore in registration order; unmounting one cannot clear another's ownership. */
export function DocumentOwnershipProvider({ children }: { children: ReactNode }): ReactElement {
    const owner = useOwners()
    return <Context.Provider value={owner}>{children}</Context.Provider>
}

export function useDocumentOwner(
    document: ScreenDocumentV2,
    focused: boolean,
    state: 'ready' | VariantState = 'ready',
): void {
    const register = useContext(Context)?.register
    const registerRoute = useContext(RouteContext)?.register
    const token = useRef<object>({})
    useLayoutEffect(() => {
        if (!screenDocumentV2Schema.safeParse(document).success) return undefined
        const prefix = state === 'ready' ? '' : `states.${state}.`
        const origin = document.metadata.origins[`${prefix}body`]
        if (origin === undefined) return undefined
        const claim: Claim = { document, origin, focused, state }
        // A retained route still renders its own document, even though only a focused publisher owns global chrome.
        registerRoute?.(token.current, claim)
        if (focused) register?.(token.current, claim)
        const key = token.current
        return (): void => {
            registerRoute?.(key, null)
            if (focused) register?.(key, null)
        }
    }, [register, registerRoute, document, focused, state])
}

const frameDiagnostic =
    process.env.EXPO_PUBLIC_RELEASE_FIXTURE === '1'
        ? (entry: NativeFrameOriginDiagnostic): void => {
              console.info(JSON.stringify({ event: 'native_frame_origin', ...entry }))
          }
        : undefined

function useNativeFrameBinding(
    root: RefObject<ComponentRef<typeof View> | null>,
    claim: Claim | null | undefined,
): void {
    const navigation = useContext(Context)?.current
    useLayoutEffect(() => {
        if (claim == null) return undefined
        return nativeFrameOrigins.bind(root.current, claim.document, {
            focused: claim.focused,
            state: claim.state,
            diagnostic: frameDiagnostic,
        })
    }, [root, claim, navigation])
}

/**
 * This wrapper's own host implements the document frame (Part 1.3). It does not confer that origin on the navigator:
 * both meter implementations reset descendant inheritance at document-navigation/content-boundary markers.
 */
export function DocumentNavigationRoot({ children }: { children: ReactNode }): ReactElement {
    const claim = useContext(Context)?.current
    return (
        <View
            testID="document-navigation-root"
            collapsable={false}
            nativeID={
                claim == null
                    ? undefined
                    : mergeNativeIds(`truebuild-document-navigation:${claim.document.screenId}`, originId(claim.origin))
            }
            style={{ flex: 1 }}
        >
            {children}
        </View>
    )
}

/** A route owns only its actual displayed document; a newly focused route cannot relabel a retained background one. */
export function DocumentRouteBoundary({ children }: { children: ReactNode }): ReactElement {
    const owner = useOwners()
    const claim = owner.current
    const root = useRef<ComponentRef<typeof View>>(null)
    useNativeFrameBinding(root, claim)
    return (
        <RouteContext.Provider value={owner}>
            <View
                ref={root}
                collapsable={false}
                style={{ flex: 1 }}
                nativeID={mergeNativeIds(
                    `truebuild-document-content-boundary:${claim?.document.screenId ?? 'unowned'}`,
                    originId(claim?.origin ?? 'shell'),
                )}
            >
                {children}
            </View>
        </RouteContext.Provider>
    )
}
