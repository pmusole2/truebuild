import {
    screenDocumentV2Schema,
    variantsOfV2,
    visitVariantNodesV2,
    type ScreenDocumentV2,
    type VariantState,
} from '@truebuild/contracts'
import { composeNativeMeterMarkers, parseNativeMeterMarkers, type NativeMeterOrigin } from './native-meter-markers'

/** The bridge uses only the public native host API; no React or renderer internals are inspected. */
export interface NativeFrameNode {
    readonly nodeName: string
    readonly isConnected: boolean
    readonly id?: string
    readonly parentNode?: unknown
    readonly childNodes: ArrayLike<unknown>
    readonly setNativeProps?: (props: { nativeID: string }) => void
}
export interface NativeFrameOriginDiagnostic {
    readonly nodeName: string
    readonly role: 'route' | 'modal'
    readonly status: 'observed' | 'command-submitted' | 'preserved' | 'unsupported'
    readonly reason:
        | 'validated-public-parent-chain'
        | 'unsupported-frame-path'
        | 'explicit-marker-or-unsupported-writer'
        | 'native-id-invocation-returned'
        | 'native-id-release-invocation-returned'
        | 'native-id-retention-invocation-returned'
        | 'native-id-command-threw'
    /** Source invocation state only; none of these fields establishes native application/readback. */
    readonly previousSubmittedEmpty?: boolean | null
    readonly declaredEmpty?: boolean
    readonly nextSubmittedEmpty?: boolean
}
interface BindingOptions {
    readonly focused: boolean
    readonly state?: 'ready' | VariantState
    readonly diagnostic?: (entry: NativeFrameOriginDiagnostic) => void
    readonly role?: 'route' | 'modal'
    readonly visible?: boolean
    readonly originPath?: string
}
interface Claim {
    readonly anchor: NativeFrameNode
    readonly documentId: string
    readonly origin: NativeMeterOrigin
    readonly options: BindingOptions
    readonly path: readonly NativeFrameNode[]
    readonly targets: readonly NativeFrameNode[]
    active: boolean
}
interface HeldHost {
    readonly baseId: string
    readonly releaseId: string
    readonly name: string
    readonly claims: Map<Claim, string>
    submittedId: string
    failed: boolean
}
const nameOf = (node: NativeFrameNode): string => node.nodeName.replace(/^RN:/u, '')
const isScreen = (node: NativeFrameNode): boolean => /^(?:RNSScreen|RNSModalScreen)$/u.test(nameOf(node))
const isFrame = (node: NativeFrameNode): boolean =>
    /^(?:View|RNCSafeAreaProvider|RNCSafeAreaView|RNSSafeAreaView|RNSScreenContentWrapper|RNSScreenStack)$/u.test(
        nameOf(node),
    )
function isNode(value: unknown): value is NativeFrameNode {
    return typeof value === 'object' && value !== null && 'nodeName' in value && 'childNodes' in value
}
function childrenOf(node: NativeFrameNode): readonly NativeFrameNode[] | null {
    const { childNodes } = node
    if (!Number.isSafeInteger(childNodes.length) || childNodes.length < 0 || childNodes.length > 128) return null
    const children = Array.from(childNodes)
    return children.every(isNode) ? children : null
}
function ownsAnchor(anchor: NativeFrameNode, documentId: string, origin: NativeMeterOrigin): boolean {
    if (anchor.isConnected !== true) return false
    const markers = parseNativeMeterMarkers(anchor.id)
    return markers.origin === origin && markers.documentContentBoundary === documentId
}

