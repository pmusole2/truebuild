import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
    I18nManager,
    Image,
    PanResponder,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
    View,
} from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import {
    screenFacts,
    variantsOfV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenVariantV2,
    type TextRefV2,
} from '@truebuild/contracts'
import { AppButton, IconButton } from '../../ui/button'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { SegmentedControl, SettingRow, TextField } from '../../ui/fields'
import { Icon } from '../../ui/icons'
import { ProgressBar } from '../../ui/progress'
import { Card } from '../../ui/surface'
import { StatusTag, VerdictTag } from '../../ui/status'
import { Body, Caption, Heading, Instruction, Label, LargeTitle, Title, type TextTone } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { lightColors, radius, space, touchTarget } from '../../theme/tokens'
import { bytesToDataUri } from '../../media/image-source'
import { ScreenBody } from '../capture/screen-layout'
import { StepPicture } from '../capture/step-picture'
import { SourceDiagrams } from '../capture/step-facts'
import { GroundedRegionOutline, SegmentMasks } from '../assembly/grounded-overlays'
import { boxOnDisplay, containRect } from '../assembly/frame-geometry'
import { heroImageRect } from '../assembly/hero-geometry'
import { extractTapCoordinates } from '../assembly/frozen-photo'
import { partSourceRefs } from '../screens/part-source'
import { stepPartChoices } from '../assembly/question-state'
import { FactEditorBlock, ManualLibraryBlock, PageGalleryBlock } from '../screens/blocks-live'
import type { BlockContext } from '../screens/blocks'
import { barTestId } from '../screens/bar-ids'
import { originId } from '../screens/render-origin'
import { useJudge } from '../screens/judge-context'
import { useMeterReading } from '../screens/native-meter'
import { CompareManualsRow, StagesPanel } from '../screens/attribution'
import type { FrameBindings } from './types'
import { manualDisplayTitle } from './manual-title'
import Animated from 'react-native-reanimated'
import { useContentFade } from '../../ui/motion'
import { useIconReveal, useReadingLoop, useStepTransition } from '../../ui/motion'
import { useFeedback } from '../../ui/feedback'
import { PRIVACY_COPY } from '../capture/privacy-copy'
import { startsAtStepSystemEdge, STEP_SWIPE_DISTANCE } from '../capture/gesture-policy'
import { CoachTarget, useCoachAttention, useCoachScope } from '../onboarding/coach-provider'

