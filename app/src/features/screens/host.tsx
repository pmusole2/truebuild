import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import type { ScreenNode } from '@truebuild/contracts'
import type { CameraWording } from '../capture/camera-stage'
import type { CoachCandidate } from '../onboarding/coach-types'
import type { BarAction } from '../../ui/bottom-bar'
import { useContentFade } from '../../ui/motion'
import { SkeletonCard } from '../../ui/skeleton'
import { Caption } from '../../ui/text'
import { HeaderTitle } from '../capture/screen-header'
import { space } from '../../theme/tokens'
import { AttributionCard } from './attribution'
import { heroResolves, ScreenBlocks } from './blocks'
import { useJudge } from './judge-context'
import { originId } from './render-origin'
import type { LiveScreen } from './live'
import type { GeneratedScreen, ScreenSlot } from './use-screen-slot'

/** Copy shown while a screen is being composed. */
export const PENDING_COPY = 'Getting the next steps ready…'

/** A calm placeholder; it never moves (skeletons are static) and announces once. */
export function ScreenPending(): ReactElement {
    return (
        <View
            testID="screen-pending"
            accessibilityLiveRegion="polite"
            accessible
            accessibilityLabel={PENDING_COPY}
            style={styles.pending}
        >
            <SkeletonCard />
            <Caption>{PENDING_COPY}</Caption>
        </View>
    )
}

/** The pinned hero of a composed screen: the document's first block, when that block is a HeroFigure. */
export function splitHero(screen: GeneratedScreen): {
    readonly hero: { readonly nodes: readonly ScreenNode[]; readonly paths: readonly string[] } | null
    readonly rest: { readonly nodes: readonly ScreenNode[]; readonly paths: readonly string[] }
} {
    const { body, paths } = screen.guarded
    const first = body[0]
    // A hero whose figure cannot be drawn is not pinned: the screen keeps no empty picture frame for it.
    if (first?.type === 'HeroFigure' && heroResolves(first, screen.context)) {
        return {
            hero: { nodes: [first], paths: [paths[0] ?? 'body.0'] },
            rest: { nodes: body.slice(1), paths: paths.slice(1) },
        }
    }
    return { hero: null, rest: { nodes: body, paths } }
}

/** True when the composed document puts a HeroFigure first: the host then pins it instead of drawing its own picture. */
export function hasPinnedHero(slot: ScreenSlot | undefined): slot is Extract<ScreenSlot, { status: 'ready' }> {
    return slot?.status === 'ready' && splitHero(slot.screen).hero !== null
}

/** The document's pinned hero, drawn by its own HeroFigure block (source, region, fit and position are the document's). */
export function ComposedHero({
    screen,
    live,
}: {
    readonly screen: GeneratedScreen
    readonly live?: LiveOverride
}): ReactElement | null {
    const { hero } = splitHero(screen)
    return hero === null ? null : (
        <ScreenBlocks nodes={hero.nodes} paths={hero.paths} context={withLive(screen.context, live)} />
    )
}

/** What the host that draws the blocks adds to the live facts (its own sheet opener, its photo drawing). */
export type LiveOverride = Partial<Pick<LiveScreen, 'pages' | 'heroCapture' | 'ask' | 'closeSheet'>>

function withLive(context: GeneratedScreen['context'], live: LiveOverride | undefined): GeneratedScreen['context'] {
    return live === undefined || context.live === null ? context : { ...context, live: { ...context.live, ...live } }
}

/**
 * The document's body in the host's scrolling region, in the document's order. It crossfades in once per document (the
 * one fast fade; none under reduced motion or while a sheet or tip owns attention, via `enabled`). With `pinned` the
 * first block, when it is a HeroFigure, is drawn by the host's pinned slot (see `ComposedHero`) and not repeated here.
 */
export function GeneratedBody({
    screen,
    enabled = true,
    pinned = false,
    live,
}: {
    readonly screen: GeneratedScreen
    readonly enabled?: boolean
    readonly pinned?: boolean
    readonly live?: LiveOverride
}): ReactElement {
    const fade = useContentFade(screen.document.screenId, enabled)
    const { showBuilt } = useJudge()
    const { rest } = pinned ? splitHero(screen) : { rest: { nodes: screen.guarded.body, paths: screen.guarded.paths } }
    return (
        <Animated.View testID="generated-body" style={[styles.body, fade]}>
            {showBuilt ? <AttributionCard screen={screen} /> : null}
            <ScreenBlocks nodes={rest.nodes} paths={rest.paths} context={withLive(screen.context, live)} />
        </Animated.View>
    )
}

