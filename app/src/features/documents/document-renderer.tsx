import { useState, type ReactElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import type { AppIntent } from '@truebuild/contracts'
import type { ScreenDocumentV2, ScreenKind, ScreenNodeV2, TextRefV2 } from '@truebuild/contracts'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { SettingRow } from '../../ui/fields'
import { Icon } from '../../ui/icons'
import { ProgressBar } from '../../ui/progress'
import { StatusTag, VerdictTag } from '../../ui/status'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction, Label, LargeTitle, Title } from '../../ui/text'
import { space } from '../../theme/tokens'
import Animated from 'react-native-reanimated'
import { ScreenBody, TextRegion } from '../capture/screen-layout'
import { ScreenBlocks, type BlockContext } from '../screens/blocks'
import { Fact } from '../screens/mandatory'
import { safetyKey } from '../screens/safety'
import { AttributionCard } from '../screens/attribution'
import { useJudge } from '../screens/judge-context'
import type { GeneratedScreen, ScreenSlot } from '../screens/use-screen-slot'
import { useContentFade } from '../../ui/motion'
import { bindingsFromGenerated, framesFromGenerated } from './bindings'
import { barTestId } from '../screens/bar-ids'
import { originId, type RenderOrigin } from '../screens/render-origin'
import {
    flattenFrameNodes,
    isLayoutNode,
    type FrameBindings,
    type FrameDocument,
    type FrameNode,
    type FrameVariant,
} from './types'
import { heldPhotoResolves } from './validate'
import { NativeDocumentRenderer } from './native-document'

export const CAPABILITY_INTERNALS_NAMESPACE = 'truebuild-capability-internals'

/** Marker for actual native capability internals only (metric strict exclusion). Never on labels, layout or panes. */
export function capabilityInternalsId(catalogType: string): string {
    return `${CAPABILITY_INTERNALS_NAMESPACE}:${catalogType}`
}

/** The body (and bar) a variant actually renders. Busy/blocked/reading/confirming bars come from here, never native. */
export function selectVariant(
    document: FrameDocument,
    variant: FrameVariant,
    held: { readonly captureId: string; readonly reusable: boolean } | null,
    gateHeldPhoto = true,
): { readonly body: readonly FrameNode[]; readonly bar: FrameDocument['bar']; readonly effective: FrameVariant } {
    // Held photo before verdict: a result whose photo has not resolved never mounts its verdict composition.
    if (gateHeldPhoto && document.kind === 'result' && !heldPhotoResolves(document, held)) {
        const pending = document.variants?.pending
        return { body: pending?.body ?? [], bar: pending?.bar ?? document.bar, effective: 'pending' }
    }
    if (variant === 'normal') return { body: document.body, bar: document.bar, effective: 'normal' }
    const chosen = document.variants?.[variant]
    if (chosen === undefined) return { body: document.body, bar: document.bar, effective: 'normal' }
    return { body: chosen.body, bar: chosen.bar ?? document.bar, effective: variant }
}

function originOf(document: FrameDocument): (path: string) => RenderOrigin {
    return (path: string): RenderOrigin => document.origins?.[path] ?? document.source
}

function blockContext(document: FrameDocument, bindings: FrameBindings): BlockContext {
    return {
        originOf: originOf(document),
        origin: document.source,
        session: bindings.session,
        pageUris: bindings.pageUris,
        capture: bindings.capture,
        marks: bindings.marks,
        sources: document.sources ?? [],
        manualFacts: (document.manualFacts ?? []) as BlockContext['manualFacts'],
        // Whole-body dedup survives per-node rendering: a direction already stated by a sibling node is not repeated.
        visibleInstructions: new Set(
            flattenFrameNodes(document.body).flatMap((leaf) =>
                leaf.type === 'Instruction' || leaf.type === 'Warning' ? [leaf.text] : [],
            ),
        ),
        live: bindings.live,
        heroMode: bindings.heroMode,
        ...(bindings.heroTestID === undefined ? {} : { heroTestID: bindings.heroTestID }),
        ...(bindings.heroRootTestID === undefined ? {} : { heroRootTestID: bindings.heroRootTestID }),
        resolve: bindings.resolve,
        inspect: bindings.inspect,
    }
}