const gap = (token: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'): number => (token === 'none' ? 0 : space[token])
const align = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' } as const
const tone = { neutral: 'default', info: 'accent', success: 'pass', caution: 'caution', critical: 'refuse' } as const
const capability = (type: string): string => `truebuild-capability-internals:${type}`
const TIMING_LABELS = {
    timeToProviderMs: 'Before provider',
    providerMs: 'Provider time',
    parseValidateMs: 'Validation',
    totalMs: 'Server total',
} as const
const USAGE_LABELS = {
    inputTokens: 'Input tokens',
    cachedTokens: 'Cached input tokens',
    outputTokens: 'Output tokens',
    reasoningTokens: 'Reasoning tokens',
} as const

export function documentText(document: ScreenDocumentV2, bindings: FrameBindings, ref: TextRefV2 | null): string {
    if (ref === null) return ''
    if (ref.kind === 'literal') return ref.text
    if (ref.kind === 'fact') return document.facts.find((fact) => fact.factId === ref.factId)?.text ?? ''
    if (bindings.resolveText !== undefined) return bindings.resolveText(ref)
    const entry = bindings.live?.entry
    const session = bindings.session
    const facts = screenFacts(session ?? null)
    const step = facts?.steps.find((item) => item.stepId === document.bound.stepId)
    switch (ref.key) {
        case 'manual-title':
            return session === undefined ? '' : manualDisplayTitle(session)
        case 'step-title':
            return step?.title ?? ''
        case 'step-position':
            return step === undefined
                ? ''
                : `Step ${(facts?.steps.indexOf(step) ?? -1) + 1} of ${facts?.steps.length ?? 0}`
        case 'pages-summary':
            return `${session?.pages.length ?? 0} manual ${(session?.pages.length ?? 0) === 1 ? 'page' : 'pages'}`
        case 'steps-summary':
            return `${facts?.steps.length ?? 0} steps`
        case 'completion-summary':
            return `${facts?.reviewed === true ? (entry?.completedStepIds.length ?? 0) : 0} of ${facts?.steps.length ?? 0} steps marked done`
        case 'review-reason':
            return bindings.live?.quick?.current?.reason ?? ''
        case 'review-position':
            return bindings.live?.quick?.label ?? ''
        case 'operation-notice':
            return bindings.operationNotice ?? ''
        case 'held-question':
            return bindings.answeredQuestion ?? ''
        case 'privacy-stay':
            return PRIVACY_COPY.stayOnDevice
        case 'privacy-read':
            return PRIVACY_COPY.read
        case 'privacy-check':
            return PRIVACY_COPY.check
        case 'privacy-ask':
            return PRIVACY_COPY.ask
        case 'privacy-camera':
            return PRIVACY_COPY.camera
        case 'privacy-library':
            return PRIVACY_COPY.library
        case 'privacy-once':
            return PRIVACY_COPY.once
        case 'storage-summary': {
            const count = bindings.live?.state.entries.length ?? 0
            return count === 1 ? '1 build is saved on this phone.' : `${count} builds are saved on this phone.`
        }
        case 'storage-note':
            return 'Nothing is removed unless you remove it.'
        case 'help-scan':
            return 'Scan. Photograph the pages of your paper manual.'
        case 'help-look':
            return 'Look. We read the pages and show you each step.'
        case 'help-next':
            return 'Next. Do one step, take one photo, hear how it went.'
        case 'help-ask':
            return 'Ask. Stuck? Photograph the part and ask in your own words.'
    }
}

type Environment = {
    document: ScreenDocumentV2
    bindings: FrameBindings
    prefix: string
    photoLoaded: boolean
    showRegions: boolean
    loaded: () => void
    omittedDuplicates: ReadonlySet<string>
    trailing: ReactNode
}
const marked = (environment: Environment, path: string): string =>
    originId(environment.document.metadata.origins[path] ?? 'fallback')

/** A quantity picture belongs to the document's step, never a different live selection's index. */
function partRefs(environment: Environment, partId: string): ReturnType<typeof partSourceRefs> {
    const session = environment.bindings.session
    if (session === undefined) return []
    const index =
        session.reviewStatus === 'reviewed'
            ? session.reviewedSteps.findIndex((step) => step.stepId === environment.document.bound.stepId)
            : -1
    return partSourceRefs(session, partId, index < 0 ? undefined : index)
}

/** A fact's own citation is rendered with its first visible statement, once per fact identity. */
function duplicateFactPaths(body: ScreenNodeV2, path: string): Set<string> {
    const seen = new Set<string>()
    const omitted = new Set<string>()
    const visit = (node: ScreenNodeV2, at: string): void => {
        if (!('children' in node)) return
        if (node.type === 'Section' && node.collapsible && !node.initiallyOpen) return
        let repeatedFact = false
        node.children.forEach((child, index) => {
            const next = `${at}.${index}`
            if (child.type === 'Text' && child.content.kind === 'fact') {
                repeatedFact = seen.has(child.content.factId)
                if (repeatedFact) omitted.add(next)
                else seen.add(child.content.factId)
            } else if (child.type === 'Citation' && repeatedFact) omitted.add(next)
            else repeatedFact = false
            visit(child, next)
        })
    }
    visit(body, path)
    return omitted
}

function containsSafety(node: ScreenNodeV2, document: ScreenDocumentV2): boolean {
    if (node.type === 'Text' && node.content.kind === 'fact') {
        const id = node.content.factId
        if (document.facts.some((fact) => fact.factId === id && fact.basis === 'safety-note')) return true
    }
    return 'children' in node && node.children.some((child) => containsSafety(child, document))
}

/** The controller reports no per-page parse progress: show known page count and an indeterminate, truthful activity. */
function ReadingProgress({
    environment,
    label,
    mark,
}: {
    environment: Environment
    label: string
    mark: string
}): ReactElement {
    const { colors } = useTheme()
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const reading = environment.bindings.live?.state.pending?.startsWith('Reading') === true
    const breath = useReadingLoop(reading && scope.active && !attention)
    const count = environment.bindings.session?.pages.length ?? 0
    return (
        <View
            nativeID={mark}
            accessible
            accessibilityRole={reading ? 'progressbar' : 'text'}
            accessibilityLabel={label || (reading ? 'Reading your manual' : 'Manual pages')}
            accessibilityValue={reading ? { text: 'In progress' } : undefined}
            style={styles.row}
        >
            {reading ? (
                <Animated.View
                    style={[
                        { width: space.xs, height: space.xs, borderRadius: space.xxs, backgroundColor: colors.accent },
                        breath,
                    ]}
                />
            ) : null}
            <Caption>{label || `${count} manual ${count === 1 ? 'page' : 'pages'}`}</Caption>
        </View>
    )
}

function contextOf(environment: Environment): BlockContext {
    const { document, bindings } = environment
    return {
        readOnly: bindings.readOnly,
        originOf: (path) => document.metadata.origins[path] ?? 'fallback',
        origin: document.metadata.source,
        session: bindings.session,
        pageUris: bindings.pageUris,
        capture: bindings.capture,
        marks: bindings.marks,
        sources: document.sources,
        manualFacts: [],
        live: bindings.live,
        heroMode: 'inline',
        resolve: bindings.resolve,
        inspect: bindings.inspect,
    }
}

function Action({
    action,
    environment,
    path,
    header = false,
}: {
    action: Omit<ScreenVariantV2['bar']['primary'], 'type'>
    environment: Environment
    path: string
    header?: boolean
}): ReactElement {
    const resolved =
        environment.bindings.readOnly === true
            ? { enabled: false, reason: 'Comparison is read only.', run: (): void => undefined }
            : environment.bindings.resolve(action.intent)
    const element =
        header && action.icon !== null ? (
            <IconButton
                nativeID={marked(environment, path)}
                label={action.label}
                icon={action.icon}
                disabled={!resolved.enabled}
                onPress={resolved.run}
                testID={
                    environment.document.kind === 'camera' && action.intent.intent === 'navigate'
                        ? 'camera-close'
                        : path.endsWith('header.back') &&
                            (environment.document.kind === 'more' ||
                                environment.document.kind === 'questions' ||
                                environment.document.kind === 'judge')
                          ? 'close-sheet'
                          : action.intent.intent === 'open-details' || action.intent.target === 'more'
                            ? 'header-more'
                            : undefined
                }
            />
        ) : (
            <AppButton
                nativeID={marked(environment, path)}
                label={action.label}
                variant="quiet"
                hint={resolved.reason ?? undefined}
                testID={
                    action.intent.intent === 'show-tips'
                        ? 'show-tips-again'
                        : action.intent.intent === 'open-details' && action.intent.target === 'about-check'
                          ? 'judge-entry'
                          : undefined
                }
                icon={action.icon ?? undefined}
                disabled={!resolved.enabled}
                onPress={resolved.run}
            />
        )
    return header && (action.intent.intent === 'open-details' || action.intent.target === 'more') ? (
        <CoachTarget id="header-more" label={action.label} onPress={resolved.enabled ? resolved.run : undefined}>
            {element}
        </CoachTarget>
    ) : (
        element
    )
}

function ReferenceImage({
    node,
    environment,
    path,
}: {
    node: Extract<ScreenNodeV2, { type: 'Image' }>
    environment: Environment
    path: string
}): ReactElement | null {
    const { bindings, document } = environment
    const { width } = useWindowDimensions()
    const live = bindings.live
    const swipe = useMemo(
        () =>
            PanResponder.create({
                onMoveShouldSetPanResponder: (_event, gesture) =>
                    document.kind === 'guide' &&
                    bindings.session?.reviewStatus === 'reviewed' &&
                    bindings.readOnly !== true &&
                    Math.abs(gesture.dx) > 24 &&
                    Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5 &&
                    !startsAtStepSystemEdge(gesture.moveX - gesture.dx, width, I18nManager.isRTL, Platform.OS),
                onPanResponderRelease: (_event, gesture): void => {
                    if (
                        live === null ||
                        bindings.session?.reviewStatus !== 'reviewed' ||
                        bindings.readOnly === true ||
                        live.state.pending !== null ||
                        live.state.storageReadOnly ||
                        !bindings.resolve({ intent: 'capture', target: 'take-photo' }).enabled
                    )
                        return
                    const steps = bindings.session.reviewedSteps
                    const current = steps.findIndex((step) => step.stepId === document.bound.stepId)
                    if (
                        current < 0 ||
                        live.entry?.session.manualId !== document.bound.manualId ||
                        live.entry.session.revision !== document.bound.revision ||
                        live.entry.stepIndex !== current
                    )
                        return
                    const next =
                        gesture.dx < -STEP_SWIPE_DISTANCE
                            ? current + 1
                            : gesture.dx > STEP_SWIPE_DISTANCE
                              ? current - 1
                              : null
                    if (next !== null && next >= 0 && next < steps.length) void live.controller.step(next)
                },
            }),
        [document.kind, live, width, bindings],
    )
    const source =
        node.source.kind === 'source'
            ? document.sources[node.source.index]
            : node.source.kind === 'page'
              ? { pageId: node.source.pageId, region: null }
              : node.source.kind === 'part' && bindings.session !== undefined
                ? partRefs(environment, node.source.partId)[0]
                : undefined
    if (source === undefined || bindings.session === undefined) return null
    const content = (
        <View
            nativeID={marked(environment, path)}
            testID="guide-hero-frame"
            style={styles.stack}
            {...(node.ratio === 'hero' ? swipe.panHandlers : {})}
        >
            <StepPicture
                reference={source}
                session={bindings.session}
                pageUris={bindings.pageUris}
                height={node.ratio === 'hero' ? 340 : node.ratio === 'tall' ? 360 : node.ratio === 'square' ? 280 : 200}
                cover={node.fit === 'cover'}
                testID="guide-hero-picture"
            />
            {node.caption === null ? null : <Caption>{documentText(document, bindings, node.caption)}</Caption>}
        </View>
    )
    return node.ratio === 'hero' ? (
        <CoachTarget id="guide-hero" label="Manual picture">
            <CoachTarget id="guide-hero-frame" label="Manual picture">
                {content}
            </CoachTarget>
        </CoachTarget>
    ) : (
        content
    )
}

function Disclosure({
    title,
    initiallyOpen,
    forced,
    children,
    mark,
}: {
    title: string
    initiallyOpen: boolean
    forced?: boolean
    children: ReactNode
    mark: string
}): ReactElement {
    const [open, setOpen] = useState(initiallyOpen)
    return (
        <View nativeID={mark} style={styles.stack}>
            <Pressable
                testID="fact-source"
                accessibilityRole="button"
                accessibilityLabel={title}
                accessibilityState={{ expanded: open || forced === true }}
                disabled={forced}
                onPress={(): void => setOpen(!open)}
                style={styles.touch}
            >
                <Heading>{title}</Heading>
            </Pressable>
            {open || forced === true ? children : null}
        </View>
    )
}

/** A photo identity is the whole issued capture binding, including the manual revision and step. */
function captureMatchesDocument(document: ScreenDocumentV2, capture: FrameBindings['capture']): boolean {
    return (
        capture !== null &&
        capture.binding.manualId === document.bound.manualId &&
        capture.binding.revision === document.bound.revision &&
        capture.binding.stepId === document.bound.stepId &&
        capture.binding.captureId === document.bound.captureId
    )
}

function Photo({
    environment,
    caption,
    mark,
    fit,
    ratio,
}: {
    environment: Environment
    caption: string
    mark: string
    fit: 'cover' | 'contain'
    ratio: 'hero' | 'wide' | 'square' | 'tall'
}): ReactElement | null {
    const { reduceMotion } = useFeedback()
    const capture = environment.bindings.capture
    const matches = captureMatchesDocument(environment.document, capture)
    const photoIdentity = matches && capture !== null ? JSON.stringify(capture.binding) : null
    const [frameLayout, setFrameLayout] = useState<{ identity: string | null; width: number } | null>(null)
    const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
    const width = frameLayout?.identity === photoIdentity ? (frameLayout?.width ?? 0) : 0
    const imageLoaded = photoIdentity !== null && loadedIdentity === photoIdentity
    useLayoutEffect(() => {
        setLoadedIdentity(null)
        setFrameLayout(null)
    }, [photoIdentity])
    useEffect(() => {
        if (matches && imageLoaded && width > 0) environment.loaded()
    }, [matches, imageLoaded, width, environment.loaded])
    if (capture === null || !matches) return null
    const observation = capture.observation
    const height =
        width === 0
            ? 240
            : ratio === 'wide'
              ? (width * 9) / 16
              : ratio === 'square'
                ? width
                : ratio === 'tall'
                  ? (width * 4) / 3
                  : 340
    const check = environment.showRegions ? environment.bindings.live?.state.check : null
    const live = environment.bindings.live
    const canPoint =
        environment.bindings.readOnly !== true &&
        environment.document.kind === 'questions' &&
        live !== null &&
        live.state.pending === null &&
        capture.reusable
    const selectedPoint =
        environment.document.kind === 'questions' && live?.state.target?.kind === 'point' ? live.state.target : null
    const protectedRegions = [
        check?.observedRegion,
        check?.targetRegion?.region,
        check?.nextPartRegion?.region,
    ].flatMap((region) => (region == null ? [] : [region]))
    const displayed =
        fit === 'cover'
            ? heroImageRect({ width, height }, observation, protectedRegions)
            : containRect({ width, height }, observation)
    return (
        <View nativeID={mark} testID="guide-hero" style={styles.stack}>
            <Pressable
                testID="frozen-photo-frame"
                accessibilityRole={canPoint ? 'button' : 'image'}
                accessibilityLabel={
                    canPoint
                        ? 'Choose a point in your photo. Double tap to choose the middle.'
                        : caption || 'Your held build photo'
                }
                onAccessibilityTap={(): void => {
                    if (canPoint) live.controller.targetChanged({ kind: 'point', x: 0.5, y: 0.5 })
                }}
                onPress={(event): void => {
                    if (!canPoint || displayed.width <= 0 || displayed.height <= 0) return
                    const tap = extractTapCoordinates(event)
                    if (tap === null) return
                    const x = (tap.x - displayed.x) / displayed.width
                    const y = (tap.y - displayed.y) / displayed.height
                    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) live.controller.targetChanged({ kind: 'point', x, y })
                }}
                onLayout={(event): void =>
                    setFrameLayout({ identity: photoIdentity, width: event.nativeEvent.layout.width })
                }
                style={{ height, overflow: 'hidden' }}
            >
                <View nativeID={originId('shell')} style={StyleSheet.absoluteFill}>
                    <Image
                        nativeID={capability('ManualPage')}
                        testID="frozen-photo-image"
                        source={{ uri: bytesToDataUri(observation.bytes, observation.mimeType) }}
                        resizeMode="stretch"
                        accessibilityLabel={caption || 'Your held build photo'}
                        onLoad={(): void => setLoadedIdentity(photoIdentity)}
                        style={{
                            position: 'absolute',
                            left: displayed.x,
                            top: displayed.y,
                            width: displayed.width,
                            height: displayed.height,
                        }}
                    />
                </View>
                {selectedPoint === null &&
                (!environment.showRegions || environment.bindings.marks.length === 0) &&
                check?.observedRegion == null &&
                check?.targetRegion == null &&
                check?.nextPartRegion == null ? null : (
                    <View nativeID={originId('shell')} pointerEvents="none" style={StyleSheet.absoluteFill}>
                        {/* Result-proposed region geometry remains counted in every denominator. */}
                        <View style={StyleSheet.absoluteFill}>
                            <Svg width="100%" height="100%">
                                {selectedPoint === null ? null : (
                                    <>
                                        <Circle
                                            cx={displayed.x + selectedPoint.x * displayed.width}
                                            cy={displayed.y + selectedPoint.y * displayed.height}
                                            r={12}
                                            fill="none"
                                            stroke={lightColors.inkInverse}
                                            strokeWidth={8}
                                        />
                                        <Circle
                                            testID="question-point"
                                            cx={displayed.x + selectedPoint.x * displayed.width}
                                            cy={displayed.y + selectedPoint.y * displayed.height}
                                            r={12}
                                            fill="none"
                                            stroke={lightColors.accent}
                                            strokeWidth={4}
                                        />
                                    </>
                                )}
                                {check?.observedRegion == null ? null : (
                                    <GroundedRegionOutline rect={boxOnDisplay(check.observedRegion, displayed)} />
                                )}
                                {check?.targetRegion == null ? null : (
                                    <GroundedRegionOutline rect={boxOnDisplay(check.targetRegion.region, displayed)} />
                                )}
                                {check?.nextPartRegion == null ? null : (
                                    <GroundedRegionOutline
                                        rect={boxOnDisplay(check.nextPartRegion.region, displayed)}
                                    />
                                )}
                                <SegmentMasks
                                    marks={environment.showRegions ? environment.bindings.marks : []}
                                    displayed={displayed}
                                    reduceMotion={reduceMotion}
                                />
                            </Svg>
                        </View>
                    </View>
                )}
            </Pressable>
            {caption === '' ? null : <Caption>{caption}</Caption>}
        </View>
    )
}

