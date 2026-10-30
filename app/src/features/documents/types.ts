import type { ReactNode } from 'react'
import type {
    AppIntent,
    ManualSession,
    PublishedManualFact,
    ScreenDocumentSource,
    ScreenIcon,
    ScreenKind,
    ScreenNode,
    ScreenNodeV2,
    ScreenDocumentV2,
    TextRefV2,
} from '@truebuild/contracts'
import type { CaptureView, SegmentMark } from '../capture/controller'
import type { ResolvedIntent } from '../screens/intents'
import type { LiveScreen } from '../screens/live'
import type { RenderOrigin } from '../screens/render-origin'

/**
 * Compatibility FrameDocument types remain for the protected demo and retained v1 tests. Production routes pass
 * the canonical ScreenDocumentV2 unchanged to DocumentRenderer; FrameBindings only supplies native IO/state.
 */

/** Camera is its own full document kind. It never borrows Guide wording as a substitute document. */
export type FrameKind = ScreenKind | 'camera' | 'judge' | 'compare'

/** Every normal and non-normal composition is a document variant. There is no native override bar beside a document. */
export type FrameVariant =
    | 'normal'
    | 'empty'
    | 'pending'
    | 'error'
    | 'recovery'
    | 'auth-needed'
    | 'busy'
    | 'blocked'
    | 'reading'
    | 'confirming'

/**
 * Recursive layout tree. Unlike the v1 leaf-only `Group`/`DetailsDisclosure`, layout nodes hold a recursive
 * `children: FrameNode[]` at any depth. No 14/28/6 node caps are enforced by the renderer; resource guards, when
 * needed, belong to validation of a specific document, not to the tree shape.
 */
export type FrameLayoutNode =
    | { readonly type: 'Stack'; readonly gap?: 'xs' | 'sm' | 'md' | 'lg'; readonly children: readonly FrameNode[] }
    | { readonly type: 'Row'; readonly gap?: 'xs' | 'sm' | 'md' | 'lg'; readonly children: readonly FrameNode[] }
    | { readonly type: 'Grid'; readonly columns: 1 | 2 | 3 | 4; readonly children: readonly FrameNode[] }
    | {
          readonly type: 'Card'
          readonly tone?: 'surface' | 'raised' | 'result'
          readonly children: readonly FrameNode[]
      }
    | {
          readonly type: 'Section'
          readonly label: string
          /** Disclosure semantics: collapsed until opened, except a section holding a Warning is forced open. */
          readonly initiallyOpen?: boolean
          readonly collapsible?: boolean
          readonly children: readonly FrameNode[]
      }
    | { readonly type: 'Divider' }
    | { readonly type: 'Spacer'; readonly size?: 'xs' | 'sm' | 'md' | 'lg' }
    | { readonly type: 'Scroll'; readonly children: readonly FrameNode[] }

/** A leaf is exactly the published v1 catalog leaf/heavy vocabulary; the adapter widens containers recursively. */
export type FrameLeafNode = ScreenNode

/** A v2 catalog leaf rendered natively by the renderer (content/control/native families of `ScreenNodeV2`). */
export type FrameV2Leaf = { readonly type: 'V2Leaf'; readonly node: ScreenNodeV2 }

export type FrameNode = FrameLayoutNode | FrameLeafNode | FrameV2Leaf

export type FrameHeader = {
    readonly title: string
    readonly subtitle: string | null
    /** Closed intent only. The renderer binds it through `bindings.resolve`; it never names a route or handler. */
    readonly trailing: AppIntent | null
    /** Further header actions a v2 document chose (labels visible; the first also fills `trailing` for compat). */
    readonly actions?: readonly { readonly label: string; readonly intent: AppIntent }[]
}

export type FrameAction = {
    readonly label: string
    readonly compactLabel?: string
    readonly icon: ScreenIcon | null
    readonly intent: AppIntent
}

export type FrameBar = {
    /** Exactly one primary. Validation rejects a document without one; the bar never unmounts it when busy. */
    readonly primary: FrameAction
    readonly secondary: FrameAction | null
}

export type FrameVariantBody = {
    readonly body: readonly FrameNode[]
    /** When present, this variant owns its bar too (busy/blocked/reading/confirming included). */
    readonly bar?: FrameBar
}