/** Recognized ancestors only. Unknown or ambiguous topology makes the entire binding ineligible. */
function framePath(
    anchor: NativeFrameNode,
    documentId: string,
    origin: NativeMeterOrigin,
    options: BindingOptions,
    idOf: (node: NativeFrameNode) => string | undefined = (node) => node.id,
): { path: readonly NativeFrameNode[]; targets: readonly NativeFrameNode[] } | null {
    if (!ownsAnchor(anchor, documentId, origin)) return null
    const path = [anchor]
    const targets: NativeFrameNode[] = []
    let screen: NativeFrameNode | null = null
    for (let depth = 0; depth < 16; depth++) {
        const child = path.at(-1)!
        const parent: unknown = child.parentNode
        if (!isNode(parent) || parent.isConnected !== true || path.includes(parent)) return null
        if (!childrenOf(parent)?.includes(child)) return null
        path.push(parent)
        const markers = parseNativeMeterMarkers(idOf(parent))
        if (markers.documentNavigation !== null) {
            if (screen === null) return null
            if (markers.documentNavigation !== documentId || markers.origin !== origin) {
                path.splice(path.indexOf(screen) + 1)
                targets.splice(targets.indexOf(screen) + 1)
            }
            break
        }
        // Never cross another document, modal, overlay, or any unrecognized SDK host.
        if (markers.documentContentBoundary !== null || markers.documentRoot !== null) return null
        if (isScreen(parent)) {
            if (screen !== null) return null
            screen = parent
        } else if (!isFrame(parent)) return null
        targets.push(parent)
        if (screen !== null && !options.focused) break
        if (depth === 15) return null
    }
    if (screen === null) return null
    const children = childrenOf(screen)
    if (children === null) return null
    // The native stack's hidden header config is a direct screen-owned frame host, never a subtree grant.
    for (const child of children) {
        if (nameOf(child) === 'RNSScreenStackHeaderConfig' && child.parentNode === screen && child.isConnected)
            targets.push(child)
    }
    return { path, targets }
}

/** A real sheet's single SDK frame chain ends at its own nearest ModalHost, before any app/navigation root. */
function modalPath(
    anchor: NativeFrameNode,
    documentId: string,
    origin: NativeMeterOrigin,
    options: BindingOptions,
    idOf: (node: NativeFrameNode) => string | undefined,
): ReturnType<typeof framePath> {
    if (options.visible !== true || !ownsAnchor(anchor, documentId, origin)) return null
    const path = [anchor],
        targets: NativeFrameNode[] = []
    for (let depth = 0; depth < 16; depth++) {
        const child = path.at(-1)!
        const parent: unknown = child.parentNode
        if (!isNode(parent) || !parent.isConnected || path.includes(parent)) return null
        const children = childrenOf(parent)
        if (children?.length !== 1 || children[0] !== child) return null
        const markers = parseNativeMeterMarkers(idOf(parent))
        if (
            markers.documentNavigation !== null ||
            markers.documentRoot !== null ||
            markers.capability !== null ||
            markers.development
        )
            return null
        if (markers.documentContentBoundary !== null && markers.documentContentBoundary !== documentId) return null
        if (markers.origin !== null && markers.origin !== origin) return null
        path.push(parent)
        targets.push(parent)
        if (/^(?:RCTModalHostView|ModalHostView)$/u.test(nameOf(parent))) return { path, targets }
        if (!/^(?:View|RNCSafeAreaProvider|RNCSafeAreaView|RNSSafeAreaView)$/u.test(nameOf(parent))) return null
    }
    return null
}

export class InvalidNativeFrameOrigin extends Error {
    constructor() {
        super('invalid_native_frame_origin')
    }
}

/**
 * Exact document-frame ownership plus a nonthrowing nativeID invocation supplies logical source attribution.
 * RN's public .id can remain declarative; submitted commands have no physical native property read-back here.
 * Each read must still prove the original ref and route parent chain, which ends at the navigation root.
 */
export class NativeFrameOriginRegistry {
    private readonly hosts = new WeakMap<NativeFrameNode, HeldHost>()
    private nextRetainedId = 0

    bindModal(
        anchor: unknown,
        document: ScreenDocumentV2,
        options: BindingOptions & { readonly visible: boolean },
    ): () => void {
        return this.bind(anchor, document, { ...options, role: 'modal' })
    }