/** A document section with disclosure semantics: safety (a Warning inside) is never collapsed. */
function SectionView({
    label,
    initiallyOpen,
    collapsible,
    forced,
    mark,
    children,
}: {
    readonly label: string
    readonly initiallyOpen?: boolean
    readonly collapsible?: boolean
    /** Safety is never collapsed: a section holding a Warning stays open and cannot be closed. */
    readonly forced?: boolean
    readonly mark: string
    readonly children: ReactNode
}): ReactElement {
    const [open, setOpen] = useState(initiallyOpen ?? collapsible === false)
    const shown = open || forced === true || collapsible === false
    return (
        <View nativeID={mark} style={styles.stack}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ expanded: shown }}
                disabled={forced === true || collapsible === false}
                onPress={(): void => setOpen(!open)}
                style={styles.details}
            >
                <Heading>{label}</Heading>
            </Pressable>
            {shown ? children : null}
        </View>
    )
}

function refText(bindings: FrameBindings, ref: TextRefV2 | null): string {
    if (ref === null) return ''
    if (bindings.resolveText !== undefined) return bindings.resolveText(ref)
    return ref.kind === 'literal' ? ref.text : ''
}

/**
 * One v2 catalog leaf with live bindings. Configured labels, icons and children stay outside any capability
 * internals marker; only actual native mechanics (the camera preview surface) carry that marker, on their own root.
 */
export function V2Leaf({
    node,
    bindings,
    mark,
}: {
    readonly node: ScreenNodeV2
    readonly bindings: FrameBindings
    readonly mark: string
}): ReactElement | null {
    const live = bindings.live
    switch (node.type) {
        case 'Text': {
            const words = refText(bindings, node.content)
            switch (node.role) {
                case 'display':
                    return <LargeTitle nativeID={mark}>{words}</LargeTitle>
                case 'title':
                    return <Title nativeID={mark}>{words}</Title>
                case 'heading':
                    return <Heading nativeID={mark}>{words}</Heading>
                case 'label':
                    return <Label nativeID={mark}>{words}</Label>
                case 'caption':
                    return <Caption nativeID={mark}>{words}</Caption>
                case 'body':
                default:
                    return node.emphasis === 'strong' ? (
                        <Instruction nativeID={mark}>{words}</Instruction>
                    ) : (
                        <Body nativeID={mark}>{words}</Body>
                    )
            }
        }
        case 'Icon':
            return (
                <View nativeID={mark}>
                    <Icon name={node.name} />
                </View>
            )
        case 'Badge':
            return <StatusTag nativeID={mark} label={refText(bindings, node.label)} />
        case 'Progress':
        case 'Meter':
        case 'Stepper': {
            const entry = live?.entry
            const total = entry?.session.reviewedSteps.length ?? 0
            const current = entry === undefined ? 0 : entry.stepIndex + 1
            const label = refText(bindings, node.label) || (total > 0 ? `Step ${current} of ${total}` : 'Progress')
            return total > 0 ? (
                <ProgressBar nativeID={mark} label={label} value={current} total={total} />
            ) : (
                <Caption nativeID={mark}>{label}</Caption>
            )
        }
        case 'Toggle': {
            const toggle = bindings.toggles?.[node.binding]
            const label = refText(bindings, node.label)
            return toggle === undefined ? (
                <Caption nativeID={mark}>{label}</Caption>
            ) : (
                <SettingRow label={label} value={toggle.value} onValueChange={toggle.onChange} />
            )
        }
        case 'Choice': {
            const prompt = refText(bindings, node.prompt)
            return prompt === '' ? null : <Caption nativeID={mark}>{prompt}</Caption>
        }
        case 'TextField': {
            const label = refText(bindings, node.label)
            return (
                <View nativeID={mark} style={styles.stack}>
                    <Caption>{label}</Caption>
                    {node.placeholder === null ? null : <Caption>{node.placeholder}</Caption>}
                </View>
            )
        }
        case 'PieceTile': {
            const part = bindings.session?.parts.find((candidate) => candidate.partId === node.partId)
            const label = part?.name.state === 'known' ? part.name.value : node.partId
            return <StatusTag nativeID={mark} label={label} />
        }
        case 'VerdictCard': {
            const check = live?.state.check ?? null
            if (check === null) return null
            const inner = (
                <>
                    <VerdictTag verdict={check.decision} />
                    {node.showReason ? <Instruction>{check.reason}</Instruction> : null}
                </>
            )
            return node.variant === 'card' ? (
                <Card nativeID={mark} tone="result">
                    {inner}
                </Card>
            ) : (
                <View nativeID={mark} style={styles.stack}>
                    {inner}
                </View>
            )
        }
        case 'JudgePanel':
            return <JudgeSummaryCard bindings={bindings} />
        case 'CameraView':
            return (
                <View nativeID={mark} style={styles.stack}>
                    <Instruction>{node.cue}</Instruction>
                    {node.pill === null ? null : <StatusTag label={node.pill} />}
                    {/* Actual preview mechanics only: no label, layout or document child sits inside this root. */}
                    <View nativeID={capabilityInternalsId('CameraView')} style={styles.cameraInternals} />
                </View>
            )
        case 'CoachMark':
        case 'CompareColumns':
            // Coach copy reaches the coach engine and compare panes are route-owned documents; neither is body content.
            return null
        default:
            return null
    }
}