function Sources({
    node,
    environment,
    path,
}: {
    node: Extract<ScreenNodeV2, { type: 'Citation' | 'ManualPage' }>
    environment: Environment
    path: string
}): ReactElement | null {
    const session = environment.bindings.session
    if (session === undefined) return null
    const refs = [...new Set(node.sources)].flatMap((index) => {
        const source = environment.document.sources[index]
        return source === undefined ? [] : [source]
    })
    if (refs.length === 0) return null
    if (node.type === 'Citation' && node.display === 'thumbnail')
        return (
            <View nativeID={marked(environment, path)} style={styles.stack}>
                {node.label === null ? null : (
                    <Caption>{documentText(environment.document, environment.bindings, node.label)}</Caption>
                )}
                <SourceDiagrams refs={refs} session={session} pageUris={environment.bindings.pageUris} fit="page" />
            </View>
        )
    return (
        <Disclosure
            title={documentText(environment.document, environment.bindings, node.label) || 'See it in the manual'}
            initiallyOpen={node.type === 'ManualPage' && node.initiallyOpen}
            mark={marked(environment, path)}
        >
            <SourceDiagrams
                refs={refs}
                session={session}
                pageUris={environment.bindings.pageUris}
                fit={node.type === 'ManualPage' && node.fit === 'cover' ? 'frame' : 'page'}
            />
        </Disclosure>
    )
}

