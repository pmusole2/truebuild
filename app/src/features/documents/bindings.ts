import type { BarAction } from '../../ui/bottom-bar'
import type { ScreenKind } from '@truebuild/contracts'
import { barTestId } from '../screens/bar-ids'
import { heroResolves } from '../screens/blocks'
import type { GeneratedScreen } from '../screens/use-screen-slot'
import { adaptScreenDocument, widenFrameNode } from './adapt'
import type { FrameBindings, FrameDocument, FrameNode } from './types'

/** Legacy v1/demo frame helpers. Production routes use document-surface.tsx and the actual v2 document runtime. */

export function bindingsFromGenerated(
    screen: GeneratedScreen,
    livePatch?: Partial<NonNullable<FrameBindings['live']>>,
): FrameBindings {
    const context = screen.context
    return {
        resolve: context.resolve,
        live: context.live === null || livePatch === undefined ? context.live : { ...context.live, ...livePatch },
        session: context.session,
        pageUris: context.pageUris,
        capture: context.capture,
        marks: context.marks,
        heroMode: context.heroMode,
        ...(context.heroTestID === undefined ? {} : { heroTestID: context.heroTestID }),
        ...(context.heroRootTestID === undefined ? {} : { heroRootTestID: context.heroRootTestID }),
        inspect: context.inspect,
        judge: null,
    }
}

export type GeneratedFrames = {
    readonly frame: FrameDocument
    /** The document's first node as its own frame, only when the document placed a resolvable HeroFigure first. */
    readonly hero: FrameDocument | null
    readonly heroPaths: readonly string[]
    readonly rest: FrameDocument
    readonly restPaths: readonly string[]
}

/** Splits a composed screen into hero/rest frames exactly where the document placed them — never reordered. */
export function framesFromGenerated(screen: GeneratedScreen): GeneratedFrames {
    const frame = {
        ...adaptScreenDocument(screen.document),
        body: screen.guarded.body.map(widenFrameNode),
    }
    const first = screen.guarded.body[0]
    if (first?.type === 'HeroFigure' && heroResolves(first, screen.context)) {
        return {
            frame,
            hero: { ...frame, body: [frame.body[0]!] },
            heroPaths: [screen.guarded.paths[0] ?? 'body.0'],
            rest: { ...frame, body: frame.body.slice(1) },
            restPaths: screen.guarded.paths.slice(1),
        }
    }
    return { frame, hero: null, heroPaths: [], rest: frame, restPaths: screen.guarded.paths }
}

/**
 * Splits a frame into its hero (the first leaf, when it is a HeroFigure) and the rest, wherever the document
 * nested it (a root Stack is common). Explicit document placement only — nothing is reordered.
 */
function removeFirstHero(node: FrameNode): { hero: FrameNode | null; rest: FrameNode } {
    if (node.type === 'HeroFigure') return { hero: node, rest: node }
    if ('children' in node && Array.isArray(node.children) && node.children.length > 0) {
        const inner = removeFirstHero(node.children[0]!)
        if (inner.hero === null) return { hero: null, rest: node }
        const children =
            inner.rest === node.children[0] ? node.children.slice(1) : [inner.rest, ...node.children.slice(1)]
        return { hero: inner.hero, rest: { ...node, children } as FrameNode }
    }
    return { hero: null, rest: node }
}

export function splitHeroFrame(frame: FrameDocument): { hero: FrameDocument | null; rest: FrameDocument } {
    const firstTop = frame.body[0]
    if (firstTop === undefined) return { hero: null, rest: frame }
    const { hero, rest } = removeFirstHero(firstTop)
    if (hero === null) return { hero: null, rest: frame }
    const restBody = rest === firstTop ? frame.body.slice(1) : [rest, ...frame.body.slice(1)]
    return { hero: { ...frame, body: [hero] }, rest: { ...frame, body: restBody } }
}

/**
 * The bar a composed screen shows: the document's words, icon and intent, resolved live, keeping the native
 * action's stable test identity when the document's intent has none of its own on this screen.
 */
export function barFromGenerated(
    screen: GeneratedScreen,
    native: { readonly primary: BarAction | null; readonly secondary?: BarAction },
): { readonly primary: BarAction | null; readonly secondary?: BarAction } {
    const { primary, secondary } = screen.bar
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

/** The bar for any frame document (composed or local fallback), resolved through the route's bindings. */
export function barFromFrame(
    frame: FrameDocument,
    bindings: FrameBindings,
): { readonly primary: BarAction | null; readonly secondary?: BarAction; readonly reason: string | null } {
    const toAction = (action: FrameDocument['bar']['primary'], role: 'primary' | 'secondary'): BarAction => {
        const resolved = bindings.resolve(action.intent)
        const owned = role === 'primary' ? bindings.testIds?.primary : bindings.testIds?.secondary
        const derived = ['camera', 'judge', 'compare'].includes(frame.kind)
            ? undefined
            : barTestId(frame.kind as ScreenKind, role, action.intent)
        return {
            label: action.label,
            ...(action.compactLabel === undefined ? {} : { compactLabel: action.compactLabel }),
            ...(action.icon === null ? {} : { icon: action.icon }),
            ...((owned ?? derived) === undefined ? {} : { testID: (owned ?? derived)! }),
            disabled: !resolved.enabled,
            onPress: resolved.run,
            accessibilityLabel: action.label,
        }
    }
    const primary = toAction(frame.bar.primary, 'primary')
    return {
        primary,
        ...(frame.bar.secondary === null ? {} : { secondary: toAction(frame.bar.secondary, 'secondary') }),
        reason: bindings.resolve(frame.bar.primary.intent).reason,
    }
}