function RecursiveBody({
    nodes,
    context,
    basePath,
    paths,
    bindings,
}: {
    readonly nodes: readonly FrameNode[]
    readonly context: BlockContext
    readonly basePath: string
    /** Original document path of each top-level node, so server-owned origins survive dropped nodes. */
    readonly paths?: readonly string[]
    readonly bindings?: FrameBindings
}): ReactElement {
    return (
        <>
            {nodes.map((node, index) => {
                const path = paths?.[index] ?? `${basePath}.${index}`
                if (node.type === 'V2Leaf') {
                    return bindings === undefined ? null : (
                        <V2Leaf
                            key={index}
                            node={node.node}
                            bindings={bindings}
                            mark={originId(context.originOf(path))}
                        />
                    )
                }
                if (!isLayoutNode(node)) {
                    // Leaf and v1 catalog nodes keep their existing primitive rendering and origin paths.
                    return <ScreenBlocks key={index} nodes={[node as never]} paths={[path]} context={context} />
                }
                const mark = originId(context.originOf(path))
                switch (node.type) {
                    case 'Divider':
                        return <View key={index} nativeID={mark} style={styles.divider} />
                    case 'Spacer':
                        return <View key={index} nativeID={mark} style={{ height: space[node.size ?? 'sm'] }} />
                    case 'Row':
                        return (
                            <View key={index} nativeID={mark} style={[styles.row, { gap: space[node.gap ?? 'sm'] }]}>
                                {node.children.map((child, childIndex) => (
                                    <View key={childIndex} style={styles.cell}>
                                        <RecursiveBody
                                            nodes={[child]}
                                            context={context}
                                            basePath={`${path}.children`}
                                            bindings={bindings}
                                        />
                                    </View>
                                ))}
                            </View>
                        )
                    case 'Grid':
                        return (
                            <View key={index} nativeID={mark} style={styles.grid}>
                                {node.children.map((child, childIndex) => (
                                    <View
                                        key={childIndex}
                                        style={{
                                            width:
                                                node.columns === 1
                                                    ? '100%'
                                                    : node.columns === 2
                                                      ? '48%'
                                                      : node.columns === 4
                                                        ? '23%'
                                                        : '31%',
                                        }}
                                    >
                                        <RecursiveBody
                                            nodes={[child]}
                                            context={context}
                                            basePath={`${path}.children`}
                                            bindings={bindings}
                                        />
                                    </View>
                                ))}
                            </View>
                        )
                    case 'Card':
                        return (
                            <Card key={index} nativeID={mark} tone={node.tone ?? 'surface'}>
                                <RecursiveBody
                                    nodes={node.children}
                                    context={context}
                                    basePath={`${path}.children`}
                                    bindings={bindings}
                                />
                            </Card>
                        )
                    case 'Section':
                        return (
                            <SectionView
                                key={index}
                                label={node.label}
                                initiallyOpen={node.initiallyOpen}
                                collapsible={node.collapsible}
                                forced={flattenFrameNodes(node.children).some((leaf) => leaf.type === 'Warning')}
                                mark={mark}
                            >
                                <RecursiveBody
                                    nodes={node.children}
                                    context={context}
                                    basePath={`${path}.children`}
                                    bindings={bindings}
                                />
                            </SectionView>
                        )
                    case 'Scroll':
                        return (
                            <View key={index} nativeID={mark}>
                                <RecursiveBody
                                    nodes={node.children}
                                    context={context}
                                    basePath={`${path}.children`}
                                    bindings={bindings}
                                />
                            </View>
                        )
                    case 'Stack':
                    default:
                        return (
                            <View key={index} nativeID={mark} style={[styles.stack, { gap: space[node.gap ?? 'sm'] }]}>
                                <RecursiveBody
                                    nodes={node.children}
                                    context={context}
                                    basePath={`${path}.children`}
                                    bindings={bindings}
                                />
                            </View>
                        )
                }
            })}
        </>
    )
}