/** The result's own native capability: exact held output, its evidence and a once-only accepted result reveal. */
function Verdict({
    node,
    environment,
    path,
}: {
    node: Extract<ScreenNodeV2, { type: 'VerdictCard' }>
    environment: Environment
    path: string
}): ReactElement | null {
    const { document, bindings } = environment
    const live = bindings.live
    const result = node.result === 'check' ? live?.state.check : live?.state.answer
    const resultFactId = node.result === 'check' ? 'result:verdict' : 'result:answer'
    const visible =
        result != null &&
        document.requirements.capture &&
        bindings.capture?.reusable === true &&
        environment.photoLoaded &&
        document.facts.some(
            (fact) =>
                fact.factId === resultFactId &&
                fact.basis === 'result' &&
                fact.text === ('reason' in result ? result.reason : result.answer),
        )
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const { hapticOnce } = useFeedback()
    const identity = `${node.result}:${document.bound.manualId}:${document.bound.captureId}:${result == null ? '' : 'reason' in result ? result.reason : result.answer}`
    const reveal = useIconReveal(identity, visible && scope.active && !attention && bindings.workInProgress !== true)
    useEffect(() => {
        if (visible && result != null && bindings.workInProgress !== true)
            hapticOnce(
                identity,
                'decision' in result ? (result.decision === 'pass' ? 'success' : 'warning') : 'selection',
            )
    }, [visible, result, identity, bindings.workInProgress, hapticOnce])
    if (!visible || result == null) return null
    const content = (
        <>
            {'decision' in result ? (
                <Animated.View style={reveal}>
                    <VerdictTag verdict={result.decision} />
                </Animated.View>
            ) : null}
            {node.showReason ? <Instruction>{'reason' in result ? result.reason : result.answer}</Instruction> : null}
            {result.missingEvidence.map((missing, index) => (
                <Caption key={index}>{missing}</Caption>
            ))}
            <Sources
                node={{
                    type: 'Citation',
                    sources: document.metadata.sourceMap[path] ?? [],
                    label: null,
                    display: 'chip',
                }}
                environment={environment}
                path={path}
            />
        </>
    )
    return node.variant === 'card' ? (
        <Card testID={`document-${node.result}-result`} nativeID={marked(environment, path)} tone="result">
            <View accessibilityLiveRegion="polite" style={styles.stack}>
                {content}
            </View>
        </Card>
    ) : (
        <View
            testID={`document-${node.result}-result`}
            nativeID={marked(environment, path)}
            accessibilityLiveRegion="polite"
            style={styles.stack}
        >
            {content}
        </View>
    )
}

/** Intrinsic PageList editing mechanics; no independent legacy page/editor screen is embedded. */
function Pages({
    node,
    environment,
    path,
}: {
    node: Extract<ScreenNodeV2, { type: 'PageList' }>
    environment: Environment
    path: string
}): ReactElement | null {
    const [selected, select] = useState<string | null>(null)
    const context = contextOf(environment)
    const live = context.live
    const session = environment.bindings.session
    if (live === null || session === undefined) return null
    const index = session.pages.findIndex((page) => page.pageId === selected)
    const page = session.pages[index]
    const blocked = environment.bindings.readOnly === true || live.state.pending !== null || live.state.storageReadOnly
    return (
        <View nativeID={marked(environment, path)} style={styles.stack}>
            <PageGalleryBlock
                node={{
                    type: 'PageGallery',
                    pages: 'session',
                    layout: node.layout,
                    showNumbers: node.showNumbers,
                    action: null,
                }}
                context={{ ...context, live: { ...live, pages: { open: select, arriving: new Set() } } }}
                path={path}
            />
            {page === undefined ? null : (
                <View nativeID={originId('shell')} style={styles.stack}>
                    <Heading>{`Page ${index + 1}`}</Heading>
                    <StepPicture
                        reference={{ pageId: page.pageId, region: null }}
                        session={session}
                        pageUris={environment.bindings.pageUris}
                        height={280}
                    />
                    <AppButton
                        label="Retake page"
                        disabled={blocked}
                        onPress={(): void => {
                            if (!blocked) live.controller.camera({ kind: 'page', replaceIndex: index })
                        }}
                    />
                    <AppButton
                        label="Move page up"
                        variant="quiet"
                        disabled={blocked || index === 0}
                        onPress={(): void => {
                            if (!blocked) void live.controller.editPage(index, 'up')
                        }}
                    />
                    <AppButton
                        label="Move page down"
                        variant="quiet"
                        disabled={blocked || index >= session.pages.length - 1}
                        onPress={(): void => {
                            if (!blocked) void live.controller.editPage(index, 'down')
                        }}
                    />
                    <AppButton
                        label="Remove page"
                        variant="quiet"
                        disabled={blocked}
                        onPress={(): void => {
                            if (!blocked) void live.controller.editPage(index, 'remove').then(() => select(null))
                        }}
                    />
                    <AppButton label="Close page" variant="quiet" onPress={(): void => select(null)} />
                </View>
            )}
        </View>
    )
}

