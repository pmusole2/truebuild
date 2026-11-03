import { Fragment, useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import type {
    AppIntent,
    ManualSession,
    PublishedManualFact,
    ScreenDocumentSource,
    ScreenNode,
} from '@truebuild/contracts'
import { SegmentMasks, GroundedRegionOutline } from '../assembly/grounded-overlays'
import { boxOnDisplay } from '../assembly/frame-geometry'
import { FrozenPhoto } from '../assembly/frozen-photo'
import type { CaptureView, SegmentMark } from '../capture/controller'
import { useHeroHeight, useKeyboardVisible } from '../capture/screen-layout'
import { StepPicture } from '../capture/step-picture'
import { AppButton } from '../../ui/button'
import { useFeedback } from '../../ui/feedback'
import { useCoachAttention, useCoachScope } from '../onboarding/coach-provider'
import { Icon } from '../../ui/icons'
import { ProgressBar } from '../../ui/progress'
import { BlueprintLoader, type BlueprintPhase } from '../../ui/blueprint-loader'
import { Notice, StatusTag, VerdictTag } from '../../ui/status'
import { Card } from '../../ui/surface'
import { Body, Caption, Heading, Instruction } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import {
    ActionLinkBlock,
    FactEditorBlock,
    FactPromptBlock,
    ManualLibraryBlock,
    PageGalleryBlock,
    QuestionComposerBlock,
    SourceDetailsBlock,
} from './blocks-live'
import { DirectionsBlock, TextFactSources } from './mandatory'
import type { ResolvedIntent } from './intents'
import type { LiveScreen } from './live'
import { partSourceRefs } from './part-source'
import { originId, RenderOriginProvider, type RenderOrigin } from './render-origin'

export type BlockContext = {
    readonly readOnly?: boolean
    /** Server-owned origin of the component at a document path (`body.2`, `body.0.children.1`); never chosen by the model. */
    readonly originOf: (path: string) => RenderOrigin
    /** Whole-document origin, for words used in the judge layer. */
    readonly origin: 'generated' | 'fallback'
    readonly synthetic?: boolean
    readonly session: ManualSession | undefined
    readonly pageUris: Readonly<Record<string, string>>
    readonly capture: CaptureView | null
    /** SAM masks for the current capture; drawn on a photo block only. */
    readonly marks: readonly SegmentMark[]
    /** The document's own sources (page + manual figure region) that block citations index. */
    readonly sources: readonly ScreenDocumentSource[]
    /** Complete manual facts the server published with the document, by identity. */
    readonly manualFacts: readonly PublishedManualFact[]
    /** Complete instructions already visible in this body, so a direction need not repeat the same sentence. */
    readonly visibleInstructions?: ReadonlySet<string>
    /** The live app facts composed blocks bind to (library, pages, the current question, the held photo). */
    readonly live: LiveScreen | null
    /**
     * How a HeroFigure sits. `flush`: the screen's pinned hero, edge to edge (Guide). `inset`: pinned with the screen's
     * margins (Quick check, Reading, Done). `inline`: an ordinary block in a scrolling list.
     */
    readonly heroMode: 'flush' | 'inset' | 'inline'
    /** Test identity of the manual picture, so each route keeps the identity automation already uses. */
    readonly heroTestID?: string
    /** Test identity of the hero's root, for a route whose automation targets the frame. */
    readonly heroRootTestID?: string
    readonly resolve: (intent: AppIntent) => ResolvedIntent
    /** Judge layer: tapping a block names its type and origin. Off by default; off adds nothing to the tree. */
    readonly inspect: boolean
}

type Leaf = Exclude<ScreenNode, { type: 'Group' | 'DetailsDisclosure' }>

function Choice({
    label,
    intent,
    context,
    path,
    variant,
}: {
    label: string
    intent: AppIntent
    context: BlockContext
    path: string
    variant: 'secondary' | 'quiet' | 'accent'
}): ReactElement {
    const resolved = context.resolve(intent)
    return (
        <AppButton
            nativeID={originId(context.originOf(path))}
            label={label}
            variant={variant}
            disabled={!resolved.enabled}
            hint={resolved.reason ?? undefined}
            onPress={resolved.run}
        />
    )
}

function PhotoBlock({
    node,
    context,
    path,
}: {
    node: Extract<Leaf, { type: 'PhotoWithRegions' }>
    context: BlockContext
    path: string
}): ReactElement | null {
    const { reduceMotion } = useFeedback()
    const capture = context.capture
    // A photo block names one capture. Another capture's photo is never drawn under it.
    if (capture === null || capture.binding.captureId !== node.captureId) return null
    const marked = context.marks.some((mark) => mark.mask !== undefined)
    return (
        <View nativeID={originId(context.originOf(path))}>
            <FrozenPhoto
                observation={capture.observation}
                caption="Your photo for this step."
                overlay={(displayed): ReactElement => (
                    <>
                        <GroundedRegionOutline
                            rect={node.observed === null ? null : boxOnDisplay(node.observed, displayed)}
                        />
                        {node.regions.map((region) => (
                            <GroundedRegionOutline
                                key={`${region.partId}:${region.role}`}
                                rect={boxOnDisplay(region.box, displayed)}
                            />
                        ))}
                        {marked ? (
                            <SegmentMasks marks={context.marks} displayed={displayed} reduceMotion={reduceMotion} />
                        ) : null}
                    </>
                )}
            />
        </View>
    )
}

/**
 * True when a HeroFigure names a figure this device can really draw: its capture is the held one, its page is the
 * manual's, or its part has a cited figure. The block renders nothing for one that does not.
 */
export function heroResolves(node: Extract<ScreenNode, { type: 'HeroFigure' }>, context: BlockContext): boolean {
    const session = context.session
    if (node.source === 'capture') return context.capture?.binding.captureId === node.refId
    if (session === undefined) return node.source === 'page'
    if (node.source === 'page') return session.pages.some((page) => page.pageId === node.refId)
    return partSourceRefs(session, node.refId, context.live?.entry?.stepIndex).length > 0
}

function Hero({
    node,
    context,
    path,
}: {
    node: Extract<Leaf, { type: 'HeroFigure' }>
    context: BlockContext
    path: string
}): ReactElement | null {
    const height = useHeroHeight(useKeyboardVisible())
    const mark = originId(context.originOf(path))
    const flush = context.heroMode === 'flush'
    const inset = context.heroMode === 'inset'
    const caption = node.caption === null ? null : <Caption>{node.caption}</Caption>
    if (node.source === 'capture') {
        const capture = context.capture
        if (capture === null || capture.binding.captureId !== node.refId) return null
        const drawn = context.live?.heroCapture?.(height)
        return (
            <View
                nativeID={mark}
                testID={context.heroRootTestID ?? 'generated-hero'}
                style={[{ height }, inset && styles.inset]}
            >
                {drawn ?? (
                    <FrozenPhoto
                        observation={capture.observation}
                        caption={node.caption ?? 'Your photo.'}
                        fillHeight={height}
                        flush={flush}
                    />
                )}
            </View>
        )
    }
    if (node.source === 'page' && context.session !== undefined) {
        if (!context.session.pages.some((page) => page.pageId === node.refId)) return null
        return (
            <View
                nativeID={mark}
                testID={context.heroRootTestID ?? 'generated-hero'}
                style={[{ height }, inset && styles.inset]}
            >
                <StepPicture
                    reference={{ pageId: node.refId, region: node.region ?? null }}
                    session={context.session}
                    pageUris={context.pageUris}
                    height={height}
                    testID={context.heroTestID}
                    flush={flush}
                    cover={node.fit === 'cover'}
                />
                {caption}
            </View>
        )
    }
    if (node.source === 'part' && context.session !== undefined) {
        // A part hero shows the manual's own figure for that part, or nothing: an uncited part has no picture to invent.
        const refs = partSourceRefs(context.session, node.refId, context.live?.entry?.stepIndex)
        const [first] = refs
        if (first === undefined) return null
        return (
            <View
                nativeID={mark}
                testID={context.heroRootTestID ?? 'generated-hero'}
                style={[{ height }, inset && styles.inset]}
            >
                <StepPicture
                    reference={first}
                    references={refs}
                    session={context.session}
                    pageUris={context.pageUris}
                    height={height}
                    testID={context.heroTestID}
                    flush={flush}
                    cover={node.fit === 'cover'}
                />
                {caption}
            </View>
        )
    }
    return node.source === 'part' || caption === null ? null : <View nativeID={mark}>{caption}</View>
}

function Disclosure({
    node,
    context,
    path,
}: {
    node: Extract<ScreenNode, { type: 'DetailsDisclosure' }>
    context: BlockContext
    path: string
}): ReactElement {
    // Safety is never collapsed: a disclosure that holds a Warning is open, whatever the document asked.
    const forced = node.children.some((child) => child.type === 'Warning')
    const [open, setOpen] = useState(node.initiallyOpen)
    const shown = open || forced
    const { colors } = useTheme()
    return (
        <View nativeID={originId(context.originOf(path))} style={styles.stack}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={node.label}
                accessibilityState={{ expanded: shown }}
                disabled={forced}
                onPress={(): void => setOpen(!open)}
                style={styles.disclosure}
            >
                <Heading>{node.label}</Heading>
                {forced ? null : <Icon name={shown ? 'chevronLeft' : 'chevronRight'} color={colors.inkMuted} />}
            </Pressable>
            {shown
                ? node.children.map((child, index) => (
                      <Leaf key={index} node={child} context={context} path={`${path}.children.${index}`} />
                  ))
                : null}
        </View>
    )
}

/** The wait a live pending operation names: reading the manual, checking a photo, or building the guide. */
function waitPhase(pending: string | null): BlueprintPhase {
    if (pending?.startsWith('Reading') === true) return 'reading'
    if (pending?.startsWith('Checking') === true || pending?.startsWith('Freezing') === true) return 'check'
    return 'guide'
}

/** Only the waiting drawing follows the coach: other leaves never re-render when the coach's scope or attention changes. */
function SkeletonBlock({ context, mark }: { context: BlockContext; mark: string }): ReactElement {
    const scope = useCoachScope()
    const attention = useCoachAttention()
    return (
        <BlueprintLoader
            nativeID={mark}
            phase={waitPhase(context.live?.state.pending ?? null)}
            running={scope.active && !attention}
            compact
        />
    )
}

function Leaf({ node, context, path }: { node: Leaf; context: BlockContext; path: string }): ReactElement | null {
    const mark = originId(context.originOf(path))
    switch (node.type) {
        case 'HeroFigure':
            return <Hero node={node} context={context} path={path} />
        case 'Instruction':
            return (
                <>
                    {node.emphasis === 'strong' ? (
                        <Instruction nativeID={mark}>{node.text}</Instruction>
                    ) : node.emphasis === 'quiet' ? (
                        <Caption nativeID={mark}>{node.text}</Caption>
                    ) : (
                        <Body nativeID={mark}>{node.text}</Body>
                    )}
                    <RenderOriginProvider origin={context.originOf(path)}>
                        <TextFactSources text={node.text} context={context} />
                    </RenderOriginProvider>
                </>
            )
        case 'PartList':
            return (
                <View nativeID={mark} style={styles.stack}>
                    {node.items.map((item) => (
                        <View key={item.partId} style={styles.part}>
                            <Body>{item.label}</Body>
                            {node.showQuantities && item.quantity !== null ? (
                                <StatusTag label={`× ${item.quantity}`} />
                            ) : null}
                        </View>
                    ))}
                </View>
            )
        case 'QuantityChip':
            return <StatusTag nativeID={mark} label={`${node.quantity} × ${node.label}`} />
        case 'Warning':
            return (
                <>
                    <Notice nativeID={mark} tone={node.tone === 'critical' ? 'error' : 'caution'} text={node.text} />
                    <RenderOriginProvider origin={context.originOf(path)}>
                        <TextFactSources text={node.text} context={context} />
                    </RenderOriginProvider>
                </>
            )
        case 'StepProgress':
            return (
                <ProgressBar
                    nativeID={mark}
                    label={node.label ?? `Step ${node.current} of ${node.total}`}
                    value={node.current}
                    total={node.total}
                />
            )
        case 'ChoiceList':
            return (
                <View nativeID={mark} style={styles.stack}>
                    {node.prompt === null ? null : <Body>{node.prompt}</Body>}
                    {node.options.map((option, index) => (
                        <Choice
                            key={index}
                            label={option.label}
                            intent={option.intent}
                            context={context}
                            path={path}
                            variant="secondary"
                        />
                    ))}
                </View>
            )
        case 'ConfirmFact':
            return (
                <Card nativeID={mark} tone="raised">
                    <Body>{node.text}</Body>
                    <Choice
                        label="Looks right"
                        intent={node.confirm}
                        context={context}
                        path={path}
                        variant="secondary"
                    />
                    {node.dismiss === null ? null : (
                        <Choice label="Not now" intent={node.dismiss} context={context} path={path} variant="quiet" />
                    )}
                </Card>
            )
        case 'PhotoWithRegions':
            return <PhotoBlock node={node} context={context} path={path} />
        case 'ResultBanner':
            return (
                <View nativeID={mark} style={styles.stack}>
                    <VerdictTag verdict={node.verdict} />
                    <Instruction>{node.text}</Instruction>
                </View>
            )
        case 'AnswerCard':
            return (
                <Card nativeID={mark} tone="raised">
                    <Body>{node.text}</Body>
                    {node.caveat === null ? null : <Caption>{node.caveat}</Caption>}
                </Card>
            )
        case 'Tip':
            // Tips are coach copy, never body content: they reach the coach through the host's candidates.
            return null
        case 'CameraGuidance':
            // Camera wording is read by the camera route from the guide document; it is not body content.
            return null
        case 'ManualLibrary':
            return <ManualLibraryBlock node={node} context={context} path={path} />
        case 'PageGallery':
            return <PageGalleryBlock node={node} context={context} path={path} />
        case 'FactPrompt':
            return <FactPromptBlock node={node} context={context} path={path} />
        case 'FactEditor':
            return <FactEditorBlock node={node} context={context} path={path} />
        case 'QuestionComposer':
            return <QuestionComposerBlock node={node} context={context} path={path} />
        case 'SourceDetails':
            return <SourceDetailsBlock node={node} context={context} path={path} />
        case 'ActionLink':
            return <ActionLinkBlock node={node} context={context} path={path} />
        case 'ManualDirections':
            return <DirectionsBlock node={node} context={context} path={path} />
        case 'Skeleton':
            // A waiting node shows the wait scene for what the app is doing right now, not a generic grey shape.
            return <SkeletonBlock context={context} mark={mark} />
    }
}

function Node({ node, context, path }: { node: ScreenNode; context: BlockContext; path: string }): ReactElement | null {
    if (node.type === 'Group') {
        return (
            <View nativeID={originId(context.originOf(path))} style={node.layout === 'row' ? styles.row : styles.stack}>
                {node.children.map((child, index) => (
                    <View key={index} style={node.layout === 'row' ? styles.cell : undefined}>
                        <Leaf node={child} context={context} path={`${path}.children.${index}`} />
                    </View>
                ))}
            </View>
        )
    }
    if (node.type === 'DetailsDisclosure') return <Disclosure node={node} context={context} path={path} />
    return <Leaf node={node} context={context} path={path} />
}

const ORIGIN_WORDS: Readonly<Record<RenderOrigin, string>> = {
    generated: 'generated by the model',
    fallback: 'built by the app from the manual',
    shell: 'the app’s own screen',
}

/**
 * What the judge layer says about one tapped block: the origin the server recorded for exactly that block's path, never
 * the document as a whole (a generated document can hold a block the server wrote or replaced). A group or disclosure
 * also names where each of its own blocks came from, since those are recorded one by one.
 */
export function inspectedTag(
    node: ScreenNode,
    path: string,
    originOf: (path: string) => RenderOrigin,
    synthetic = false,
): string {
    const words = (path: string): string =>
        originOf(path) === 'generated' && synthetic
            ? 'simulated composition (generated source)'
            : ORIGIN_WORDS[originOf(path)]
    const own = `${node.type} · ${words(path)}`
    if (node.type !== 'Group' && node.type !== 'DetailsDisclosure') return own
    const inside = node.children.map((child, index) => `${child.type} ${words(`${path}.children.${index}`)}`)
    return `${own} · inside: ${inside.join('; ')}`
}

/**
 * Every node of a screen document, in the order the document gave. Each block's own root carries the render-origin
 * marker; nothing else is added around it. With the judge layer on, a tap on a block names what it is and where it
 * came from.
 */
export function ScreenBlocks({
    nodes,
    paths,
    context,
}: {
    readonly nodes: readonly ScreenNode[]
    /** Document path of each node; defaults to its position when the whole body is shown. */
    readonly paths?: readonly string[]
    readonly context: BlockContext
}): ReactElement {
    const [selected, setSelected] = useState<number | null>(null)
    const bodyContext = {
        ...context,
        visibleInstructions: new Set([
            ...(context.visibleInstructions ?? []),
            ...nodes.flatMap((node) => (node.type === 'Instruction' || node.type === 'Warning' ? [node.text] : [])),
        ]),
    }
    return (
        <>
            {nodes.map((node, index) => {
                const block = <Node node={node} context={bodyContext} path={paths?.[index] ?? `body.${index}`} />
                if (!context.inspect) return <Fragment key={index}>{block}</Fragment>
                return (
                    <View key={index}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`${node.type}. Show how this part was built`}
                            onPress={(): void => setSelected(selected === index ? null : index)}
                        >
                            {block}
                        </Pressable>
                        {selected === index ? (
                            <Caption>
                                {inspectedTag(
                                    node,
                                    paths?.[index] ?? `body.${index}`,
                                    context.originOf,
                                    context.synthetic,
                                )}
                            </Caption>
                        ) : null}
                    </View>
                )
            })}
        </>
    )
}

const styles = StyleSheet.create({
    inset: { marginHorizontal: space.md, marginTop: space.xs, overflow: 'hidden' },
    stack: { gap: space.xs },
    row: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
    cell: { flexGrow: 1, flexBasis: 0, minWidth: 140 },
    part: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xs },
    disclosure: {
        minHeight: touchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.xs,
    },
})