/**
 * Document header on the renderer path: the title wraps (no one-line truncation), the subtitle drops below the
 * title, and height is driven by content so the largest native fonts cannot clip or overlap the trailing control.
 * Full accessible label always matches the visible title text.
 */
export function DocumentHeader({
    document,
    bindings,
}: {
    readonly document: FrameDocument
    readonly bindings: FrameBindings
}): ReactElement {
    const trailing = document.header.trailing
    const resolved = trailing === null ? null : bindings.resolve(trailing)
    return (
        <View
            nativeID={originId(originOf(document)('header'))}
            accessible
            accessibilityRole="header"
            accessibilityLabel={
                document.header.subtitle === null
                    ? document.header.title
                    : `${document.header.title}, ${document.header.subtitle}`
            }
            style={styles.header}
        >
            <View style={styles.headerText}>
                <Heading>{document.header.title}</Heading>
                {document.header.subtitle === null ? null : <Caption>{document.header.subtitle}</Caption>}
            </View>
            {trailing === null || resolved === null ? null : (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="More"
                    disabled={!resolved.enabled}
                    onPress={resolved.run}
                    style={styles.trailing}
                >
                    <Caption>More</Caption>
                </Pressable>
            )}
        </View>
    )
}

function toBarAction(
    document: FrameDocument,
    bindings: FrameBindings,
    role: 'primary' | 'secondary',
): BarAction | null {
    const action = role === 'primary' ? document.bar.primary : document.bar.secondary
    if (action === null) return null
    const resolved = bindings.resolve(action.intent as AppIntent)
    const owned = role === 'primary' ? bindings.testIds?.primary : bindings.testIds?.secondary
    const v1Kind = !['camera', 'judge', 'compare'].includes(document.kind)
    const testID =
        owned ?? (!v1Kind ? undefined : barTestId(document.kind as ScreenKind, role, action.intent as AppIntent))
    return {
        label: action.label,
        ...(action.compactLabel === undefined ? {} : { compactLabel: action.compactLabel }),
        ...(action.icon === null ? {} : { icon: action.icon }),
        ...(testID === undefined ? {} : { testID }),
        disabled: !resolved.enabled,
        onPress: resolved.run,
        nativeID: originId(originOf(document)(role === 'primary' ? 'bar.primary' : 'bar.secondary')),
        accessibilityLabel: action.label,
    }
}

/** One calm judge summary card. Full attribution stays behind the single Details tap; nothing else is added. */
export function JudgeSummaryCard({ bindings }: { readonly bindings: FrameBindings }): ReactElement | null {
    if (bindings.judge == null || bindings.workInProgress === true) return null
    return (
        <Card testID="judge-summary" tone="raised">
            <Stack gap="xs">
                <Heading>How this screen was built</Heading>
                <Caption>{bindings.judge.summary}</Caption>
                <Pressable
                    testID="judge-details"
                    accessibilityRole="button"
                    accessibilityLabel="Details"
                    onPress={bindings.judge.onShowDetails}
                    style={styles.details}
                >
                    <Caption>Details</Caption>
                </Pressable>
            </Stack>
        </Card>
    )
}