/**
 * The native header's title as the document wrote it. Without a subtitle the route keeps its plain title option; with
 * one, the header draws the two lines from the document and marks them with the header's server-owned origin.
 */
export function headerFor(
    slot: ScreenSlot | undefined,
    fallback: string,
): { readonly title: string; readonly headerTitle?: () => ReactElement } {
    if (slot?.status !== 'ready') return { title: fallback }
    const { title, subtitle, headerOrigin } = slot.screen
    if (subtitle === null) return { title }
    return {
        title,
        headerTitle: (): ReactElement => (
            <HeaderTitle title={title} subtitle={subtitle} nativeID={originId(headerOrigin)} />
        ),
    }
}

export type NativeBar = { readonly primary: BarAction | null; readonly secondary?: BarAction }

/**
 * The bar when a document composed it. The document owns each action's words, icon and what it does; the screen keeps
 * the stable test identities of its own actions, so coach targets and automation still find them. A native action that
 * is the only honest one right now (busy, read-only) is passed as `override` and wins.
 */
export function composeBar(native: NativeBar, slot: ScreenSlot | undefined, override = false): NativeBar {
    if (slot?.status !== 'ready' || override) return native
    const { primary, secondary } = slot.screen.bar
    // The action keeps the identity its intent has on this screen; one with none keeps the native action's.
    return {
        primary: {
            ...primary,
            ...(primary.testID === undefined && native.primary?.testID !== undefined
                ? { testID: native.primary.testID }
                : {}),
        },
        ...(secondary === undefined
            ? {}
            : {
                  secondary: {
                      ...secondary,
                      ...(secondary.testID === undefined && native.secondary?.testID !== undefined
                          ? { testID: native.secondary.testID }
                          : {}),
                  },
              }),
    }
}

/**
 * Coach copy and order from the document. A tip the document wrote replaces the wording of the native tip with the same
 * target and moves it first, in the document's order; tips the document did not write keep their native wording after
 * them. Suppression and the per-screen cap stay with the coach, which receives candidates only.
 */
export function applyTips(
    candidates: readonly CoachCandidate[],
    slot: ScreenSlot | undefined,
): readonly CoachCandidate[] {
    return applyWrittenTips(candidates, slot?.status === 'ready' ? slot.screen.tips : undefined)
}

/** The same rule for tips already read from a document (the camera reads them from the step's guide). */
export function applyWrittenTips(
    candidates: readonly CoachCandidate[],
    tips: ReadonlyMap<string, { readonly heading: string; readonly text: string }> | undefined,
): readonly CoachCandidate[] {
    if (tips === undefined || tips.size === 0) return candidates
    const written: CoachCandidate[] = []
    for (const [targetId, tip] of tips) {
        const native = candidates.find((candidate) => candidate.id === targetId)
        if (native !== undefined) written.push({ ...native, heading: tip.heading, sentence: tip.text })
    }
    return [...written, ...candidates.filter((candidate) => !tips.has(candidate.id))]
}

/**
 * What the step's composed guide says to the camera: its first CameraGuidance block (cue and pill) and its tips. The
 * words replace the camera's own; every mechanism stays the camera's. Nothing for a screen that is not ready.
 */
export function cameraWordingOf(slot: ScreenSlot | undefined): CameraWording | undefined {
    if (slot?.status !== 'ready') return undefined
    const { guarded, context, tips } = slot.screen
    const index = guarded.body.findIndex((node) => node.type === 'CameraGuidance')
    const node = guarded.body[index]
    const written = node?.type === 'CameraGuidance' ? node : undefined
    if (written === undefined && tips.size === 0) return undefined
    const nativeID = originId(context.originOf(guarded.paths[index] ?? `body.${index}`))
    return {
        cue: written === undefined ? null : { text: written.cue, nativeID },
        pill: written?.pill == null ? null : { text: written.pill, nativeID },
        tips,
    }
}

const styles = StyleSheet.create({
    pending: { gap: space.sm },
    body: { gap: space.sm },
})

/** The More sheet's composed intro; nothing at all until the document has arrived. */
export function MoreIntro({ slot }: { readonly slot: ScreenSlot | undefined }): ReactElement | null {
    return slot?.status === 'ready' ? <GeneratedBody screen={slot.screen} /> : null
}