export type FrameDocument = {
    readonly kind: FrameKind
    readonly source: 'generated' | 'fallback'
    readonly bound: {
        readonly manualId: string | null
        readonly revision: number | null
        readonly stepId: string | null
        readonly captureId: string | null
    }
    readonly header: FrameHeader
    readonly body: readonly FrameNode[]
    readonly bar: FrameBar
    /** State compositions authored in-document. The selected variant replaces body (and bar when it carries one). */
    readonly variants?: Partial<Record<FrameVariant, FrameVariantBody>>
    /** Server-owned per-path origins (`header`, `body.<i>…`, `bar.primary`); absent means whole-document `source`. */
    readonly origins?: Readonly<Record<string, RenderOrigin>>
    readonly sources?: readonly ScreenDocumentSource[]
    /** Published facts (v1 or v2 tables share factId/kind/basis/text/sourceRefs; kinds stay strings at this boundary). */
    readonly manualFacts?: readonly (PublishedManualFact | FrameFact)[]
    /** Fact identities every rendering of this document must witness (safety/citation/action). Omission rejects. */
    readonly requiredFactIds?: readonly string[]
}

/** One published fact at the frame boundary (v2 kinds are wider than the v1 manual-fact kinds). */
export type FrameFact = {
    readonly factId: string
    readonly kind: string
    readonly basis: string
    readonly text: string
    readonly sourceRefs: readonly ScreenDocumentSource[]
    readonly placement: 'body' | 'remainder'
}

/** Runtime bindings: dynamic props/state bound to the existing controller. No arbitrary actions, URLs, styles or code. */
export type FrameBindings = {
    /** A comparison may inspect local evidence but must never mutate workflow/device state. */
    readonly readOnly?: boolean
    readonly resolve: (intent: AppIntent) => ResolvedIntent
    readonly live: LiveScreen | null
    readonly session: ManualSession | undefined
    readonly pageUris: Readonly<Record<string, string>>
    /** Terminal asset loading is distinct from a still-pending native image. */
    readonly pageImageStatus?: 'pending' | 'ready' | 'unavailable'
    /** Close all owning sheets before a judge capability changes the native route. */
    readonly closeOverlays?: () => void
    readonly capture: CaptureView | null
    readonly marks: readonly SegmentMark[]
    readonly heroMode: 'flush' | 'inset' | 'inline'
    readonly heroTestID?: string
    readonly heroRootTestID?: string
    readonly inspect: boolean
    /** Stable test identities a route already owns for its bar actions (automation and coach keep finding them). */
    readonly testIds?: { readonly primary?: string; readonly secondary?: string }
    /** Judge layer, device-only and default off. The renderer shows one summary card; details stay behind one tap. */
    readonly judge?: {
        readonly summary: string
        readonly onShowDetails: () => void
    } | null
    /** Coach candidates are suppressed while work owns attention; copy/order still come from the document. */
    readonly workInProgress?: boolean
    /** Live resolution of v2 bound text and toggles, from controller state. Absent means the control shows its label only. */
    readonly resolveText?: (ref: TextRefV2) => string
    readonly toggles?: Readonly<
        Partial<Record<string, { readonly value: boolean; readonly onChange: (value: boolean) => void }>>
    >
    /** Real camera mechanics, placed by a CameraView node; the document bar is the sole shutter. */
    readonly camera?: {
        readonly preview: ReactNode
        readonly capture: () => void
        readonly ready: boolean
        readonly permission: 'granted' | 'undetermined' | 'denied'
        readonly failed?: boolean
        readonly canAskAgain?: boolean | null
        readonly requestPermission?: () => void
        readonly openSettings?: () => void
        readonly retry?: () => void
    }
    readonly compare?: ReactNode
    readonly resultDocument?: ScreenDocumentV2 | null
    readonly resultArrivedAt?: number | null
    readonly insetTop?: number
    readonly operationNotice?: string | null
    readonly answeredQuestion?: string | null
    readonly language?: { readonly value: string; readonly onChange: (value: string) => void }
}

export function isLayoutNode(node: FrameNode): node is FrameLayoutNode {
    return (
        node.type === 'Stack' ||
        node.type === 'Row' ||
        node.type === 'Grid' ||
        node.type === 'Card' ||
        node.type === 'Section' ||
        node.type === 'Divider' ||
        node.type === 'Spacer' ||
        node.type === 'Scroll'
    )
}

/** Depth-first document order, which is also VoiceOver/TalkBack order. Layout wrappers do not reorder children. */
export function flattenFrameNodes(nodes: readonly FrameNode[]): readonly (FrameLeafNode | FrameV2Leaf)[] {
    const leaves: (FrameLeafNode | FrameV2Leaf)[] = []
    const visit = (node: FrameNode): void => {
        if (isLayoutNode(node)) {
            if ('children' in node) node.children.forEach(visit)
            return
        }
        // v1 containers hold leaves only; treat them as leaves here (the adapter widens them to Stack/Section).
        leaves.push(node)
    }
    nodes.forEach(visit)
    return leaves
}