/**
 * The canonical whole-frame renderer: exactly one document header, one scrolling content region in document
 * order, overlays from the document/bindings, and one fixed bar outside the scroll. Layout ownership is explicit
 * in the document — the renderer never reorders a first hero or merges native facts beside the document.
 */
function LegacyFrameRenderer({
    document,
    bindings,
    variant = 'normal',
    chrome = 'full',
    held = null,
    testID = 'document-screen',
}: {
    readonly document: FrameDocument
    readonly bindings: FrameBindings
    readonly variant?: FrameVariant
    /** `full` renders the document header; `body-only` when the native Stack header already shows it (still one header). */
    readonly chrome?: 'full' | 'body-only'
    readonly held?: { readonly captureId: string; readonly reusable: boolean } | null
    readonly testID?: string
}): ReactElement {
    const selected = selectVariant(
        document,
        variant,
        held ??
            (bindings.capture === null
                ? null
                : {
                      captureId: bindings.capture.binding.captureId,
                      reusable: bindings.capture.reusable,
                  }),
    )
    const effective = { ...document, body: selected.body, bar: selected.bar }
    const context = blockContext(effective, bindings)
    const [barHeight, setBarHeight] = useState(0)
    void barHeight
    const primary = toBarAction(effective, bindings, 'primary')
    const secondary = toBarAction(effective, bindings, 'secondary')
    const barReason = bindings.resolve(effective.bar.primary.intent as AppIntent).reason
    return (
        <ScreenBody testID={testID} nativeID={originId(document.source)}>
            {chrome === 'full' ? <DocumentHeader document={effective} bindings={bindings} /> : null}
            <TextRegion>
                <RecursiveBody nodes={selected.body} context={context} basePath="body" bindings={bindings} />
                <JudgeSummaryCard bindings={bindings} />
            </TextRegion>
            <FixedBottomBar
                nativeID={originId(originOf(document)('bar.primary'))}
                primary={primary}
                {...(secondary === null ? {} : { secondary })}
                reason={barReason}
                onHeight={setBarHeight}
            />
        </ScreenBody>
    )
}

/** v2 stays intact through rendering. Frame documents are compatibility-only for retained demo/preview callers. */
export function DocumentRenderer(props: {
    readonly document: FrameDocument | ScreenDocumentV2
    readonly bindings: FrameBindings
    readonly variant?: string
    readonly chrome?: 'full' | 'body-only'
    readonly held?: { readonly captureId: string; readonly reusable: boolean } | null
    readonly testID?: string
}): ReactElement {
    return 'version' in props.document ? (
        <NativeDocumentRenderer
            document={props.document}
            bindings={props.bindings}
            variant={props.variant === 'normal' ? 'ready' : props.variant}
            chrome={props.chrome}
            testID={props.testID}
        />
    ) : (
        <LegacyFrameRenderer {...props} document={props.document} variant={props.variant as FrameVariant | undefined} />
    )
}

/** The document's pinned hero: its first node, rendered where the document placed it (never reordered). */
export function DocumentHero({
    frame,
    bindings,
}: {
    readonly frame: FrameDocument
    readonly bindings: FrameBindings
}): ReactElement {
    const context = blockContext(frame, bindings)
    return <RecursiveBody nodes={frame.body} context={context} basePath="body" bindings={bindings} />
}

/** Which full variant of a v2 document the frame shows: the ready variant or one of its own state variants. */
export type DocumentVariantSelection = 'ready' | 'busy' | 'pending' | 'empty' | 'error' | 'recovery'

/**
 * The whole-frame root for a chosen version-2 document: header, scrolling body, fixed bar and judge overlay are
 * all rendered as part of the validated document root (no native chrome beside it). Routes pass the document
 * their v2 hook selected plus live bindings; the selected state variant supplies its own chrome and bar.
 */
export function DocumentRoot({
    document,
    bindings,
    variant = 'ready',
    held = null,
    testID = 'document-screen',
}: {
    readonly document: ScreenDocumentV2
    readonly bindings: FrameBindings
    readonly variant?: DocumentVariantSelection
    readonly held?: { readonly captureId: string; readonly reusable: boolean } | null
    readonly testID?: string
}): ReactElement {
    return <DocumentRenderer document={document} bindings={bindings} variant={variant} held={held} testID={testID} />
}