    bind(anchor: unknown, document: ScreenDocumentV2, options: BindingOptions): () => void {
        if (!isNode(anchor) || !screenDocumentV2Schema.safeParse(document).success) return (): void => {}
        const prefix = options.state === undefined || options.state === 'ready' ? '' : `states.${options.state}.`
        const path = options.originPath ?? `${prefix}body`
        let coachPath = false
        if (options.role === 'modal') {
            const selected = variantsOfV2(document).find((item) => item.prefix === prefix)
            if (selected !== undefined)
                visitVariantNodesV2(selected.variant, prefix, (entry) => {
                    if (entry.path === path && entry.node.type === 'CoachMark') coachPath = true
                })
        }
        if (path !== `${prefix}body` && !path.startsWith(`${prefix}body.`) && !coachPath) return (): void => {}
        const origin = document.metadata.origins[path]
        if (origin === undefined) return (): void => {}
        let planned: ReturnType<typeof framePath>
        try {
            planned = this.plan(anchor, document.screenId, origin, options)
        } catch {
            return (): void => {}
        }
        if (planned === null) {
            this.diagnostic(anchor, options, 'unsupported', 'unsupported-frame-path')
            return (): void => {}
        }
        for (const node of planned.path) this.diagnostic(node, options, 'observed', 'validated-public-parent-chain')
        const claim: Claim = { anchor, documentId: document.screenId, origin, options, ...planned, active: true }
        for (const node of claim.targets) this.add(node, claim)
        return (): void => {
            if (!claim.active) return
            claim.active = false
            for (const node of claim.targets) this.remove(node, claim)
        }
    }

    private diagnostic(
        node: NativeFrameNode,
        options: BindingOptions,
        status: NativeFrameOriginDiagnostic['status'],
        reason: NativeFrameOriginDiagnostic['reason'],
        write?: {
            readonly previousSubmittedEmpty: boolean | null
            readonly declaredEmpty: boolean
            readonly nextSubmittedEmpty: boolean
        },
    ): void {
        try {
            options.diagnostic?.({ nodeName: node.nodeName, role: options.role ?? 'route', status, reason, ...write })
        } catch {
            // Diagnostic delivery cannot change attribution.
        }
    }

    private plan(
        anchor: NativeFrameNode,
        documentId: string,
        origin: NativeMeterOrigin,
        options: BindingOptions,
    ): ReturnType<typeof framePath> {
        const idOf = (node: NativeFrameNode): string | undefined => {
            const held = this.hosts.get(node)
            return held !== undefined && this.validHost(node, held) ? held.baseId : node.id
        }
        return options.role === 'modal'
            ? modalPath(anchor, documentId, origin, options, idOf)
            : framePath(anchor, documentId, origin, options, idOf)
    }

    private valid(claim: Claim): boolean {
        if (!claim.active) return false
        const planned = this.plan(claim.anchor, claim.documentId, claim.origin, claim.options)
        return (
            planned !== null &&
            planned.path.length === claim.path.length &&
            planned.path.every((node, index) => node === claim.path[index]) &&
            planned.targets.length === claim.targets.length &&
            planned.targets.every((node, index) => node === claim.targets[index])
        )
    }