function Judge({
    environment,
    panel,
    mark,
}: {
    environment: Environment
    panel: 'about-check' | 'built-view' | 'stages'
    mark: string
}): ReactElement | null {
    const judge = useJudge()
    const meter = useMeterReading()
    const [details, setDetails] = useState(false)
    const metadata = environment.document.metadata
    if (panel === 'about-check')
        return (
            <View nativeID={mark}>
                <CompareManualsRow />
            </View>
        )
    if (!judge.showBuilt) return null
    if (panel === 'stages')
        return (
            <View nativeID={mark}>
                <StagesPanel
                    check={environment.bindings.live?.state.check ?? null}
                    stages={environment.bindings.live?.state.stages ?? null}
                    resultSlot={undefined}
                    resultDocument={environment.bindings.resultDocument}
                    resultArrivedAt={environment.bindings.resultArrivedAt}
                />
            </View>
        )
    return (
        <View nativeID={mark} testID="judge-summary" style={styles.judge}>
            <Heading>How this screen was built</Heading>
            <Caption>
                {metadata.evidence === 'synthetic-fixture'
                    ? 'Simulated fixture composition · no model call'
                    : metadata.source === 'generated'
                      ? 'Composed by Meta AI'
                      : 'App fallback composition'}
            </Caption>
            <Caption>{`UI count: ${meter.snapshot?.latest?.status === 'measured' ? `${(meter.snapshot.latest.generatedShare * 100).toFixed(1)}%${meter.snapshot.stale ? ' (screen changed)' : ''}` : 'Not recorded'} · session ${meter.session?.status === 'measured' ? `${(meter.session.generatedShare * 100).toFixed(1)}%` : 'Not recorded'}`}</Caption>
            <AppButton
                label={details ? 'Hide details' : 'Details'}
                testID="judge-summary-details"
                variant="quiet"
                onPress={(): void => setDetails(!details)}
            />
            {details ? (
                <View testID="judge-details" style={styles.stack}>
                    <Caption>{`Source: ${metadata.source}`}</Caption>
                    <Caption>{`Evidence: ${metadata.evidence === 'synthetic-fixture' ? 'Simulated fixture · no model call' : metadata.evidence}`}</Caption>
                    <Caption>{`Model: ${metadata.evidence === 'synthetic-fixture' ? 'Not recorded' : (metadata.model ?? 'Not recorded')}`}</Caption>
                    <Caption>{`Effort: ${metadata.evidence === 'synthetic-fixture' ? 'Not recorded' : (metadata.effort ?? 'Not recorded')}`}</Caption>
                    {Object.entries(metadata.timing).map(([key, value]) => (
                        <Caption
                            key={key}
                        >{`${TIMING_LABELS[key as keyof typeof TIMING_LABELS]}: ${value === null ? 'Not recorded' : `${value} ms`}`}</Caption>
                    ))}
                    {Object.entries(metadata.usage).map(([key, value]) => (
                        <Caption
                            key={key}
                        >{`${USAGE_LABELS[key as keyof typeof USAGE_LABELS]}: ${value === null ? 'Not recorded' : value}`}</Caption>
                    ))}
                    {metadata.fallbackReason === null ? null : (
                        <Caption>{`Fallback: ${metadata.fallbackReason}`}</Caption>
                    )}
                    <Caption>{`Repaired: ${metadata.repaired ? 'yes' : 'no'}`}</Caption>
                    <Caption>{`Cache hit: ${metadata.cacheHit ? 'yes' : 'no'}`}</Caption>
                    <Coverage />
                    <CompareManualsRow />
                    <StagesPanel
                        check={environment.bindings.live?.state.check ?? null}
                        stages={environment.bindings.live?.state.stages ?? null}
                        resultSlot={undefined}
                        resultDocument={environment.bindings.resultDocument}
                        resultArrivedAt={environment.bindings.resultArrivedAt}
                    />
                </View>
            ) : null}
        </View>
    )
}

/** Measured device counts only, with all three denominators and the explicit exclusion audit. */
function Coverage(): ReactElement {
    const meter = useMeterReading()
    const latest = meter.snapshot?.latest
    const percent = (value: number | null | undefined): string =>
        value == null ? 'Not recorded' : `${(value * 100).toFixed(2)}%`
    return (
        <View style={styles.stack}>
            <Caption>{`This screen, all hosts: ${percent(latest?.generatedShare)}`}</Caption>
            <Caption>{`Session, all hosts: ${percent(meter.session?.generatedShare)}`}</Caption>
            <Caption>{`Mean across routes: ${percent(meter.session?.meanRouteGeneratedShare)}`}</Caption>
            <Caption>{`Session, excluding declared native internals: ${percent(meter.session?.strictGeneratedShare)}`}</Caption>
            <Caption>
                {latest == null
                    ? 'Not counted on this device.'
                    : latest.status === 'measured'
                      ? `Counted ${new Date(latest.sampledAt).toLocaleTimeString()}. ${meter.snapshot?.stale === true ? 'Screen changed since count.' : 'Current checkpoint.'}`
                      : `Count unavailable: ${latest.reason}`}
            </Caption>
            {meter.session?.exclusions == null ? null : (
                <Caption>{`Excluded development hosts: ${meter.session.exclusions.development.counts.total}; declared capability internals: ${meter.session.exclusions.capabilityInternals.counts.total}.`}</Caption>
            )}
            <Caption>
                Counts the registered React Native host tree, including navigation roots. Physical system views are
                outside this scope.
            </Caption>
            <AppButton testID="judge-measure" label="Count again" variant="quiet" onPress={meter.measureNow} />
        </View>
    )
}

/**
 * One known part in the catalog. A picture is drawn only from the part's own cited figure region; a part cited
 * without a region never borrows the whole manual page as its thumbnail. Its name and count stay, with its own
 * cited page one tap away through the same source disclosure as a fact citation.
 */
function PieceTile({
    node,
    environment,
    path,
}: {
    node: Extract<ScreenNodeV2, { type: 'PieceTile' }>
    environment: Environment
    path: string
}): ReactElement | null {
    const [open, setOpen] = useState(false)
    const { document, bindings } = environment
    const facts = screenFacts(bindings.session ?? null)
    const part = facts?.parts.find((item) => item.partId === node.partId)
    const refs = partRefs(environment, node.partId)
    if (part === undefined) return null
    const session = bindings.session
    const grounded = refs.find((ref) => ref.region != null)
    const label = part.name.state === 'known' ? part.name.value : 'Part'
    return (
        <View nativeID={marked(environment, path)} testID={`part-tile-${node.partId}`} style={styles.stack}>
            {grounded === undefined || session === undefined ? null : (
                <StepPicture
                    reference={grounded}
                    session={session}
                    pageUris={bindings.pageUris}
                    height={node.size === 'sm' ? 100 : node.size === 'lg' ? 220 : 160}
                    testID={`part-hero-${node.partId}`}
                />
            )}
            <StatusTag label={label} />
            {node.showQuantity
                ? facts?.steps
                      .find((step) => step.stepId === document.bound.stepId)
                      ?.parts.filter((item) => item.partId === part.partId && item.quantity.state === 'known')
                      .map((item) => (
                          <Caption key={item.partId}>
                              {item.quantity.state === 'known' ? `× ${item.quantity.value}` : ''}
                          </Caption>
                      ))
                : null}
            {grounded !== undefined || refs.length === 0 || session === undefined ? null : (
                <>
                    <Pressable
                        testID="fact-source"
                        accessibilityRole="button"
                        accessibilityLabel={open ? `Hide the manual page: ${label}` : `See it in the manual: ${label}`}
                        accessibilityState={{ expanded: open }}
                        onPress={(): void => setOpen(!open)}
                        style={styles.touch}
                    >
                        <Caption>{open ? 'Hide the manual page' : 'See it in the manual'}</Caption>
                    </Pressable>
                    {open ? (
                        <SourceDiagrams refs={refs} session={session} pageUris={bindings.pageUris} fit="page" />
                    ) : null}
                </>
            )}
        </View>
    )
}

