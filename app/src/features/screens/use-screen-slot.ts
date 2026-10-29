import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useIsFocused } from 'expo-router'
import type { CheckResult, ScreenDocument, ScreenKind } from '@truebuild/contracts'
import type { CaptureView, CheckStages, SegmentMark, WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import type { MoreControl, MoreMode } from '../capture/screen-header'
import type { ScreenNav } from '../capture/screen-nav'
import { useWorkflow } from '../capture/workflow-context'
import type { WorkflowController } from '../capture/workflow-types'
import type { BlockContext } from './blocks'
import { guardDocument, type GuardedScreen, type ScreenFacts } from './documents'
import { useJudge } from './judge-context'
import { barTestId } from './bar-ids'
import { resolveIntent, type IntentExtras } from './intents'
import type { LiveScreen } from './live'
import { hashText, specKey, type ScreenSpec } from './screen-spec'
import type { BarAction } from '../../ui/bottom-bar'
import { originId, type RenderOrigin } from './render-origin'

/** How long a screen waits for its document before the native screen is shown instead (and the late document is kept for next time). */
export const PENDING_GRACE_MS = 8_000

export type GeneratedScreen = {
    readonly document: ScreenDocument
    readonly origin: 'generated' | 'fallback'
    readonly guarded: GuardedScreen
    readonly context: BlockContext
    readonly title: string
    /** Server-owned origin of the header component, for the one place the title is drawn by the app. */
    readonly headerOrigin: RenderOrigin
    readonly subtitle: string | null
    /** The header's trailing control as the document composed it, resolved against the app now; null when it chose none. */
    readonly trailing: {
        readonly label: string
        readonly nativeID: string
        readonly enabled: boolean
        readonly run: () => void
    } | null
    /** The bar as the document composed it; the host decides which native states still override it. */
    readonly bar: { readonly primary: BarAction; readonly secondary: BarAction | undefined }
    /** Why the composed primary is not available now, in plain words; null when it is. */
    readonly barReason: string | null
    readonly tips: ReadonlyMap<string, { readonly heading: string; readonly text: string }>
    /** What the judge layer reads about the same photo: the verdict held and the background stages after it. */
    readonly check: CheckResult | null
    readonly stages: CheckStages | null | undefined
}

/** `pending`: show the calm skeleton. `ready`: render the document. `undefined` (no slot): the native screen. */
export type NativeReason = 'slow' | 'failed' | 'rejected'
export type ScreenSlot =
    | { readonly status: 'pending'; readonly key: string; readonly kind: ScreenKind }
    | { readonly status: 'ready'; readonly key: string; readonly kind: ScreenKind; readonly screen: GeneratedScreen }
    /** Generation was requested but the native screen is the one shown; `reason` is for the judge layer only. */
    | {
          readonly status: 'native'
          readonly key: string
          readonly kind: ScreenKind
          readonly reason: NativeReason
          readonly code: string | null
      }

function compact(label: string): string {
    return label.split(' ')[0] ?? label
}

export type SlotInputs = {
    readonly kind: ScreenKind
    /** Null means this screen is native right now (no request, no skeleton). */
    readonly spec: ScreenSpec | null
    readonly facts: ScreenFacts
    readonly state: WorkflowState
    readonly entry: LibraryEntry | undefined
    readonly controller: WorkflowController
    readonly nav: ScreenNav
    readonly extras: IntentExtras
    /** How a HeroFigure sits on this screen (see BlockContext.heroMode). */
    readonly heroMode: BlockContext['heroMode']
    readonly heroTestID?: string
    readonly heroRootTestID?: string
    readonly more: MoreControl
    /** What a composed block reads from the screen it sits on. */
    readonly live?: Partial<Pick<LiveScreen, 'quick' | 'pages' | 'heroCapture' | 'ask' | 'closeSheet'>>
    /** `skeleton` for screens that have nothing to show yet; `native` for screens whose verdict or answer is already on screen. */
    readonly whilePending: 'skeleton' | 'native'
    readonly capture?: CaptureView | null
    readonly marks?: readonly SegmentMark[]
    /** A read-only view (the judge comparison): every action is shown but none can run. */
    readonly readOnly?: boolean
    /** False when this slot only borrows a document's words (the camera): it is not counted as a screen shown. */
    readonly counted?: boolean
}

/**
 * Turns the store's entry for this exact screen into what the host draws. Everything is derived from the current app
 * facts at render time. A document that fails the client's own guardrails, a failed call, a mode that does not
 * generate this kind, or a grace period that ran out all yield no slot, so the native screen is shown unchanged.
 */
export function useScreenSlot(inputs: SlotInputs): ScreenSlot | undefined {
    const { screens } = useWorkflow()
    const judge = useJudge()
    const { spec, kind } = inputs
    useSyncExternalStore(
        screens?.subscribe ?? ((): (() => void) => (): void => undefined),
        screens?.getVersion ?? ((): number => 0),
        screens?.getVersion ?? ((): number => 0),
    )
    const enabled = screens !== null && spec !== null && screens.enabled(kind)
    const key = spec === null ? null : specKey(spec)
    const [gaveUp, setGaveUp] = useState<string | null>(null)
    // Coming back to a screen is the next visit: a document that arrived late is used then, not swapped in under a hand.
    const focused = useIsFocused()
    useEffect(() => {
        if (!focused) setGaveUp(null)
    }, [focused])
    const entry = enabled && screens !== null && spec !== null ? screens.peek(spec) : undefined
    useEffect(() => {
        if (!enabled || screens === null || spec === null) return
        screens.request(spec)
    }, [enabled, key])
    const waiting = enabled && (entry === undefined || entry.status === 'pending')
    useEffect(() => {
        if (!focused || !waiting || key === null) return undefined
        const timer = setTimeout((): void => setGaveUp(key), PENDING_GRACE_MS)
        return (): void => clearTimeout(timer)
    }, [waiting, key, focused])
    const refresh = useCallback((): void => {
        if (screens !== null && spec !== null) {
            screens.retry(spec)
            screens.request(spec)
        }
    }, [screens, spec])
    const document = entry?.status === 'ready' ? entry.document : null
    const factsKey = JSON.stringify(inputs.facts)
    const guarded = useMemo(
        () => (document === null ? null : guardDocument(document, inputs.facts)),
        [document, factsKey],
    )
    useEffect(() => {
        if (enabled && focused && gaveUp !== key && screens !== null && guarded !== null && inputs.counted !== false) {
            const { bound } = guarded.document
            // A step's own guide page, composed with no photo held, is what a later check may name as the shown page.
            const guide =
                kind === 'guide' &&
                bound.manualId !== null &&
                bound.revision !== null &&
                bound.stepId !== null &&
                (spec?.uiState?.capture ?? null) === null &&
                spec?.result === null
                    ? {
                          manualId: bound.manualId,
                          revision: bound.revision,
                          stepId: bound.stepId,
                          contextKey: bound.contextKey,
                      }
                    : undefined
            screens.noteShown({
                kind,
                screenId: guarded.document.screenId,
                source: guarded.document.metadata.source,
                ...(guide === undefined ? {} : { guide }),
            })
        }
    }, [screens, guarded, kind, enabled, focused, gaveUp, key, inputs.counted])
    if (!enabled || key === null) return undefined
    // The grace period ended while the native screen was showing; a late document waits for the next visit.
    if (gaveUp === key && (entry === undefined || entry.status === 'pending' || entry.status === 'ready')) {
        return { status: 'native', key, kind, reason: 'slow', code: null }
    }
    if (entry === undefined || entry.status === 'pending') {
        return inputs.whilePending === 'skeleton' ? { status: 'pending', key, kind } : undefined
    }
    if (entry.status === 'failed') return { status: 'native', key, kind, reason: 'failed', code: entry.code }
    if (guarded === null) return { status: 'native', key, kind, reason: 'rejected', code: null }
    return { status: 'ready', key, kind, screen: buildScreen(guarded, inputs, judge.showBuilt, refresh) }
}

function buildScreen(
    guarded: GuardedScreen,
    inputs: SlotInputs,
    inspect: boolean,
    refresh: () => void,
): GeneratedScreen {
    const { document, origin } = guarded
    const host = {
        kind: inputs.kind,
        state: inputs.state,
        entry: inputs.entry,
        controller: inputs.controller,
        nav: inputs.nav,
        extras: { ...inputs.extras, refresh },
    }
    const resolve = (intent: Parameters<typeof resolveIntent>[0]): ReturnType<typeof resolveIntent> =>
        inputs.readOnly === true
            ? { enabled: false, reason: 'This is a read-only comparison.', run: (): void => undefined }
            : resolveIntent(intent, host)
    const action = (
        node: ScreenDocument['bar']['primary'] | NonNullable<ScreenDocument['bar']['secondary']>,
        path: 'bar.primary' | 'bar.secondary',
    ): BarAction => {
        const resolved = resolve(node.intent)
        const testID = barTestId(inputs.kind, path === 'bar.primary' ? 'primary' : 'secondary', node.intent)
        return {
            label: node.label,
            ...(testID === undefined ? {} : { testID }),
            compactLabel: compact(node.label),
            ...(node.icon === null ? {} : { icon: node.icon }),
            disabled: !resolved.enabled,
            onPress: resolved.run,
            nativeID: originId(document.metadata.origins?.[path] ?? origin),
            ...(resolved.reason === null ? {} : { accessibilityLabel: node.label }),
        }
    }
    const originOf = (path: string): RenderOrigin => document.metadata.origins?.[path] ?? origin
    const tips = new Map<string, { heading: string; text: string }>()
    for (const node of guarded.body) {
        if (node.type === 'Tip' && !tips.has(node.targetId))
            tips.set(node.targetId, { heading: node.heading, text: node.text })
    }
    return {
        document,
        origin,
        guarded,
        context: {
            origin,
            synthetic: document.metadata.evidence === 'synthetic-fixture',
            originOf,
            session: inputs.entry?.session,
            pageUris: inputs.state.pageUris,
            capture: inputs.capture ?? inputs.state.capture,
            marks: inputs.marks ?? [],
            sources: document.sources ?? [],
            manualFacts: document.manualFacts ?? [],
            live: {
                state: inputs.state,
                entry: inputs.entry,
                controller: inputs.controller,
                nav: inputs.nav,
                more: inputs.more,
                ...inputs.live,
            },
            heroMode: inputs.heroMode,
            ...(inputs.heroTestID === undefined ? {} : { heroTestID: inputs.heroTestID }),
            ...(inputs.heroRootTestID === undefined ? {} : { heroRootTestID: inputs.heroRootTestID }),
            resolve,
            inspect,
        },
        title: document.header.title,
        headerOrigin: originOf('header'),
        subtitle: document.header.subtitle,
        trailing: ((): GeneratedScreen['trailing'] => {
            const intent = document.header.trailing
            // The header's one trailing control is More. A document may word it as More or details; any other intent
            // would put the wrong name on the More icon, so the native control stays.
            if (
                intent === null ||
                !(intent.intent === 'open-details' || (intent.intent === 'navigate' && intent.target === 'more'))
            ) {
                return null
            }
            const resolved = resolve(intent)
            return {
                label: 'More',
                nativeID: originId(originOf('header')),
                enabled: resolved.enabled,
                run: resolved.run,
            }
        })(),
        barReason: resolve(document.bar.primary.intent).reason,
        bar: {
            primary: action(document.bar.primary, 'bar.primary'),
            secondary: document.bar.secondary === null ? undefined : action(document.bar.secondary, 'bar.secondary'),
        },
        tips,
        check: inputs.state.check,
        stages: inputs.state.stages,
    }
}

export type { MoreMode }

/**
 * Starts the documents for screens this one is likely to lead to. It uses the store's own request path, so a screen
 * asked for twice shares one call, a changed revision, page set, step or photo is a different key, and nothing here
 * changes how the destination waits or falls back. A warm-up that fails is forgotten at once: it must never leave a
 * final failure for a destination to inherit that the destination would not have had on its own.
 */
export function useWarmUp(specs: readonly ScreenSpec[]): void {
    const { screens } = useWorkflow()
    const focused = useIsFocused()
    const version = useSyncExternalStore(
        screens?.subscribe ?? ((): (() => void) => (): void => undefined),
        screens?.getVersion ?? ((): number => 0),
        screens?.getVersion ?? ((): number => 0),
    )
    const keys = specs.map((spec) => hashText(specKey(spec))).join('|')
    useEffect(() => {
        if (screens === null || !focused) return
        for (const spec of specs) if (screens.enabled(spec.kind)) screens.request(spec)
        // The specs are fully described by `keys`.
    }, [screens, focused, keys])
    useEffect(() => {
        if (screens === null || !focused) return
        for (const spec of specs) if (screens.peek(spec)?.status === 'failed') screens.retry(spec)
    }, [screens, version, keys, focused])
}