/** The composed screen's pinned hero through the canonical renderer (replaces the old host hero helper). */
export function DocumentComposedHero({
    screen,
    live,
}: {
    readonly screen: GeneratedScreen
    readonly live?: Partial<NonNullable<FrameBindings['live']>>
}): ReactElement | null {
    const frames = framesFromGenerated(screen)
    if (frames.hero === null) return null
    return <DocumentHero frame={frames.hero} bindings={bindingsFromGenerated(screen, live)} />
}

/**
 * A composed screen's body through the canonical renderer: one content fade per document, the judge attribution
 * when the device judge view is on, then the document body in document order (hero excluded when pinned).
 */
export function DocumentComposedBody({
    screen,
    enabled = true,
    pinned = false,
    live,
}: {
    readonly screen: GeneratedScreen
    readonly enabled?: boolean
    readonly pinned?: boolean
    readonly live?: Partial<NonNullable<FrameBindings['live']>>
}): ReactElement {
    const fade = useContentFade(screen.document.screenId, enabled)
    const { showBuilt } = useJudge()
    const frames = framesFromGenerated(screen)
    const shown = pinned ? frames.rest : frames.frame
    const paths = pinned ? frames.restPaths : screen.guarded.paths
    return (
        <Animated.View testID="generated-body" style={[styles.bodyFade, fade]}>
            {showBuilt ? <AttributionCard screen={screen} /> : null}
            <DocumentBody
                document={shown}
                bindings={bindingsFromGenerated(screen, live)}
                {...(paths === undefined ? {} : { paths })}
            />
        </Animated.View>
    )
}

/** The More sheet's composed intro through the canonical renderer; nothing until its document arrives. */
export function DocumentMoreIntro({ slot }: { readonly slot: ScreenSlot | undefined }): ReactElement | null {
    return slot?.status === 'ready' ? <DocumentComposedBody screen={slot.screen} /> : null
}

/** Body-only entry for hosts that already own header/bar placement during migration. New routes use DocumentRenderer. */
export function DocumentBody({
    document,
    bindings,
    variant = 'normal',
    held,
    paths,
    visibleText,
}: {
    readonly document: FrameDocument
    readonly bindings: FrameBindings
    readonly variant?: FrameVariant
    /** Omit when the host already decided the verdict may show; pass (even null) to apply the held-photo gate. */
    readonly held?: { readonly captureId: string; readonly reusable: boolean } | null
    readonly paths?: readonly string[]
    /** Complete native text already presented beside this body; a remainder fact stating it verbatim is not repeated. */
    readonly visibleText?: string
}): ReactElement {
    const selected =
        held === undefined ? selectVariant(document, variant, null, false) : selectVariant(document, variant, held)
    const context = blockContext({ ...document, body: selected.body }, bindings)
    // Facts the document itself publishes as remainder are document content, rendered here — never appended natively.
    const remainder = (document.manualFacts ?? []).filter(
        (fact) =>
            fact.placement === 'remainder' &&
            (visibleText === undefined || safetyKey(fact.text) !== safetyKey(visibleText)),
    )
    return (
        <>
            <RecursiveBody
                nodes={selected.body}
                context={context}
                basePath="body"
                bindings={bindings}
                {...(paths === undefined ? {} : { paths })}
            />
            {remainder.map((fact) => (
                <View key={fact.factId} nativeID={originId(document.source)}>
                    <Fact
                        fact={fact as never}
                        emphasis="normal"
                        session={bindings.session}
                        pageUris={bindings.pageUris}
                    />
                </View>
            ))}
            <JudgeSummaryCard bindings={bindings} />
        </>
    )
}

const styles = StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, padding: space.md, flexShrink: 0 },
    headerText: { flex: 1, gap: space.xs },
    trailing: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
    stack: { gap: space.sm },
    row: { flexDirection: 'row' },
    cell: { flex: 1 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    divider: { height: StyleSheet.hairlineWidth },
    details: { minHeight: 44, justifyContent: 'center' },
    cameraInternals: { height: 240 },
    bodyFade: { gap: 12 },
})

export type { ReactNode }