type NodeProps = { node: ScreenNodeV2; environment: Environment; path: string }

function Node(props: NodeProps): ReactElement {
    const [showSource, setShowSource] = useState(false)
    if (props.environment.omittedDuplicates.has(props.path)) return <></>
    if (!props.environment.bindings.inspect) return <NodeContent {...props} />
    return (
        <View
            nativeID={originId('shell')}
            style={
                props.node.type === 'Scroll' && props.path === `${props.environment.prefix}body`
                    ? styles.grow
                    : undefined
            }
            accessible={false}
            onTouchEnd={(event): void => {
                event.stopPropagation()
                setShowSource(!showSource)
            }}
        >
            <NodeContent {...props} />
            {showSource ? (
                <Caption>{`${props.node.type} · ${props.environment.document.metadata.origins[props.path] ?? 'fallback'}`}</Caption>
            ) : null}
        </View>
    )
}

function NodeContent({
    node,
    environment,
    path,
}: {
    node: ScreenNodeV2
    environment: Environment
    path: string
}): ReactElement | null {
    const { colors } = useTheme()
    const { document, bindings } = environment
    const mark = marked(environment, path)
    const text = (ref: TextRefV2 | null): string => documentText(document, bindings, ref)
    const children =
        'children' in node
            ? node.children.map((child, index) => (
                  <Node key={index} node={child} environment={environment} path={`${path}.${index}`} />
              ))
            : null
    const context = contextOf(environment)
    const live = bindings.live
    const facts = screenFacts(bindings.session ?? null)
    const targetStep = facts?.steps.find((step) => step.stepId === document.bound.stepId)
    switch (node.type) {
        case 'Stack':
            return (
                <View nativeID={mark} style={{ gap: gap(node.gap), alignItems: align[node.align] }}>
                    {children}
                </View>
            )
        case 'Row':
            return (
                <View
                    nativeID={mark}
                    style={{
                        flexDirection: 'row',
                        gap: gap(node.gap),
                        alignItems: align[node.align],
                        justifyContent: node.justify === 'between' ? 'space-between' : align[node.justify],
                        flexWrap: node.wrap ? 'wrap' : 'nowrap',
                    }}
                >
                    {node.children.map((child, index) => (
                        <View
                            key={index}
                            style={{
                                minWidth: 0,
                                flexShrink: 1,
                                ...(['Image', 'ManualPage', 'Card', 'PageList', 'CompareColumns'].includes(child.type)
                                    ? { flex: 1 }
                                    : {}),
                            }}
                        >
                            <Node node={child} environment={environment} path={`${path}.${index}`} />
                        </View>
                    ))}
                </View>
            )
        case 'Grid':
            return (
                <View nativeID={mark} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: gap(node.gap) }}>
                    {node.children.map((child, index) => (
                        <View key={index} style={{ flexBasis: `${100 / node.columns - 3}%`, flexGrow: 1 }}>
                            <Node node={child} environment={environment} path={`${path}.${index}`} />
                        </View>
                    ))}
                </View>
            )
        case 'Card':
            return (
                <View
                    nativeID={mark}
                    style={{
                        gap: space.sm,
                        padding: gap(node.padding),
                        borderRadius: radius.lg,
                        backgroundColor:
                            node.surface === 'raised'
                                ? colors.surfaceRaised
                                : node.surface === 'tinted'
                                  ? node.tone === 'critical'
                                      ? colors.refuseSurface
                                      : node.tone === 'caution'
                                        ? colors.cautionSurface
                                        : node.tone === 'success'
                                          ? colors.passSurface
                                          : colors.surfaceSunken
                                  : colors.canvas,
                    }}
                >
                    {children}
                </View>
            )
        case 'Section':
            return node.collapsible ? (
                <Disclosure
                    title={text(node.title)}
                    initiallyOpen={node.initiallyOpen}
                    forced={containsSafety(node, document)}
                    mark={mark}
                >
                    {children}
                </Disclosure>
            ) : (
                <View nativeID={mark} style={styles.stack}>
                    {node.title === null ? null : <Heading>{text(node.title)}</Heading>}
                    {children}
                </View>
            )
        case 'Scroll':
            return (
                <ScrollView
                    nativeID={mark}
                    horizontal={node.axis === 'horizontal'}
                    style={path === `${environment.prefix}body` ? styles.grow : undefined}
                    contentContainerStyle={
                        node.axis === 'horizontal'
                            ? styles.row
                            : { gap: space.sm, padding: path === `${environment.prefix}body` ? space.md : 0 }
                    }
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                    contentInsetAdjustmentBehavior="never"
                >
                    {children}
                    {path === `${environment.prefix}body` ? environment.trailing : null}
                </ScrollView>
            )
        case 'Divider':
            return (
                <View
                    nativeID={mark}
                    style={{
                        height: StyleSheet.hairlineWidth,
                        marginHorizontal: node.inset ? space.md : 0,
                        backgroundColor: colors.border,
                    }}
                />
            )
        case 'Spacer':
            return <View nativeID={mark} style={{ height: gap(node.size) }} />
        case 'Text': {
            const Typography = {
                display: LargeTitle,
                title: Title,
                heading: Heading,
                body: node.emphasis === 'strong' ? Instruction : Body,
                label: Label,
                caption: Caption,
            }[node.role]
            return (
                <View nativeID={mark} style={{ alignItems: node.align === 'start' ? 'stretch' : align[node.align] }}>
                    <Typography
                        tone={
                            node.emphasis === 'quiet' && node.tone === 'neutral'
                                ? 'muted'
                                : (tone[node.tone] as TextTone)
                        }
                        style={{
                            textAlign: node.align === 'start' ? 'left' : node.align === 'end' ? 'right' : 'center',
                        }}
                    >
                        {text(node.content)}
                    </Typography>
                </View>
            )
        }
        case 'Icon':
            return (
                <View nativeID={mark}>
                    <Icon
                        name={node.name}
                        size={node.size === 'sm' ? 'sm' : 'md'}
                        color={
                            node.tone === 'critical'
                                ? colors.refuse
                                : node.tone === 'caution'
                                  ? colors.caution
                                  : node.tone === 'success'
                                    ? colors.pass
                                    : node.tone === 'info'
                                      ? colors.accentInk
                                      : colors.ink
                        }
                    />
                </View>
            )
        case 'Badge':
            return (
                <StatusTag
                    nativeID={mark}
                    label={text(node.label)}
                    tone={
                        node.tone === 'info'
                            ? 'accent'
                            : node.tone === 'success'
                              ? 'pass'
                              : node.tone === 'critical'
                                ? 'refuse'
                                : node.tone
                    }
                />
            )
        case 'Checklist':
            return (
                <View nativeID={mark} style={styles.stack}>
                    {node.items.map((item, index) => (
                        <View key={index} style={styles.row}>
                            <Icon name={item.state === 'done' ? 'check' : 'info'} />
                            <Body>{text(item.label)}</Body>
                        </View>
                    ))}
                </View>
            )
        case 'Citation':
        case 'ManualPage':
            return <Sources node={node} environment={environment} path={path} />
        case 'Image': {
            if (node.source.kind === 'capture')
                return (
                    <Photo
                        key={document.bound.captureId}
                        environment={environment}
                        caption={text(node.caption)}
                        mark={mark}
                        fit={node.fit}
                        ratio={node.ratio}
                    />
                )
            return <ReferenceImage node={node} environment={environment} path={path} />
        }
        case 'Progress':
        case 'Meter': {
            if (node.binding === 'review')
                return live?.quick === undefined || live.quick.current === undefined ? null : (
                    <ProgressBar
                        nativeID={mark}
                        label={text(node.label) || live.quick.label || ''}
                        value={live.quick.position}
                        total={live.quick.total}
                    />
                )
            if (node.binding === 'reading' || node.binding === 'pages-read')
                return <ReadingProgress environment={environment} label={text(node.label)} mark={mark} />
            const entry = live?.entry
            const pages = node.binding === 'pages'
            const total = pages ? (bindings.session?.pages.length ?? 0) : (facts?.steps.length ?? 0)
            const completed = pages
                ? (bindings.session?.pages.length ?? 0)
                : node.binding === 'step'
                  ? (facts?.steps.findIndex((step) => step.stepId === document.bound.stepId) ?? -1) + 1
                  : facts?.reviewed === true
                    ? (entry?.completedStepIds.length ?? 0)
                    : 0
            return total === 0 ? (
                <Caption nativeID={mark}>{text(node.label)}</Caption>
            ) : (
                <ProgressBar
                    nativeID={mark}
                    label={text(node.label) || `${completed} of ${total}`}
                    value={completed}
                    total={total}
                />
            )
        }
        case 'Stepper':
            return (
                <View nativeID={mark} style={styles.stack}>
                    {node.label === null ? null : <Heading>{text(node.label)}</Heading>}
                    {node.binding === 'steps' && live !== null
                        ? facts?.steps.map((step, index) => (
                              <AppButton
                                  key={step.stepId}
                                  label={step.title}
                                  variant={document.bound.stepId === step.stepId ? 'secondary' : 'quiet'}
                                  disabled={
                                      live.state.pending !== null ||
                                      bindings.readOnly === true ||
                                      live.state.storageReadOnly ||
                                      bindings.session?.reviewStatus !== 'reviewed'
                                  }
                                  onPress={(): void => {
                                      if (
                                          bindings.readOnly !== true &&
                                          live.state.pending === null &&
                                          !live.state.storageReadOnly &&
                                          bindings.session?.reviewStatus === 'reviewed'
                                      )
                                          void live.controller.step(index)
                                  }}
                              />
                          ))
                        : null}
                    {node.binding === 'pages' ? (
                        <PageGalleryBlock
                            node={{
                                type: 'PageGallery',
                                pages: 'session',
                                layout: 'list',
                                showNumbers: true,
                                action: null,
                            }}
                            context={context}
                            path={path}
                        />
                    ) : null}
                </View>
            )
        case 'PrimaryAction':
        case 'SecondaryAction':
            return <Action action={node} environment={environment} path={path} />
        case 'Toggle': {
            const toggle = bindings.toggles?.[node.binding]
            return (
                <View nativeID={mark}>
                    {toggle === undefined ? (
                        <Caption>{text(node.label)}</Caption>
                    ) : (
                        <SettingRow
                            testID={node.binding === 'built-view' ? 'judge-built-toggle' : undefined}
                            label={text(node.label)}
                            value={toggle.value}
                            disabled={bindings.readOnly === true}
                            onValueChange={(value): void => {
                                if (bindings.readOnly !== true) toggle.onChange(value)
                            }}
                        />
                    )}
                </View>
            )
        }
        case 'Choice':
            return (
                <View nativeID={mark} style={styles.stack}>
                    {node.prompt === null ? null : <Heading>{text(node.prompt)}</Heading>}
                    {node.options.mode === 'intents' ? (
                        node.options.items.map((item, index) => (
                            <Action
                                key={index}
                                action={{ label: item.label, icon: null, intent: item.intent }}
                                environment={environment}
                                path={path}
                            />
                        ))
                    ) : node.options.binding === 'part-target' &&
                      bindings.session !== undefined &&
                      facts?.reviewed === true &&
                      targetStep !== undefined &&
                      live?.entry !== undefined ? (
                        stepPartChoices(bindings.session, targetStep).map((part) => (
                            <AppButton
                                key={part.partId}
                                label={part.label}
                                variant={
                                    live.state.target?.kind === 'part' && live.state.target.partId === part.partId
                                        ? 'secondary'
                                        : 'quiet'
                                }
                                disabled={bindings.readOnly === true || live.state.pending !== null}
                                onPress={(): void => {
                                    if (bindings.readOnly !== true && live.state.pending === null)
                                        live.controller.targetChanged({ kind: 'part', partId: part.partId })
                                }}
                            />
                        ))
                    ) : node.options.mode === 'bound' &&
                      node.options.binding === 'language' &&
                      bindings.language !== undefined ? (
                        <SegmentedControl
                            label={text(node.prompt) || 'Read in'}
                            options={[
                                { value: 'en', label: 'English' },
                                { value: 'es', label: 'Spanish' },
                                { value: 'fr', label: 'French' },
                                { value: 'de', label: 'German' },
                                { value: 'pt-BR', label: 'Portuguese' },
                            ]}
                            value={bindings.language.value}
                            disabled={bindings.readOnly === true}
                            onChange={(value): void => {
                                if (bindings.readOnly !== true) bindings.language?.onChange(value)
                            }}
                        />
                    ) : null}
                </View>
            )
        case 'ManualList':
            return (
                <ManualLibraryBlock
                    node={{ ...node, type: 'ManualLibrary', emptyText: null }}
                    context={
                        context.live === null
                            ? context
                            : {
                                  ...context,
                                  live: {
                                      ...context.live,
                                      state: {
                                          ...context.live.state,
                                          entries: context.live.state.entries.map((entry) => ({
                                              ...entry,
                                              session: { ...entry.session, title: manualDisplayTitle(entry.session) },
                                          })),
                                      },
                                  },
                              }
                    }
                    path={path}
                />
            )
        case 'PageList':
            return <Pages node={node} environment={environment} path={path} />
        case 'FactEditor':
            return <FactEditorBlock node={{ ...node, questionRef: 'current' }} context={context} path={path} />
        case 'TextField':
            return (
                <View nativeID={mark}>
                    {node.binding === 'question' && live !== null ? (
                        <TextField
                            label={text(node.label)}
                            placeholder={node.placeholder ?? undefined}
                            value={live.state.question}
                            onChangeText={(value): void => {
                                if (bindings.readOnly !== true && live.state.pending === null)
                                    live.controller.questionChanged(value)
                            }}
                            editable={bindings.readOnly !== true && live.state.pending === null}
                            multiline
                        />
                    ) : (
                        <Caption>{text(node.label)}</Caption>
                    )}
                </View>
            )
        case 'PieceTile':
            return <PieceTile node={node} environment={environment} path={path} />
        case 'VerdictCard': {
            return <Verdict node={node} environment={environment} path={path} />
        }
        case 'CameraView':
            return (
                <View nativeID={mark} style={styles.stack}>
                    <Instruction>{node.cue}</Instruction>
                    {node.pill === null ? null : <StatusTag label={node.pill} />}
                    <View style={styles.camera}>{bindings.camera?.preview}</View>
                </View>
            )
        case 'JudgePanel':
            return <Judge environment={environment} panel={node.panel} mark={mark} />
        case 'CompareColumns':
            return <View nativeID={mark}>{bindings.compare}</View>
        case 'CoachMark':
            return null
    }
}