    private add(node: NativeFrameNode, claim: Claim): void {
        let held = this.hosts.get(node)
        const previousSubmittedEmpty = held === undefined ? null : held.submittedId === ''
        try {
            if (held === undefined) {
                const baseId = node.id ?? ''
                const markers = parseNativeMeterMarkers(baseId)
                // Preserve all explicit attribution, capability and ownership contracts.
                if (
                    markers.origin !== null ||
                    markers.capability !== null ||
                    markers.development ||
                    markers.documentRoot !== null ||
                    markers.documentContentBoundary !== null ||
                    markers.documentNavigation !== null ||
                    typeof node.setNativeProps !== 'function'
                ) {
                    this.diagnostic(node, claim.options, 'preserved', 'explicit-marker-or-unsupported-writer')
                    return
                }
                // A nativeID forms a layout-only View in Fabric. Releasing credit must not flatten that host.
                // This ordinary opaque ID retains no document/origin/capability marker; baseId still owns planning.
                const releaseId =
                    baseId === '' && nameOf(node) === 'View'
                        ? `truebuild_frame_retained_${++this.nextRetainedId}`
                        : baseId
                held = { baseId, releaseId, name: node.nodeName, claims: new Map(), submittedId: baseId, failed: false }
            } else if (!this.validHost(node, held)) return
            const marker = composeNativeMeterMarkers(
                held.baseId,
                `truebuild-document-content-boundary:${claim.documentId}`,
                `truebuild-render-origin:${claim.origin}`,
            )
            if (typeof node.setNativeProps !== 'function') throw new InvalidNativeFrameOrigin()
            const declaredEmpty = (node.id ?? '') === ''
            node.setNativeProps({ nativeID: marker })
            held.claims.set(claim, marker)
            held.submittedId = marker
            held.failed = false
            this.hosts.set(node, held)
            this.diagnostic(node, claim.options, 'command-submitted', 'native-id-invocation-returned', {
                previousSubmittedEmpty,
                declaredEmpty,
                nextSubmittedEmpty: marker === '',
            })
        } catch {
            if (held !== undefined) {
                if (held.claims.size !== 0) held.failed = true
                else {
                    try {
                        if ((node.id ?? '') !== held.baseId) {
                            held.failed = true
                            this.hosts.set(node, held)
                        }
                    } catch {
                        held.failed = true
                        this.hosts.set(node, held)
                    }
                }
            }
            this.diagnostic(node, claim.options, 'unsupported', 'native-id-command-threw')
            // A throwing invocation cannot support a new source claim.
        }
    }

    private validHost(node: NativeFrameNode, held: HeldHost): boolean {
        return (
            node.isConnected === true &&
            node.nodeName === held.name &&
            typeof node.setNativeProps === 'function' &&
            !held.failed &&
            ((node.id ?? '') === held.baseId || node.id === held.submittedId)
        )
    }

    private remove(node: NativeFrameNode, claim: Claim): void {
        const held = this.hosts.get(node)
        if (held === undefined || !held.claims.delete(claim)) return
        try {
            if (!this.validHost(node, held)) {
                held.failed = true
                return
            }
            const remaining = [...held.claims].findLast(([owner]) => this.valid(owner))
            const marker = remaining?.[1] ?? held.releaseId
            if (typeof node.setNativeProps !== 'function') throw new InvalidNativeFrameOrigin()
            const previousSubmittedEmpty = held.submittedId === ''
            const declaredEmpty = (node.id ?? '') === ''
            node.setNativeProps({ nativeID: marker })
            held.submittedId = marker
            this.diagnostic(
                node,
                claim.options,
                'command-submitted',
                remaining !== undefined
                    ? 'native-id-invocation-returned'
                    : held.releaseId !== held.baseId
                      ? 'native-id-retention-invocation-returned'
                      : 'native-id-release-invocation-returned',
                { previousSubmittedEmpty, declaredEmpty, nextSubmittedEmpty: marker === '' },
            )
        } catch {
            held.failed = true
        }
    }

    markerFor(node: NativeFrameNode): string | undefined {
        const held = this.hosts.get(node)
        if (held === undefined) return undefined
        try {
            if (!this.validHost(node, held)) throw new InvalidNativeFrameOrigin()
            const owner = [...held.claims].findLast(([claim]) => this.valid(claim))
            if (owner === undefined) {
                if (held.claims.size !== 0 || held.submittedId !== held.releaseId) throw new InvalidNativeFrameOrigin()
                return undefined
            }
            if (owner[1] !== held.submittedId) throw new InvalidNativeFrameOrigin()
            return held.submittedId
        } catch {
            throw new InvalidNativeFrameOrigin()
        }
    }
}
export const nativeFrameOrigins = new NativeFrameOriginRegistry()
