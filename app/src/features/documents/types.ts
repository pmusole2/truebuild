import type { ReactNode } from 'react'
import type { AppIntent, ManualSession, ScreenDocumentV2, TextRefV2 } from '@truebuild/contracts'
import type { CaptureView, SegmentMark } from '../capture/controller'
import type { ResolvedIntent } from '../screens/intents'
import type { LiveScreen } from '../screens/live'

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