/** Direct v2 renderer: the selected document supplies the full header, body, bar and overlays without v1 conversion. */
export function NativeDocumentRenderer({
    document,
    bindings,
    variant = 'ready',
    chrome = 'full',
    testID = 'document-screen',
}: {
    document: ScreenDocumentV2
    bindings: FrameBindings
    variant?: string
    chrome?: 'full' | 'body-only'
    testID?: string
}): ReactElement {
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const mayMove = bindings.workInProgress !== true && scope.active && !attention
    const previousStep = useRef(bindings.live?.entry?.stepIndex ?? 0)
    const stepIndex = bindings.live?.entry?.stepIndex ?? 0
    const direction = stepIndex >= previousStep.current ? 1 : -1
    useEffect(() => {
        previousStep.current = stepIndex
    }, [stepIndex])
    const stepMotion = useStepTransition(`${document.bound.manualId}:${document.bound.stepId}`, direction, mayMove)
    // A new workflow page starts at the top. Variants, local disclosures and later compositions keep their scroller.
    const bodyPage = JSON.stringify([
        document.kind,
        document.bound.manualId,
        document.bound.stepId,
        document.kind === 'result' || document.kind === 'answer' ? document.bound.captureId : null,
    ])
    const [loadedCapture, setLoadedCapture] = useState<string | null>(null)
    const matchesCapture = captureMatchesDocument(document, bindings.capture)
    const expectedPhoto =
        matchesCapture && bindings.capture !== null
            ? JSON.stringify([document.screenId, bindings.capture.binding, bindings.inspect])
            : null
    useLayoutEffect(() => {
        setLoadedCapture(null)
    }, [expectedPhoto])
    const variants = variantsOfV2(document)
    const wanted = variants.find((item) => item.name === variant) ?? variants[0]!
    const heldReady =
        matchesCapture &&
        loadedCapture !== null &&
        loadedCapture === expectedPhoto &&
        (!document.requirements.capture || bindings.capture?.reusable === true)
    const gatePhoto = wanted.name === 'ready' && document.requirements.capture && !heldReady
    const selected = gatePhoto ? variants.find((item) => item.name === 'pending')! : wanted
    const fade = useContentFade(`${document.screenId}:${selected.name}`, mayMove)
    const environment: Environment = {
        document,
        bindings,
        prefix: selected.prefix,
        photoLoaded: heldReady,
        showRegions: false,
        loaded: (): void => setLoadedCapture(expectedPhoto),
        omittedDuplicates: duplicateFactPaths(selected.variant.body, `${selected.prefix}body`),
        trailing: null,
    }
    const findRegions = (node: ScreenNodeV2): boolean =>
        node.type === 'VerdictCard' ? node.showRegions : 'children' in node && node.children.some(findRegions)
    environment.showRegions = findRegions(selected.variant.body)
    environment.trailing =
        bindings.inspect && document.kind !== 'judge' ? (
            <Judge environment={environment} panel="built-view" mark={originId('shell')} />
        ) : null
    const action = (
        node: Omit<ScreenVariantV2['bar']['primary'], 'type'>,
        role: 'primary' | 'secondary',
    ): BarAction => {
        const resolved = bindings.resolve(node.intent)
        const isCamera = document.kind === 'camera' && node.intent.intent === 'capture'
        return {
            label: node.label,
            accessibilityLabel: node.label,
            icon: node.icon ?? undefined,
            onPress:
                bindings.readOnly === true
                    ? (): void => undefined
                    : isCamera
                      ? (bindings.camera?.capture ?? resolved.run)
                      : resolved.run,
            disabled:
                bindings.readOnly === true ||
                (isCamera
                    ? selected.name === 'busy' || bindings.camera?.ready !== true
                    : selected.name === 'busy' || selected.name === 'pending' || !resolved.enabled),
            nativeID: marked(environment, `${selected.prefix}bar.${role}`),
            testID: isCamera
                ? 'camera-shutter'
                : role === 'primary' && bindings.testIds?.primary !== undefined
                  ? bindings.testIds.primary
                  : ['camera', 'judge', 'compare'].includes(document.kind)
                    ? undefined
                    : barTestId(document.kind as never, role, node.intent),
        }
    }
    return (
        <ScreenBody
            testID={testID}
            nativeID={`truebuild-document-root:${document.screenId}`}
            insetTop={bindings.insetTop}
        >
            {chrome === 'full' ? (
                <View nativeID={marked(environment, `${selected.prefix}header`)} style={styles.header}>
                    {selected.variant.header.back === null ? null : (
                        <Action
                            header
                            action={selected.variant.header.back}
                            environment={environment}
                            path={`${selected.prefix}header.back`}
                        />
                    )}
                    <View testID="document-header-copy" style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                        <Heading>{documentText(document, bindings, selected.variant.header.title)}</Heading>
                        {selected.variant.header.subtitle === null ? null : (
                            <Caption>{documentText(document, bindings, selected.variant.header.subtitle)}</Caption>
                        )}
                    </View>
                    {selected.variant.header.actions.map((item, index) => (
                        <Action
                            header
                            key={index}
                            action={item}
                            environment={environment}
                            path={`${selected.prefix}header.actions.${index}`}
                        />
                    ))}
                </View>
            ) : null}
            <Animated.View
                key={bodyPage}
                nativeID={marked(environment, `${selected.prefix}body`)}
                style={[styles.grow, fade, stepMotion]}
            >
                {selected.variant.body.type === 'Scroll' ? (
                    <Node node={selected.variant.body} environment={environment} path={`${selected.prefix}body`} />
                ) : (
                    <ScrollView
                        keyboardShouldPersistTaps="handled"
                        nestedScrollEnabled
                        contentContainerStyle={{ padding: space.md, gap: space.sm }}
                    >
                        <Node node={selected.variant.body} environment={environment} path={`${selected.prefix}body`} />
                        {environment.trailing}
                    </ScrollView>
                )}
            </Animated.View>
            <FixedBottomBar
                nativeID={marked(environment, `${selected.prefix}bar.primary`)}
                reasonNativeID={originId('fallback')}
                primary={action(selected.variant.bar.primary, 'primary')}
                secondary={
                    selected.variant.bar.secondary === null
                        ? undefined
                        : action(selected.variant.bar.secondary, 'secondary')
                }
                reason={
                    document.kind === 'camera' ? null : bindings.resolve(selected.variant.bar.primary.intent).reason
                }
            />
        </ScreenBody>
    )
}

const styles = StyleSheet.create({
    stack: { gap: space.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, flexShrink: 0 },
    grow: { flex: 1, minWidth: 0 },
    touch: { minHeight: touchTarget, justifyContent: 'center' },
    camera: { height: 360, overflow: 'hidden', borderRadius: radius.lg },
    judge: { gap: space.xs, padding: space.md },
})
