import {
    isValidElement,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactElement,
    type ReactNode,
    type RefObject,
} from 'react'
import {
    I18nManager,
    Image,
    PanResponder,
    Platform,
    Pressable,
    StyleSheet,
    useWindowDimensions,
    View,
    type ScrollViewInstance,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'
import {
    waitCopyV2,
    waitVariantV2,
    BUSY_COPY_V2,
    SCREEN_WAIT_COPY_V2,
    screenFacts,
    citationPlanV2,
    manualDirectionGroups,
    sourceKeyV2,
    variantsOfV2,
    visitVariantNodesV2,
    type CheckResult,
    type QuestionResult,
    type StepMotionScene,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenVariantV2,
    type TextRefV2,
    type CitationPlanEntryV2,
    type DocumentSourceV2,
} from '@truebuild/contracts'
import { AppButton, IconButton } from '../../ui/button'
import { BlueprintLoader } from '../../ui/blueprint-loader'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { SettingRow, TextField } from '../../ui/fields'
import { ReadingLanguagePicker } from '../../ui/reading-language-picker'
import { Icon } from '../../ui/icons'
import { ProgressBar } from '../../ui/progress'
import { Card, cardSurface } from '../../ui/surface'
import { PageHeader, SectionHeader } from '../../ui/headers'
import { PartChip } from '../../ui/part-chip'
import { MoreSheet } from '../../ui/sheet'
import { HomeEmptyState } from '../capture/library-screen'
import { StatusTag, VerdictTag } from '../../ui/status'
import { Body, Caption, Heading, Instruction, Label, LargeTitle, Title, type TextTone } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { lightColors, radius, space, touchTarget } from '../../theme/tokens'
import { bytesToDataUri } from '../../media/image-source'
import { ScreenBody } from '../capture/screen-layout'
import { EssentialDocumentControls } from '../capture/essential-controls'
import { StepPicture } from '../capture/step-picture'
import { SourceDiagrams } from '../capture/step-facts'
import { GroundedRegionOutline, SegmentMasks } from '../assembly/grounded-overlays'
import { boxOnDisplay, containRect } from '../assembly/frame-geometry'
import { heroImageRect } from '../assembly/hero-geometry'
import { extractTapCoordinates } from '../assembly/frozen-photo'
import { partSourceRefs } from '../screens/part-source'
import { stepPartChoices } from '../assembly/question-state'
import { FactEditorBlock, libraryEntries, ManualLibraryBlock, PageGalleryBlock } from '../screens/blocks-live'
import type { BlockContext } from '../screens/blocks'
import { barTestId } from '../screens/bar-ids'
import { originId, RenderOriginProvider, mergeNativeIds, type RenderOrigin } from '../screens/render-origin'
import { useJudge } from '../screens/judge-context'
import { useMeterReading } from '../screens/native-meter'
import { CompareManualsRow, StagesPanel } from '../screens/attribution'
import { PieceViewer, PiecesGrid } from '../pieces/piece-viewer'
import { ViewerScrollView } from '../pieces/viewer-scroll-lock'
import { pieceIdsByPartId } from '../pieces/piece-registry'
import { plainPending } from '../capture/plain-copy'
import { ReviewCounts } from '../capture/review-counts'
import type { FrameBindings } from './types'
import { GuideStepMotion } from '../step-motion/guide-step-motion'
import { StepMotionHint } from '../step-motion/step-motion-hint'
import { DEMO_MODE, GENERATIVE_UI } from '../../config'
import { motionRequestForStep } from '../step-motion/step-motion-registry'
import { capturePlacement } from './capture-placement'
import { manualDisplayTitle } from './manual-title'
import Animated from 'react-native-reanimated'
import { useContentFade } from '../../ui/motion'
import { useIconReveal, useStepTransition } from '../../ui/motion'
import { useFeedback } from '../../ui/feedback'
import { useLargeText } from '../../ui/large-text'
import { PRIVACY_COPY } from '../capture/privacy-copy'
import { DocumentNodeOrigin } from './ownership'
import { startsAtStepSystemEdge, STEP_SWIPE_DISTANCE } from '../capture/gesture-policy'
import { CoachTarget, useCoachAttention, useCoachScope } from '../onboarding/coach-provider'

const gap = (token: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'): number => (token === 'none' ? 0 : space[token])
const align = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' } as const
const tone = { neutral: 'default', info: 'accent', success: 'pass', caution: 'caution', critical: 'refuse' } as const
const mutationsEnabled = (bindings: FrameBindings): boolean =>
    bindings.readOnly !== true && bindings.workInProgress !== true
const cancelsWork = (intent: ScreenVariantV2['bar']['primary']['intent']): boolean =>
    intent.intent === 'navigate' &&
    (intent.target === 'back' || intent.target === 'home' || intent.target === 'pages' || intent.target === 'reading')
const preparingAction = (bindings: FrameBindings, intent: ScreenVariantV2['bar']['primary']['intent']): boolean =>
    bindings.workInProgress === true && !cancelsWork(intent)
const FIXTURE_LABEL = 'Test fixture'
// At accessibility text sizes the manual-page opener keeps to one line; its full wording stays the accessibility label.
const MANUAL_OPENER = 'See it in the manual'
const NO_MOVED_OPENERS: ReadonlySet<string> = new Set()
const MANUAL_OPENER_SHORT = 'Manual page'
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
            return count === 1 ? '1 build is saved on this device.' : `${count} builds are saved on this device.`
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
    citations: Readonly<Record<string, CitationPlanEntryV2>>
    /** Number of each shown action in Directions (by node path); the list reads 1, 2, 3 in document order. */
    actionNumbers: Readonly<Record<string, number>>
    /** Drawn source openers that a plain-action Guide shows after its section's last numbered direction, by section path. */
    relocated: Readonly<Record<string, readonly RelocatedOpener[]>>
    /** Paths of those relocated openers: they draw in their section's tail, never where they were authored. */
    movedOpeners: ReadonlySet<string>
    planSources: readonly DocumentSourceV2[]
    sections: Readonly<Record<string, boolean>>
    sectionChanged: (path: string, open: boolean) => void
    leading: ReactNode
    trailing: ReactNode
    sourceOverlay?: boolean
    /** Guide pills already shown by resolved text, so a repeated quantity or status reads once. */
    guidePillPaths: ReadonlySet<string>
    /** The body's own scroller, authored or supplied, so a new page can start at its top without remounting it. */
    rootScroll: RefObject<ScrollViewInstance | null>
    /** The measured Guide bar already includes its safe area; the final piece can scroll completely above it. */
    scrollBottomPadding: number
    /** The workflow page being shown: the local state of every node outside `photoBranch` belongs to it alone. */
    page: string
    /** The held photo's own path and every path above it: the one branch of a page that may outlive that page. */
    photoBranch: ReadonlySet<string>
    /** The shown variant is a busy or pending wait (not ready, error or empty): its build indicator is a wait scene. */
    waiting: boolean
    /** The contract's wait heading, announced when its drawing appears. */
    waitHeading: string
    /** Transient preparation labels its scene; a complete variant already carries its words in the header or body. */
    waitLabel: string | undefined
    /** Body text that repeats the header label of a waiting document: suppressed, while unique body text stays. */
    headerDuplicatePaths: ReadonlySet<string>
    waitVisible: boolean
    /** A wait scene is drawn only after the complete waiting presentation has observed WAIT_REVEAL_MS. */
    waitScene: boolean
}
const marked = (environment: Environment, path: string): string => {
    const origin = environment.document.metadata.origins[path]
    if (origin === undefined) throw new Error(`missing-origin:${path}`)
    return originId(origin)
}
const originAt = (environment: Environment, path: string): RenderOrigin => {
    const origin = environment.document.metadata.origins[path]
    if (origin === undefined) throw new Error(`missing-origin:${path}`)
    return origin
}

/** Printed name citations locate text; only a separate drawing box may identify the part illustration. */
function partDrawingReference(environment: Environment, partId: string): DocumentSourceV2 | undefined {
    const session = environment.bindings.session
    const part = screenFacts(session ?? null)?.parts.find((item) => item.partId === partId)
    const box = part?.drawingBox
    const pageId =
        part?.name.state === 'known'
            ? part.name.sourceRefs.find((ref) => session?.pages.some((page) => page.pageId === ref.pageId))?.pageId
            : undefined
    return pageId === undefined || box == null
        ? undefined
        : { pageId, region: { x: box[0], y: box[1], width: box[2], height: box[3] } }
}

/** A result is visible only with its resolved reusable photo and the document's exact held text witness. */
function heldResultForDocument(
    document: ScreenDocumentV2,
    bindings: FrameBindings,
    kind: 'check' | 'question',
    photoLoaded: boolean,
): CheckResult | QuestionResult | null {
    const result = kind === 'check' ? bindings.live?.state.check : bindings.live?.state.answer
    const id = kind === 'check' ? 'result:verdict' : 'result:answer'
    return result != null &&
        document.requirements.capture &&
        bindings.capture?.reusable === true &&
        photoLoaded &&
        document.facts.some(
            (fact) =>
                fact.factId === id &&
                fact.basis === 'result' &&
                fact.text === ('reason' in result ? result.reason : result.answer),
        )
        ? result
        : null
}

function shortGuideChecks(node: ScreenNodeV2, document: ScreenDocumentV2, bindings: FrameBindings): boolean {
    if (
        document.kind !== 'guide' ||
        document.metadata.stepActions !== 1 ||
        node.type !== 'Section' ||
        documentText(document, bindings, node.title) !== 'Check your work'
    )
        return false
    const ids = new Set<string>()
    const collect = (item: ScreenNodeV2): void => {
        if (item.type === 'Text' && item.content.kind === 'fact') ids.add(item.content.factId)
        if ('children' in item) item.children.forEach(collect)
    }
    collect(node)
    return ids.size <= 4
}

/** Plan the result capability's real source opener alongside document Citation nodes; never alter the document. */
function citationVariant(
    document: ScreenDocumentV2,
    bindings: FrameBindings,
    photoLoaded: boolean,
    variant: ScreenVariantV2,
    prefix: string,
    omitted: ReadonlySet<string>,
    sections: Readonly<Record<string, boolean>>,
    planSources: DocumentSourceV2[],
    lowPriorityPaths: Set<string>,
): ScreenVariantV2 {
    const planNode = (node: ScreenNodeV2, path: string): ScreenNodeV2 => {
        // A deduplicated fact citation is not an opener. Keep its path position without claiming any source.
        if (node.type === 'Citation' && omitted.has(path)) return { ...node, sources: [] }
        if (
            node.type === 'VerdictCard' &&
            heldResultForDocument(document, bindings, node.result, photoLoaded) !== null
        ) {
            return { type: 'Citation', sources: document.metadata.sourceMap[path] ?? [], label: null, display: 'chip' }
        }
        if (node.type === 'PieceTile') {
            const session = bindings.session
            const stepIndex =
                session?.reviewStatus === 'reviewed'
                    ? session.reviewedSteps.findIndex((step) => step.stepId === document.bound.stepId)
                    : -1
            const refs =
                session === undefined ? [] : partSourceRefs(session, node.partId, stepIndex < 0 ? undefined : stepIndex)
            const indexes = refs
                .filter((ref) => ref.region === null)
                .map((ref) => {
                    const index = planSources.findIndex((source) => sourceKeyV2(source) === sourceKeyV2(ref))
                    if (index >= 0) return index
                    planSources.push(ref)
                    return planSources.length - 1
                })
            lowPriorityPaths.add(path)
            return { type: 'Citation', sources: indexes, label: null, display: 'chip' }
        }
        const visibleNode =
            node.type === 'Section'
                ? {
                      ...node,
                      initiallyOpen:
                          containsSafety(node, document) ||
                          shortGuideChecks(node, document, bindings) ||
                          (sections[path] ?? node.initiallyOpen),
                  }
                : node
        return 'children' in visibleNode
            ? {
                  ...visibleNode,
                  children: visibleNode.children.map((child, index) => planNode(child, `${path}.${index}`)),
              }
            : visibleNode
    }
    return { ...variant, body: planNode(variant.body, `${prefix}body`) }
}

/** A fact's own citation is rendered with its first visible statement, once per fact identity. */
function duplicateFactPaths(
    document: ScreenDocumentV2,
    bindings: FrameBindings,
    photoLoaded: boolean,
    body: ScreenNodeV2,
    path: string,
): Set<string> {
    const seen = new Set<string>()
    const citationsByFact = new Map<string, Set<number>>()
    const resultText = new Map<string, { refs: Set<string>; indexes: Set<number> }>()
    let nativeResumeCard = false
    let guideTitleFactShown = false
    const key = (ref: ScreenDocumentV2['sources'][number]): string =>
        JSON.stringify([
            ref.pageId,
            ref.region === null ? null : [ref.region.x, ref.region.y, ref.region.width, ref.region.height],
        ])
    const collectResults = (node: ScreenNodeV2, at: string): void => {
        if (node.type === 'Section' && node.collapsible && !node.initiallyOpen && !containsSafety(node, document))
            return
        const live = bindings.live
        // A numbered Guide shows its saved title as its first direction, so only a legacy Guide drops the repeated title.
        if (
            document.kind === 'guide' &&
            document.metadata.stepActions !== 1 &&
            node.type === 'Text' &&
            node.content.kind === 'fact' &&
            node.content.factId === 'title'
        )
            guideTitleFactShown = true
        if (
            document.kind === 'home' &&
            node.type === 'ManualList' &&
            node.layout === 'cards' &&
            live !== null &&
            !live.state.loading &&
            !live.state.storageReadOnly &&
            bindings.readOnly !== true &&
            libraryEntries({ ...node, type: 'ManualLibrary', emptyText: null }, live.state.entries).length === 1
        )
            nativeResumeCard = true
        if (
            node.type === 'VerdictCard' &&
            node.showReason &&
            heldResultForDocument(document, bindings, node.result, photoLoaded) !== null
        ) {
            const fact = document.facts.find(
                (item) => item.factId === (node.result === 'check' ? 'result:verdict' : 'result:answer'),
            )
            if (fact !== undefined) {
                const sources = resultText.get(fact.text) ?? { refs: new Set<string>(), indexes: new Set<number>() }
                for (const index of document.metadata.sourceMap[at] ?? []) {
                    const source = document.sources[index]
                    if (source !== undefined) {
                        sources.refs.add(key(source))
                        sources.indexes.add(index)
                    }
                }
                resultText.set(fact.text, sources)
            }
        }
        if ('children' in node) node.children.forEach((child, index) => collectResults(child, `${at}.${index}`))
    }
    collectResults(body, path)
    const omitted = new Set<string>()
    const visit = (node: ScreenNodeV2, at: string): void => {
        if (!('children' in node)) return
        if (node.type === 'Section' && node.collapsible && !node.initiallyOpen && !containsSafety(node, document))
            return
        let repeatedFact = false
        let currentFact: string | null = null
        node.children.forEach((child, index) => {
            const next = `${at}.${index}`
            if (
                guideTitleFactShown &&
                child.type === 'Text' &&
                child.content.kind === 'bound' &&
                child.content.key === 'step-title'
            ) {
                // Keep the full fact and its citation in the body; the generic title binding adds no new words.
                omitted.add(next)
            } else if (
                nativeResumeCard &&
                child.type === 'Text' &&
                child.content.kind === 'literal' &&
                child.content.text.trim() === 'Pick up where you left off.'
            ) {
                omitted.add(next)
            } else if (child.type === 'Text' && child.content.kind === 'fact') {
                const id = child.content.factId
                currentFact = id
                const fact = document.facts.find((item) => item.factId === id)
                const resultSources = fact === undefined ? undefined : resultText.get(fact.text)
                const sameCitedResult =
                    fact !== undefined &&
                    fact.basis !== 'safety-note' &&
                    fact.sourceRefs.length > 0 &&
                    resultSources !== undefined &&
                    new Set(fact.sourceRefs.map(key)).size === resultSources.refs.size &&
                    fact.sourceRefs.every((ref) => resultSources.refs.has(key(ref)))
                if (sameCitedResult && resultSources !== undefined)
                    citationsByFact.set(id, new Set(resultSources.indexes))
                repeatedFact = seen.has(id) || sameCitedResult
                if (repeatedFact) omitted.add(next)
                else seen.add(id)
            } else if (child.type === 'Citation') {
                if (currentFact !== null) {
                    const cited = citationsByFact.get(currentFact) ?? new Set<number>()
                    if (repeatedFact && child.sources.every((source) => cited.has(source))) omitted.add(next)
                    else child.sources.forEach((source) => cited.add(source))
                    citationsByFact.set(currentFact, cited)
                }
            } else {
                repeatedFact = false
                currentFact = null
            }
            visit(child, next)
        })
    }
    visit(body, path)
    return omitted
}

/**
 * The Guide's Directions, numbered 1, 2, 3 in document order. The numbered facts are exactly the shared Directions group
 * of the document's facts, so the renderer never infers which fact is a direction. A repeat already omitted takes no
 * number. Only the number is added; the instruction's own words are shown unchanged, including compatibility documents.
 */
function actionNumbers(environment: Environment, variant: ScreenVariantV2, prefix: string): Record<string, number> {
    const { document } = environment
    const numbers: Record<string, number> = {}
    if (document.kind !== 'guide') return numbers
    const directions = new Set(manualDirectionGroups(document.facts).directions.map((fact) => fact.factId))
    let next = 0
    visitVariantNodesV2(variant, prefix, ({ node, path, hidden }) => {
        if (
            hidden ||
            !path.startsWith(`${prefix}body`) ||
            node.type !== 'Text' ||
            !hasVisibleContent(node, path, environment)
        )
            return
        if (node.content.kind !== 'fact') return
        if (directions.has(node.content.factId)) numbers[path] = ++next
    })
    return numbers
}

type RelocatedOpener = { readonly path: string; readonly node: ScreenNodeV2 }

/**
 * A plain-action Guide draws each section's source opener once, after that section's last numbered direction, however the
 * layout interleaves the citations. Only the opener that already draws is moved; its page and region do not change.
 * Compatibility documents (no `stepActions` echo) keep their authored order.
 */
function relocatedOpeners(
    document: ScreenDocumentV2,
    variant: ScreenVariantV2,
    prefix: string,
    citations: Readonly<Record<string, CitationPlanEntryV2>>,
    omitted: ReadonlySet<string>,
): { relocated: Record<string, RelocatedOpener[]>; moved: ReadonlySet<string> } {
    const relocated: Record<string, RelocatedOpener[]> = {}
    const moved = new Set<string>()
    if (document.kind !== 'guide' || document.metadata.stepActions !== 1) return { relocated, moved }
    const sections: string[] = []
    const openers: RelocatedOpener[] = []
    visitVariantNodesV2(variant, prefix, ({ node, path, hidden }) => {
        if (hidden || !path.startsWith(`${prefix}body`) || omitted.has(path)) return
        if (node.type === 'Section') sections.push(path)
        else if (
            (node.type === 'ManualPage' || (node.type === 'Citation' && node.display !== 'thumbnail')) &&
            (citations[path]?.show.length ?? 0) > 0
        )
            openers.push({ path, node })
    })
    for (const opener of openers) {
        const scope = sections.reduce(
            (best, section) => (opener.path.startsWith(`${section}.`) && section.length > best.length ? section : best),
            '',
        )
        if (scope === '') continue
        relocated[scope] = [...(relocated[scope] ?? []), opener]
        moved.add(opener.path)
    }
    return { relocated, moved }
}

/**
 * At most one source opener per section: the first opener of a section that shows anything draws every reference
 * that section shows, in document order, and its other openers draw nothing. Each reference keeps its exact region.
 * A nested section scopes its own openers, so a closed section's references stay behind its own disclosure. Openers
 * outside every section (such as independent result cards) keep the planner's affordances.
 */
function oneOpenerPerSection(
    variant: ScreenVariantV2,
    prefix: string,
    plan: Readonly<Record<string, CitationPlanEntryV2>>,
    sources: readonly DocumentSourceV2[],
): Record<string, CitationPlanEntryV2> {
    const sections: string[] = []
    const openers: string[] = []
    visitVariantNodesV2(variant, prefix, ({ node, path }) => {
        if (!path.startsWith(`${prefix}body`)) return
        if (node.type === 'Section') sections.push(path)
        else if (
            plan[path] !== undefined &&
            (node.type === 'ManualPage' || (node.type === 'Citation' && node.display !== 'thumbnail'))
        )
            openers.push(path)
    })
    const scopeOf = (path: string): string =>
        sections.reduce(
            (best, section) => (path.startsWith(`${section}.`) && section.length > best.length ? section : best),
            '',
        )
    const scopes = new Map<string, string[]>()
    for (const path of openers) {
        const scope = scopeOf(path)
        if (scope !== '') scopes.set(scope, [...(scopes.get(scope) ?? []), path])
    }
    const planned: Record<string, CitationPlanEntryV2> = { ...plan }
    const combine = (paths: string[]): void => {
        const shown = paths.find((path) => planned[path]!.show.length > 0)
        if (shown === undefined) return
        const all = [...new Set(paths.flatMap((path) => planned[path]!.show))]
        for (const path of paths)
            planned[path] =
                path === shown
                    ? { show: all, repeated: planned[path]!.repeated }
                    : { show: [], repeated: [...planned[path]!.repeated, ...planned[path]!.show] }
    }
    for (const paths of scopes.values()) combine(paths)
    // Outside sections, combine only adjacent sibling openers sharing a page; independent cards stay independent.
    const adjacent = (node: ScreenNodeV2, path: string): void => {
        if (node.type === 'Section' || !('children' in node)) return
        let run: string[] = []
        const pages = new Set<string>()
        const flush = (): void => {
            combine(run)
            run = []
            pages.clear()
        }
        node.children.forEach((child, index) => {
            const at = `${path}.${index}`
            if (!openers.includes(at)) {
                flush()
                adjacent(child, at)
                return
            }
            const refs = planned[at]!.show.flatMap((source) => sources[source]?.pageId ?? [])
            if (refs.length === 0) return
            if (run.length > 0 && !refs.some((page) => pages.has(page))) flush()
            run.push(at)
            refs.forEach((page) => pages.add(page))
        })
        flush()
    }
    adjacent(variant.body, `${prefix}body`)
    return planned
}

/** The held photo's own path and every path above it. */
function heldPhotoBranch(body: ScreenNodeV2, path: string): Set<string> {
    const branch = new Set<string>()
    const visit = (node: ScreenNodeV2, at: string): boolean => {
        const below = 'children' in node ? node.children.map((child, index) => visit(child, `${at}.${index}`)) : []
        const holds = (node.type === 'Image' && node.source.kind === 'capture') || below.includes(true)
        if (holds) branch.add(at)
        return holds
    }
    visit(body, path)
    return branch
}

function containsSafety(node: ScreenNodeV2, document: ScreenDocumentV2): boolean {
    if (node.type === 'Text' && node.content.kind === 'fact') {
        const id = node.content.factId
        if (
            document.facts.some(
                (fact) => fact.factId === id && (fact.kind === 'safety' || fact.basis === 'safety-note'),
            )
        )
            return true
    }
    return 'children' in node && node.children.some((child) => containsSafety(child, document))
}

/** Presentation equality only: the saved title still owns its source and original words. */
const normalizedGuideTitle = (value: string): string =>
    value
        .trim()
        .replace(/\s+/gu, ' ')
        .replace(/[\p{P}\s]+$/u, '')
        .toLocaleLowerCase()

function hasVisibleContent(node: ScreenNodeV2, path: string, environment: Environment): boolean {
    if (
        environment.omittedDuplicates.has(path) ||
        environment.movedOpeners.has(path) ||
        environment.headerDuplicatePaths.has(path)
    )
        return false
    if (node.type === 'Badge' && environment.document.kind === 'guide') return environment.guidePillPaths.has(path)
    if (node.type === 'CoachMark') return false
    if (node.type === 'Text')
        return documentText(environment.document, environment.bindings, node.content).trim() !== ''
    if (node.type === 'Citation' || node.type === 'ManualPage')
        return (
            environment.bindings.session !== undefined &&
            (environment.citations[path]?.show ?? node.sources).some(
                (index) => environment.planSources[index] !== undefined,
            )
        )
    if ('children' in node) {
        if (node.children.some((child, index) => hasVisibleContent(child, `${path}.${index}`, environment))) return true
        return (
            node.type === 'Section' &&
            (environment.relocated[path] ?? []).some((opener) =>
                hasVisibleContent(opener.node, opener.path, { ...environment, movedOpeners: NO_MOVED_OPENERS }),
            )
        )
    }
    return true
}

/** Exact manual references are compact until opened; no second cropped page competes with the motion. */
function GuideManualStrip({
    images,
    environment,
}: {
    images: readonly { node: Extract<ScreenNodeV2, { type: 'Image' }>; path: string }[]
    environment: Environment
}): ReactElement | null {
    const [selected, setSelected] = useState<DocumentSourceV2 | null>(null)
    const session = environment.bindings.session
    const sources = images
        .flatMap(({ node }) => {
            const source = manualImageSource(node, environment)
            return source === undefined ? [] : [source]
        })
        .filter((source, index, all) => all.findIndex((item) => sourceKeyV2(item) === sourceKeyV2(source)) === index)
    if (session === undefined || sources.length === 0) return null
    return (
        <>
            <SectionHeader title="From the manual" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {sources.map((source, index) => (
                    <Pressable
                        key={sourceKeyV2(source)}
                        accessibilityRole="button"
                        accessibilityLabel={`View page ${session.pages.findIndex((page) => page.pageId === source.pageId) + 1}`}
                        onPress={(): void => setSelected(source)}
                        style={{ width: 72, minHeight: 72 }}
                    >
                        {images.some(({ node }) => {
                            const reference = manualImageSource(node, environment)
                            return (
                                reference !== undefined &&
                                sourceKeyV2(reference) === sourceKeyV2(source) &&
                                unavailableManualImage(node, environment)
                            )
                        }) ? (
                            <View testID={`guide-manual-thumb-${index}`} style={{ minHeight: 72 }}>
                                <Caption>This manual picture is unavailable.</Caption>
                            </View>
                        ) : (
                            <StepPicture
                                reference={{ ...source, region: null }}
                                session={session}
                                pageUris={environment.bindings.pageUris}
                                height={72}
                                testID={`guide-manual-thumb-${index}`}
                            />
                        )}
                    </Pressable>
                ))}
            </View>
            <MoreSheet visible={selected !== null} title="From the manual" onClose={(): void => setSelected(null)}>
                {selected === null ? null : (
                    <>
                        <SourceDiagrams
                            refs={[selected]}
                            session={session}
                            pageUris={environment.bindings.pageUris}
                            fit="page"
                        />
                        {[
                            ...new Set(
                                images
                                    .filter(({ node }) => {
                                        const source = manualImageSource(node, environment)
                                        return source !== undefined && sourceKeyV2(source) === sourceKeyV2(selected)
                                    })
                                    .map(({ node }) =>
                                        documentText(environment.document, environment.bindings, node.caption),
                                    )
                                    .filter((caption) => caption !== ''),
                            ),
                        ].map((caption) => (
                            <Caption key={caption}>{caption}</Caption>
                        ))}
                    </>
                )}
            </MoreSheet>
        </>
    )
}

/** Show known page count and the observed parse phase, with no per-page or percentage claim. */
function ReadingProgress({
    environment,
    label,
    mark,
}: {
    environment: Environment
    label: string
    mark: string
}): ReactElement {
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const pending = environment.bindings.live?.state.pending ?? null
    const reading = pending?.startsWith('Reading') === true
    const count = environment.bindings.session?.pages.length ?? 0
    // Only the stream's own output phase is named; before it, the loader shows the known page count and nothing more.
    const streamPhase =
        pending?.startsWith('Reading manual pages: laying out steps') === true ? plainPending(pending) : null
    return (
        <View nativeID={mark} style={styles.stack}>
            {reading && (!environment.waiting || environment.waitVisible) ? (
                <View testID="reading-stream-phase">
                    <BlueprintLoader
                        heading
                        phase="reading"
                        pageCount={count || undefined}
                        label={streamPhase ?? environment.waitHeading}
                        running={scope.active && !attention}
                    />
                </View>
            ) : null}
            <View
                accessible
                accessibilityRole={reading ? 'progressbar' : 'text'}
                accessibilityLabel={label || (reading ? 'Reading your manual' : 'Manual pages')}
                accessibilityValue={reading ? { text: plainPending(pending) ?? 'In progress' } : undefined}
            >
                <Caption>{label || `${count} manual ${count === 1 ? 'page' : 'pages'}`}</Caption>
            </View>
        </View>
    )
}

/**
 * The one wait scene of a waiting document. Only a live reading/check witness selects an operation scene; every other
 * wait draws screen preparation. Its label resolves the authored wait heading, without counting steps or repeating it.
 */
function WaitScene({ environment, mark }: { environment: Environment; mark: string }): ReactElement {
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const { document, bindings } = environment
    const checking = /^(Checking|Freezing)/u.test(bindings.live?.state.pending ?? '')
    const observation = bindings.capture?.observation
    // The held photo's bytes are shown as a thumbnail only for a check; the one held photo stays the Photo node above.
    const thumbnail = useMemo(
        () =>
            checking && observation !== undefined && captureMatchesDocument(document, bindings.capture)
                ? bytesToDataUri(observation.bytes, observation.mimeType)
                : undefined,
        [checking, document, bindings.capture, observation],
    )
    return (
        <BlueprintLoader
            nativeID={mark}
            heading
            phase={
                checking ? 'check' : bindings.live?.state.pending?.startsWith('Reading') === true ? 'reading' : 'screen'
            }
            // A generic wait's header already carries its heading; only a preparing document names it in the scene.
            label={environment.waitLabel ?? ''}
            announcementLabel={environment.waitHeading}
            imageUri={thumbnail}
            running={scope.active && !attention}
        />
    )
}

/** A generic wait's scene appears only after this delay: a shorter wait reveals nothing and the screen stays as it is. */
const WAIT_REVEAL_MS = 300
/** Contract-owned transient navigation/storage wording; full variants resolve their own TextRefs below. */
const waitHeadingOf = (bindings: FrameBindings, kind: ScreenDocumentV2['kind']): string =>
    bindings.waitCopy?.heading ?? waitCopyV2(kind).heading
/** The reason a control gives while the app prepares work: the contract-owned activity words, never a native string. */
const preparingReason = (bindings: FrameBindings, kind: ScreenDocumentV2['kind']): string =>
    bindings.preparationLabel ?? bindings.waitCopy?.action ?? waitCopyV2(kind).action
/** True only for `active` lasting WAIT_REVEAL_MS on this page; leaving the wait or changing page clears it at once. */
function useWaitReveal(active: boolean, page: string): boolean {
    const [revealed, setRevealed] = useState<string | null>(null)
    useEffect(() => {
        setRevealed(null)
        if (!active) return undefined
        const timer = setTimeout((): void => setRevealed(page), WAIT_REVEAL_MS)
        return (): void => clearTimeout(timer)
    }, [active, page])
    return active && revealed === page
}
function contextOf(environment: Environment): BlockContext {
    const { document, bindings } = environment
    return {
        readOnly: !mutationsEnabled(bindings),
        originOf: (path) => originAt(environment, path),
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
        environment.bindings.readOnly === true || preparingAction(environment.bindings, action.intent)
            ? {
                  enabled: false,
                  reason:
                      environment.bindings.readOnly === true
                          ? 'Comparison is read only.'
                          : preparingReason(environment.bindings, environment.document.kind),
                  run: (): void => undefined,
              }
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

function manualImageSource(
    node: Extract<ScreenNodeV2, { type: 'Image' }>,
    environment: Environment,
): ScreenDocumentV2['sources'][number] | undefined {
    return node.source.kind === 'source'
        ? environment.document.sources[node.source.index]
        : node.source.kind === 'page'
          ? { pageId: node.source.pageId, region: null }
          : node.source.kind === 'part' && environment.bindings.session !== undefined
            ? partDrawingReference(environment, node.source.partId)
            : undefined
}
function unavailableManualImage(node: Extract<ScreenNodeV2, { type: 'Image' }>, environment: Environment): boolean {
    const source = manualImageSource(node, environment)
    const { bindings } = environment
    return (
        source !== undefined &&
        bindings.session !== undefined &&
        typeof bindings.pageUris[source.pageId] !== 'string' &&
        (bindings.pageImageStatus === 'ready' || bindings.pageImageStatus === 'unavailable')
    )
}

function ReferenceImage({
    node,
    environment,
    path,
    hero = false,
}: {
    node: Extract<ScreenNodeV2, { type: 'Image' }>
    environment: Environment
    path: string
    hero?: boolean
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
                    mutationsEnabled(bindings) &&
                    Math.abs(gesture.dx) > 24 &&
                    Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5 &&
                    !startsAtStepSystemEdge(gesture.moveX - gesture.dx, width, I18nManager.isRTL, Platform.OS),
                onPanResponderRelease: (_event, gesture): void => {
                    if (
                        live === null ||
                        bindings.session?.reviewStatus !== 'reviewed' ||
                        !mutationsEnabled(bindings) ||
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
    const source = manualImageSource(node, environment)
    if (source === undefined || bindings.session === undefined) return null
    if (unavailableManualImage(node, environment))
        return (
            <View nativeID={originId('fallback')} style={hero ? styles.manualFallback : undefined}>
                <Caption>This manual picture is unavailable.</Caption>
            </View>
        )
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
                height={
                    hero
                        ? Math.max(0, (Math.min(width, 720) - space.md * 2) / 1.6)
                        : node.ratio === 'hero'
                          ? 340
                          : node.ratio === 'tall'
                            ? 360
                            : node.ratio === 'square'
                              ? 280
                              : 200
                }
                cover={node.fit === 'cover'}
                testID="guide-hero-picture"
            />
            {hero || node.caption === null ? null : <Caption>{documentText(document, bindings, node.caption)}</Caption>}
        </View>
    )
    return node.ratio === 'hero' && !hero ? (
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
    controlledOpen,
    onOpenChange,
    forced,
    opener,
    trailing,
    children,
    mark,
}: {
    title: string
    initiallyOpen: boolean
    controlledOpen?: boolean
    onOpenChange?: (open: boolean) => void
    forced?: boolean
    /** A source opener is a small caption-sized link, never a heading of the document. */
    opener?: boolean
    trailing?: ReactNode
    children: ReactNode
    mark: string
}): ReactElement {
    const [localOpen, setOpen] = useState(initiallyOpen)
    const large = useLargeText()
    const open = controlledOpen ?? localOpen
    const shown = large && title === MANUAL_OPENER ? MANUAL_OPENER_SHORT : title
    const toggle = (): void => {
        if (forced === true) return
        setOpen(!open)
        onOpenChange?.(!open)
    }
    return (
        <View nativeID={mark} style={styles.stack}>
            {opener === true ? (
                <Pressable
                    testID="fact-source"
                    accessibilityRole="link"
                    accessibilityLabel={title}
                    accessibilityState={{ expanded: open || forced === true, disabled: forced === true }}
                    aria-expanded={open || forced === true}
                    disabled={forced}
                    onPress={toggle}
                    style={styles.touch}
                >
                    <SourceLinkText>{shown}</SourceLinkText>
                </Pressable>
            ) : (
                <SectionHeader
                    title={shown}
                    trailing={trailing}
                    onPress={toggle}
                    expanded={open || forced === true}
                    disabled={forced === true}
                />
            )}
            {open || forced === true ? children : null}
        </View>
    )
}

/** A source opener reads as a link: accent-coloured, underlined, with an arrow that points to the manual page. */
function SourceLinkText({ children }: { children: string }): ReactElement {
    const { colors } = useTheme()
    return (
        <View style={styles.sourceLink}>
            <Caption tone="accent" style={styles.underlined}>
                {children}
            </Caption>
            <Icon name="arrowRight" size="sm" color={colors.accentInk} />
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
    const { width: viewportWidth } = useWindowDimensions()
    const tabletHero = viewportWidth >= 768 && ratio === 'hero'
    const tabletContained =
        viewportWidth >= 768 &&
        (ratio === 'hero' ||
            environment.document.kind === 'result' ||
            environment.document.kind === 'answer' ||
            environment.document.kind === 'questions')
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
                  : tabletHero
                    ? Math.min(Math.max(340, (width * observation.height) / observation.width), 560)
                    : 340
    const check = environment.showRegions ? environment.bindings.live?.state.check : null
    const live = environment.bindings.live
    const canPoint =
        mutationsEnabled(environment.bindings) &&
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
        fit === 'cover' && !tabletContained
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
                <View nativeID={mark} style={StyleSheet.absoluteFill}>
                    <Image
                        nativeID={mark}
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
                    <View nativeID={mark} pointerEvents="none" style={StyleSheet.absoluteFill}>
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
    const [overlayOpen, setOverlayOpen] = useState(node.type === 'ManualPage' && node.initiallyOpen)
    const large = useLargeText()
    const session = environment.bindings.session
    if (session === undefined) return null
    const planned = environment.citations[path]
    const refs = [...new Set(planned?.show ?? node.sources)].flatMap((index) => {
        const source = environment.planSources[index]
        return source === undefined ? [] : [source]
    })
    if (refs.length === 0) return null
    const pictures = (fit: 'page' | 'frame'): ReactNode =>
        refs.map((ref, index) =>
            typeof environment.bindings.pageUris[ref.pageId] !== 'string' &&
            (environment.bindings.pageImageStatus === 'ready' ||
                environment.bindings.pageImageStatus === 'unavailable') ? (
                <View key={index} nativeID={originId('fallback')}>
                    <Caption>This manual picture is unavailable.</Caption>
                </View>
            ) : (
                <SourceDiagrams
                    key={index}
                    refs={[ref]}
                    session={session}
                    pageUris={environment.bindings.pageUris}
                    fit={fit}
                />
            ),
        )
    if (node.type === 'Citation' && node.display === 'thumbnail')
        return (
            <View nativeID={marked(environment, path)} style={styles.stack}>
                {node.label === null ? null : (
                    <Caption>{documentText(environment.document, environment.bindings, node.label)}</Caption>
                )}
                {pictures('page')}
            </View>
        )
    const label = documentText(environment.document, environment.bindings, node.label) || MANUAL_OPENER
    if (environment.sourceOverlay === true)
        return (
            <View nativeID={marked(environment, path)}>
                <Pressable
                    testID="fact-source"
                    accessibilityRole="link"
                    accessibilityLabel={label}
                    accessibilityState={{ expanded: overlayOpen }}
                    aria-expanded={overlayOpen}
                    onPress={(): void => setOverlayOpen(true)}
                    style={styles.touch}
                >
                    <SourceLinkText>{large && label === MANUAL_OPENER ? MANUAL_OPENER_SHORT : label}</SourceLinkText>
                </Pressable>
                <MoreSheet visible={overlayOpen} title={label} onClose={(): void => setOverlayOpen(false)}>
                    {pictures(node.type === 'ManualPage' && node.fit === 'cover' ? 'frame' : 'page')}
                </MoreSheet>
            </View>
        )
    return (
        <Disclosure
            title={label}
            initiallyOpen={node.type === 'ManualPage' && node.initiallyOpen}
            opener
            mark={marked(environment, path)}
        >
            {pictures(node.type === 'ManualPage' && node.fit === 'cover' ? 'frame' : 'page')}
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
    const result = heldResultForDocument(document, bindings, node.result, environment.photoLoaded)
    const visible = result !== null
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
    const blocked = !mutationsEnabled(environment.bindings) || live.state.pending !== null || live.state.storageReadOnly
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
                <View nativeID={marked(environment, path)} style={styles.stack}>
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
    const visible = meter.snapshot?.latest?.methods.focusedVisible
    const session = meter.session?.methods.focusedVisible
    if (panel === 'about-check')
        return (
            <View nativeID={mark}>
                <CompareManualsRow onOpen={environment.bindings.closeOverlays} />
            </View>
        )
    if (!judge.showBuilt) return null
    if (panel === 'stages')
        return (
            <View nativeID={mark}>
                <StagesPanel
                    check={environment.bindings.live?.state.check ?? null}
                    stages={environment.bindings.live?.state.stages ?? null}
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
                    ? FIXTURE_LABEL
                    : metadata.source === 'generated'
                      ? `Composed by ${metadata.model ?? 'the model'}${metadata.effort === null ? '' : `, ${metadata.effort} effort`}`
                      : 'App fallback composition'}
            </Caption>
            <Caption>{`Generated elements on this screen: ${visible?.status === 'measured' ? `${(visible.generatedShare * 100).toFixed(1)}%${meter.snapshot?.stale ? ' (screen changed)' : ''}` : 'Not recorded'} · session ${session?.status === 'measured' ? `${(session.generatedShare * 100).toFixed(1)}%` : 'Not recorded'}`}</Caption>
            <AppButton
                label={details ? 'Hide details' : 'Details'}
                testID="judge-summary-details"
                variant="quiet"
                onPress={(): void => setDetails(!details)}
            />
            {details ? (
                <View testID="judge-details" style={styles.stack}>
                    <Caption>{`Source: ${metadata.source}`}</Caption>
                    <Caption>{`Evidence: ${metadata.evidence === 'synthetic-fixture' ? FIXTURE_LABEL : metadata.evidence}`}</Caption>
                    {metadata.evidence === 'synthetic-fixture' ||
                    (metadata.model === null &&
                        metadata.effort === null &&
                        Object.values(metadata.timing).every((value) => value === null) &&
                        Object.values(metadata.usage).every((value) => value === null)) ? (
                        <Caption>Model, effort, provider timings and tokens: Not recorded.</Caption>
                    ) : (
                        <>
                            <Caption>{`Model: ${metadata.model ?? 'Not recorded'}`}</Caption>
                            <Caption>{`Effort: ${metadata.effort ?? 'Not recorded'}`}</Caption>
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
                        </>
                    )}
                    {metadata.fallbackReason === null ? null : (
                        <Caption>{`Fallback: ${metadata.fallbackReason}`}</Caption>
                    )}
                    <Caption>{`Repaired: ${metadata.repaired ? 'yes' : 'no'}`}</Caption>
                    <Caption>{`Cache hit: ${metadata.cacheHit ? 'yes' : 'no'}`}</Caption>
                    <Coverage />
                    <CompareManualsRow onOpen={environment.bindings.closeOverlays} />
                    <StagesPanel
                        check={environment.bindings.live?.state.check ?? null}
                        stages={environment.bindings.live?.state.stages ?? null}
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
    const visible = latest?.methods.focusedVisible
    const session = meter.session?.methods.focusedVisible
    const percent = (value: number | null | undefined): string =>
        value == null ? 'Not recorded' : `${(value * 100).toFixed(2)}%`
    return (
        <View style={styles.stack}>
            <Caption>{`Visible screen and open sheets: ${percent(visible?.generatedShare)}`}</Caption>
            <Caption>{`Visible-screen session: ${percent(session?.generatedShare)}`}</Caption>
            <Caption>{`Mean across visible routes: ${percent(session?.meanRouteGeneratedShare)}`}</Caption>
            <Caption>{`Visible session, excluding camera and manual-image internals: ${percent(session?.strictGeneratedShare)}`}</Caption>
            <Caption>{`All mounted screens (previous method): ${percent(latest?.methods.allMounted.generatedShare)}; session ${percent(meter.session?.methods.allMounted.generatedShare)}`}</Caption>
            <Caption>
                {latest == null
                    ? 'Not counted on this device.'
                    : latest.status === 'measured'
                      ? `Counted ${new Date(latest.sampledAt).toLocaleTimeString()}. ${meter.snapshot?.stale === true ? 'Screen changed since count.' : 'Current checkpoint.'}`
                      : `Count unavailable: ${latest.reason}`}
            </Caption>
            {session?.exclusions == null ? null : (
                <Caption>{`Excluded development hosts: ${session.exclusions.development.counts.total}; camera/manual-image internals: ${session.exclusions.capabilityInternals.counts.total}.`}</Caption>
            )}
            <Caption>
                Counts generated elements in the focused screen and visible sheets. Navigation stays included;
                background screens and development tools are listed separately. Physical system views are outside this
                scope.
            </Caption>
            <AppButton testID="judge-measure" label="Count again" variant="quiet" onPress={meter.measureNow} />
        </View>
    )
}

/** Guide cards own the visible name/count; parsed part ids and registry ids are different namespaces. */
function guideCardIncludesPart(document: ScreenDocumentV2, bindings: FrameBindings, partId: string): boolean {
    if (document.kind !== 'guide' || bindings.session === undefined) return false
    const pieceId = pieceIdsByPartId(bindings.session).get(partId)
    return pieceId !== undefined && (bindings.stepPieces ?? []).some((item) => item.pieceId === pieceId)
}

/**
 * A name citation often points to a text/table cell, not the part. Only the explicit drawing box may select a crop.
 * Without one the crop stays hidden; the name, count and 3D viewer remain, with the part's own
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
    const large = useLargeText()
    const { document, bindings } = environment
    const facts = screenFacts(bindings.session ?? null)
    const part = facts?.parts.find((item) => item.partId === node.partId)
    const links = (environment.citations[path]?.show ?? []).flatMap((index) => {
        const source = environment.planSources[index]
        return source === undefined ? [] : [source]
    })
    if (part === undefined) return null
    const session = bindings.session
    const grounded = partDrawingReference(environment, node.partId)
    const cardOwnsLabel = document.kind === 'guide' || guideCardIncludesPart(document, bindings, part.partId)
    const label = part.name.state === 'known' ? part.name.value : 'Part'
    return (
        <View nativeID={marked(environment, path)} testID={`part-tile-${node.partId}`} style={styles.stack}>
            {document.kind === 'guide' || grounded === undefined || session === undefined ? null : (
                <StepPicture
                    reference={grounded}
                    session={session}
                    pageUris={bindings.pageUris}
                    height={node.size === 'sm' ? 100 : node.size === 'lg' ? 220 : 160}
                    testID={`part-hero-${node.partId}`}
                />
            )}
            {cardOwnsLabel ? null : <StatusTag label={label} />}
            {node.showQuantity && !cardOwnsLabel
                ? facts?.steps
                      .find((step) => step.stepId === document.bound.stepId)
                      ?.parts.filter((item) => item.partId === part.partId && item.quantity.state === 'known')
                      .map((item) => (
                          <Caption key={item.partId}>
                              {item.quantity.state === 'known' ? `× ${item.quantity.value}` : ''}
                          </Caption>
                      ))
                : null}
            {links.length === 0 || session === undefined ? null : (
                <>
                    <Pressable
                        testID="fact-source"
                        accessibilityRole="link"
                        accessibilityLabel={open ? `Hide the manual page: ${label}` : `${MANUAL_OPENER}: ${label}`}
                        accessibilityState={{ expanded: open }}
                        onPress={(): void => setOpen(!open)}
                        style={styles.touch}
                    >
                        <SourceLinkText>
                            {open ? 'Hide the manual page' : large ? MANUAL_OPENER_SHORT : MANUAL_OPENER}
                        </SourceLinkText>
                    </Pressable>
                    {open ? (
                        <SourceDiagrams refs={links} session={session} pageUris={bindings.pageUris} fit="page" />
                    ) : null}
                </>
            )}
        </View>
    )
}

type NodeProps = { node: ScreenNodeV2; environment: Environment; path: string }

/** Only the branch that holds the shared photo outlives its page; every other node starts fresh with a new page. */
function Node(props: NodeProps): ReactElement {
    const { environment, path } = props
    return <PageNode key={environment.photoBranch.has(path) ? 'photo' : environment.page} {...props} />
}

function PageNode(props: NodeProps): ReactElement {
    const [showSource, setShowSource] = useState(false)
    if (props.node.type !== 'Scroll' && !hasVisibleContent(props.node, props.path, props.environment)) return <></>
    // Photo/camera ancestors and their siblings retain their React ancestry across the wait handoff.
    const content = <NodeContent {...props} />
    if (!props.environment.bindings.inspect)
        return (
            <RenderOriginProvider origin={originAt(props.environment, props.path)}>
                <DocumentNodeOrigin document={props.environment.document} path={props.path}>
                    {content}
                </DocumentNodeOrigin>
            </RenderOriginProvider>
        )
    return (
        <View
            nativeID={marked(props.environment, props.path)}
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
            <RenderOriginProvider origin={originAt(props.environment, props.path)}>
                <DocumentNodeOrigin document={props.environment.document} path={props.path}>
                    {content}
                </DocumentNodeOrigin>
            </RenderOriginProvider>
            {showSource ? (
                <Caption>{`${props.node.type.replace(/([a-z])([A-Z])/gu, '$1 $2')} · ${props.node.type === 'Image' && unavailableManualImage(props.node, props.environment) ? 'fallback' : originAt(props.environment, props.path)}`}</Caption>
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
    const { colors, scheme } = useTheme()
    const { width } = useWindowDimensions()
    const large = useLargeText()
    const { document, bindings } = environment
    const mark = marked(environment, path)
    const text = (ref: TextRefV2 | null): string => documentText(document, bindings, ref)
    if (environment.headerDuplicatePaths.has(path)) return null
    if (
        document.kind === 'home' &&
        node.type === 'Text' &&
        node.content.kind === 'literal' &&
        node.content.text === 'Add a manual to start building.'
    )
        return <HomeEmptyState nativeID={mark} />
    if (
        document.kind === 'home' &&
        node.type === 'Text' &&
        node.content.kind === 'literal' &&
        node.content.text.trim() === 'Pick up where you left off.'
    )
        return null
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
                    style={
                        // At accessibility text sizes side-by-side children stack: squeezed columns split words.
                        large
                            ? { flexDirection: 'column', gap: gap(node.gap), alignItems: 'stretch' }
                            : {
                                  flexDirection: 'row',
                                  gap: gap(node.gap),
                                  alignItems: align[node.align],
                                  justifyContent: node.justify === 'between' ? 'space-between' : align[node.justify],
                                  flexWrap: node.wrap ? 'wrap' : 'nowrap',
                              }
                    }
                >
                    {node.children.flatMap((child, index) =>
                        !hasVisibleContent(child, `${path}.${index}`, environment)
                            ? []
                            : [
                                  <View
                                      key={index}
                                      nativeID={mark}
                                      style={
                                          large
                                              ? { minWidth: 0 }
                                              : {
                                                    minWidth: 0,
                                                    flexShrink: 1,
                                                    ...([
                                                        'Image',
                                                        'ManualPage',
                                                        'Card',
                                                        'PageList',
                                                        'CompareColumns',
                                                    ].includes(child.type)
                                                        ? { flex: 1 }
                                                        : {}),
                                                }
                                      }
                                  >
                                      <Node node={child} environment={environment} path={`${path}.${index}`} />
                                  </View>,
                              ],
                    )}
                </View>
            )
        case 'Grid':
            return (
                <View nativeID={mark} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: gap(node.gap) }}>
                    {node.children.flatMap((child, index) =>
                        !hasVisibleContent(child, `${path}.${index}`, environment)
                            ? []
                            : [
                                  <View
                                      key={index}
                                      nativeID={mark}
                                      style={{ flexBasis: large ? '100%' : `${100 / node.columns - 3}%`, flexGrow: 1 }}
                                  >
                                      <Node node={child} environment={environment} path={`${path}.${index}`} />
                                  </View>,
                              ],
                    )}
                </View>
            )
        case 'Card':
            return (
                <View
                    nativeID={mark}
                    style={{
                        ...cardSurface({ colors, scheme }),
                        gap: space.sm,
                        padding: space.md,
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
                                  : scheme === 'dark'
                                    ? colors.surfaceRaised
                                    : colors.surface,
                    }}
                >
                    {children}
                </View>
            )
        case 'Section': {
            const directions = document.kind === 'guide' && text(node.title) === 'Directions'
            const title = directions ? 'Do this' : text(node.title)
            const collapsible = node.collapsible && !shortGuideChecks(node, document, bindings)
            const tail = (environment.relocated[path] ?? []).map((opener) => (
                <Node
                    key={opener.path}
                    node={opener.node}
                    environment={{ ...environment, movedOpeners: NO_MOVED_OPENERS, sourceOverlay: true }}
                    path={opener.path}
                />
            ))
            const content = (
                <>
                    {node.title === null && !collapsible && tail.length > 0 ? (
                        <View style={{ alignSelf: 'flex-end' }}>{tail}</View>
                    ) : null}
                    {children}
                </>
            )
            if (directions && !Object.keys(environment.actionNumbers).some((at) => at.startsWith(`${path}.`)))
                return tail.length === 0 ? null : <View style={{ alignSelf: 'flex-end' }}>{tail}</View>
            const sectionContent =
                document.kind === 'guide' && title === 'Check your work' ? <Card>{content}</Card> : content
            return (
                <View
                    nativeID={mark}
                    testID={directions ? 'guide-directions' : title === 'Check your work' ? 'guide-checks' : undefined}
                >
                    {node.title === null || collapsible ? null : (
                        <SectionHeader
                            title={title}
                            trailing={tail.length === 0 ? undefined : <View style={{ flexShrink: 1 }}>{tail}</View>}
                        />
                    )}
                    {collapsible ? (
                        <Disclosure
                            title={title}
                            initiallyOpen={node.initiallyOpen}
                            controlledOpen={environment.sections[path] ?? node.initiallyOpen}
                            onOpenChange={(open): void => environment.sectionChanged(path, open)}
                            forced={containsSafety(node, document)}
                            trailing={tail.length === 0 ? undefined : tail}
                            mark={mark}
                        >
                            {sectionContent}
                        </Disclosure>
                    ) : (
                        <View style={styles.stack}>{sectionContent}</View>
                    )}
                </View>
            )
        }
        case 'Scroll':
            return (
                <ViewerScrollView
                    ref={path === `${environment.prefix}body` ? environment.rootScroll : undefined}
                    nativeID={mark}
                    horizontal={node.axis === 'horizontal'}
                    style={path === `${environment.prefix}body` ? styles.grow : undefined}
                    contentContainerStyle={
                        node.axis === 'horizontal'
                            ? styles.row
                            : {
                                  gap: space.sm,
                                  padding: path === `${environment.prefix}body` ? space.md : 0,
                                  ...(path === `${environment.prefix}body`
                                      ? { paddingBottom: space.md + environment.scrollBottomPadding }
                                      : {}),
                                  // Tablet: cap the reading measure and centre it; header and bar stay full width.
                                  ...(path === `${environment.prefix}body` && width >= 768
                                      ? { width: '100%' as const, maxWidth: 720, alignSelf: 'center' as const }
                                      : {}),
                              }
                    }
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                    contentInsetAdjustmentBehavior="never"
                >
                    {path === `${environment.prefix}body` ? environment.leading : null}
                    {children}
                    {path === `${environment.prefix}body` ? environment.trailing : null}
                </ViewerScrollView>
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
            const check =
                document.kind === 'guide' &&
                node.content.kind === 'fact' &&
                manualDirectionGroups(document.facts).checks.some(
                    (fact) => fact.factId === (node.content.kind === 'fact' ? node.content.factId : ''),
                )
            const Typography = check
                ? Body
                : {
                      display: LargeTitle,
                      title: Title,
                      heading: Heading,
                      body: node.emphasis === 'strong' ? Instruction : Body,
                      label: Label,
                      caption: Caption,
                  }[node.role]
            const line = (
                <Typography
                    tone={
                        node.emphasis === 'quiet' && node.tone === 'neutral' ? 'muted' : (tone[node.tone] as TextTone)
                    }
                    style={{
                        textAlign: node.align === 'start' ? 'left' : node.align === 'end' ? 'right' : 'center',
                    }}
                >
                    {text(node.content)}
                </Typography>
            )
            const number = environment.actionNumbers[path]
            return (
                <View
                    nativeID={mark}
                    style={{
                        alignItems: node.align === 'start' ? 'stretch' : align[node.align],
                        ...(check
                            ? {
                                  paddingVertical: space.sm,
                                  borderBottomWidth: StyleSheet.hairlineWidth,
                                  borderBottomColor: colors.border,
                              }
                            : {}),
                    }}
                >
                    {number === undefined ? (
                        line
                    ) : (
                        // Grouped so a screen reader speaks one item; the visible number and words are unchanged.
                        <View
                            style={[
                                styles.numbered,
                                {
                                    paddingVertical: space.sm,
                                    borderBottomWidth: StyleSheet.hairlineWidth,
                                    borderBottomColor: colors.border,
                                },
                            ]}
                            accessible
                            accessibilityLabel={`Step ${number}, ${text(node.content)}`}
                        >
                            <View
                                style={{
                                    minWidth: 24,
                                    minHeight: 24,
                                    borderRadius: radius.pill,
                                    backgroundColor: colors.surfaceSunken,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <Caption tone="accent" style={{ fontWeight: '600' }}>{`${number}.`}</Caption>
                            </View>
                            <View style={styles.numberedText}>{line}</View>
                        </View>
                    )}
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
        case 'Badge': {
            const label = text(node.label)
            if (document.kind === 'guide' && !environment.guidePillPaths.has(path)) return null
            return (
                <StatusTag
                    nativeID={mark}
                    label={label}
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
        }
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
            return environment.movedOpeners.has(path) ? null : (
                <Sources node={node} environment={environment} path={path} />
            )
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
            // A waiting variant's build indicator is not a count of finished steps: it is the wait scene itself.
            if (node.type === 'Progress' && node.binding === 'build' && environment.waiting)
                return environment.waitScene ? <WaitScene environment={environment} mark={mark} /> : null
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
                    height={document.kind === 'guide' && node.binding === 'step' ? 4 : undefined}
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
                                      !mutationsEnabled(bindings) ||
                                      live.state.storageReadOnly ||
                                      bindings.session?.reviewStatus !== 'reviewed'
                                  }
                                  onPress={(): void => {
                                      if (
                                          mutationsEnabled(bindings) &&
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
                            disabled={!mutationsEnabled(bindings)}
                            onValueChange={(value): void => {
                                if (mutationsEnabled(bindings)) toggle.onChange(value)
                            }}
                        />
                    )}
                </View>
            )
        }
        case 'Choice':
            return (
                <View nativeID={mark} style={styles.stack}>
                    {node.prompt === null ||
                    (node.options.mode === 'bound' &&
                        node.options.binding === 'language' &&
                        bindings.language !== undefined) ? null : (
                        <Heading>{text(node.prompt)}</Heading>
                    )}
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
                                disabled={!mutationsEnabled(bindings) || live.state.pending !== null}
                                onPress={(): void => {
                                    if (mutationsEnabled(bindings) && live.state.pending === null)
                                        live.controller.targetChanged({ kind: 'part', partId: part.partId })
                                }}
                            />
                        ))
                    ) : node.options.mode === 'bound' &&
                      node.options.binding === 'language' &&
                      bindings.language !== undefined ? (
                        <View style={{ gap: space.sm }}>
                            <ReadingLanguagePicker
                                label={text(node.prompt) || 'Reading language'}
                                value={bindings.language.value}
                                disabled={!mutationsEnabled(bindings) || bindings.language.disabled === true}
                                onChange={(value): void => {
                                    if (mutationsEnabled(bindings)) bindings.language?.onChange(value)
                                }}
                            />
                            {bindings.language.reread === undefined ? null : (
                                <>
                                    <Body>{bindings.language.reread.prompt}</Body>
                                    <AppButton
                                        label="Re-read"
                                        disabled={!mutationsEnabled(bindings) || bindings.language.disabled === true}
                                        onPress={bindings.language.reread.onPress}
                                    />
                                </>
                            )}
                        </View>
                    ) : null}
                </View>
            )
        case 'ManualList':
            return (
                <ManualLibraryBlock
                    node={{ ...node, type: 'ManualLibrary', emptyText: null }}
                    context={context}
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
                                if (mutationsEnabled(bindings) && live.state.pending === null)
                                    live.controller.questionChanged(value)
                            }}
                            editable={mutationsEnabled(bindings) && live.state.pending === null}
                            multiline
                        />
                    ) : (
                        <Caption>{text(node.label)}</Caption>
                    )}
                </View>
            )
        case 'PieceTile':
            return <PieceTile node={node} environment={environment} path={path} />
        // Model placement names the step catalog; geometry and counts are app-owned live bindings.
        case 'PieceViewer': {
            // Guide pieces render once as full-width app chrome (see environment.trailing), never inside an authored column.
            if (document.kind === 'guide') return null
            const piece = bindings.pieces?.find((item) => item.id === node.pieceId)
            return (
                <View nativeID={mark}>
                    <PieceViewer piece={piece} fallbackImageUri={bindings.pieceCutouts?.[node.pieceId]} />
                </View>
            )
        }
        case 'PiecesGrid':
            if (document.kind === 'guide') return null
            return (
                <View nativeID={mark}>
                    <PiecesGrid
                        pieces={bindings.pieces ?? []}
                        pieceIds={node.pieceIds}
                        cutouts={bindings.pieceCutouts}
                    />
                </View>
            )
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

/** Direct v2 rendering of the validated header, body, bar and overlays, with optional app-owned essential chrome. */
export function NativeDocumentRenderer({
    document,
    bindings,
    variant = 'ready',
    chrome = 'full',
    testID = 'document-screen',
    essentialControls,
    guideMotionPreview,
}: {
    document: ScreenDocumentV2
    bindings: FrameBindings
    variant?: string
    chrome?: 'full' | 'body-only'
    testID?: string
    essentialControls?: ReactNode
    /** Inert gallery scene only; never read in a release bundle or the model-provider runtime. */
    guideMotionPreview?: StepMotionScene
}): ReactElement {
    const { width } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    const [barHeight, setBarHeight] = useState(0)
    const [motionState, setMotionState] = useState<{ step: string | null; status: 'loading' | 'motion' | 'fallback' }>({
        step: null,
        status: 'loading',
    })
    const motionIdentity = `${document.bound.manualId}:${document.bound.revision}:${document.bound.stepId}`
    const motionManualMatches = bindings.session?.manualId === document.bound.manualId
    const motionChanged = useCallback(
        (status: 'motion' | 'loading' | 'fallback'): void => {
            setMotionState((current) =>
                current.step === motionIdentity && current.status === status
                    ? current
                    : { step: motionIdentity, status },
            )
        },
        [motionIdentity],
    )
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const motionCandidate = useMemo(
        () =>
            motionManualMatches && bindings.session !== undefined && document.bound.stepId !== null
                ? motionRequestForStep(bindings.session, document.bound.stepId, 'presentation')
                : null,
        [motionManualMatches, bindings.session, document.bound.stepId],
    )
    const motionAssetMissing =
        motionCandidate !== null &&
        bindings.pageUris[motionCandidate.page.pageId] === undefined &&
        (bindings.pageImageStatus === 'ready' || bindings.pageImageStatus === 'unavailable')
    const motionPossible =
        motionManualMatches &&
        ((__DEV__ && DEMO_MODE === 'fixture' && guideMotionPreview !== undefined) ||
            (scope.active &&
                !attention &&
                bindings.readOnly !== true &&
                DEMO_MODE === 'model' &&
                GENERATIVE_UI !== 'off' &&
                motionCandidate !== null &&
                !motionAssetMissing))
    const motionStatus = !motionPossible
        ? 'fallback'
        : motionState.step === motionIdentity
          ? motionState.status
          : 'loading'
    const motionHero = motionStatus !== 'fallback'
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
    // A held photo's Result and its Answer are two pages of one mounted body, so the one native photo carries across
    // them. Every other page change mounts a fresh body.
    const bodyMount =
        document.kind === 'result' || document.kind === 'answer'
            ? JSON.stringify([
                  'held',
                  document.bound.manualId,
                  document.bound.revision,
                  document.bound.stepId,
                  document.bound.captureId,
              ])
            : bodyPage
    const rootScroll = useRef<ScrollViewInstance>(null)
    const shownBody = useRef({ page: bodyPage, mount: bodyMount })
    useLayoutEffect(() => {
        const before = shownBody.current
        shownBody.current = { page: bodyPage, mount: bodyMount }
        // The body kept for this page is still where the last page left it: a new page starts at its top.
        if (before.page !== bodyPage && before.mount === bodyMount)
            rootScroll.current?.scrollTo({ x: 0, y: 0, animated: false })
    }, [bodyPage, bodyMount])
    const [loadedCapture, setLoadedCapture] = useState<string | null>(null)
    const matchesCapture = captureMatchesDocument(document, bindings.capture)
    const placement = useMemo(() => capturePlacement(document), [document])
    // The load witness belongs to the held capture and where its one native image sits (body mount and ancestry), not to
    // which compatible document draws it: a recomposition keeps the mounted image, so it must not gate the page again.
    // Another capture, ancestry, body mount or inspection mounts a fresh image, which must load before the page shows.
    const expectedPhoto =
        matchesCapture && bindings.capture !== null
            ? JSON.stringify([bodyMount, placement, bindings.capture.binding, bindings.inspect])
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
    const picked = gatePhoto ? variants.find((item) => item.name === 'pending')! : wanted
    // A busy/pending variant shows the contract's wait words before any layout, planning or text reads it.
    const shownVariant = useMemo(
        () => waitVariantV2(picked.variant, document.kind, picked.name, bindings.busyActivity ?? null),
        [picked.variant, picked.name, document.kind, bindings.busyActivity],
    )
    const selected = useMemo(
        () => ({ name: picked.name, prefix: picked.prefix, variant: shownVariant }),
        [picked.name, picked.prefix, shownVariant],
    )
    useLayoutEffect(() => {
        bindings.onVariantShown?.(document, selected.name)
    }, [document, selected.name, bindings.onVariantShown])
    // A variant change (including a wait arriving as ready) gets the shared short fade; reduced motion applies it at once.
    const fade = useContentFade(`${document.screenId}:${selected.name}`, mayMove)
    const [sectionState, setSectionState] = useState<{ id: string; values: Readonly<Record<string, boolean>> }>(() => ({
        id: bodyPage,
        values: {},
    }))
    const sections = sectionState.id === bodyPage ? sectionState.values : {}
    const omitted = duplicateFactPaths(document, bindings, heldReady, selected.variant.body, `${selected.prefix}body`)
    const planSources = document.sources.slice()
    const lowPriorityPaths = new Set<string>()
    const plannedVariant = citationVariant(
        document,
        bindings,
        heldReady,
        selected.variant,
        selected.prefix,
        omitted,
        sections,
        planSources,
        lowPriorityPaths,
    )
    const subtitle = selected.variant.header.subtitle
    const subtitleText = documentText(document, bindings, subtitle).trim().replace(/\s+/gu, ' ')
    // A legacy Guide's subtitle is not repeated when a body instruction already says it; numbered Guides keep theirs.
    let instructionInBody = false
    if (document.kind === 'guide' && document.metadata.stepActions !== 1 && subtitleText !== '') {
        visitVariantNodesV2(plannedVariant, selected.prefix, ({ node, path, hidden }) => {
            if (
                !hidden &&
                path.startsWith(`${selected.prefix}body`) &&
                !omitted.has(path) &&
                node.type === 'Text' &&
                documentText(document, bindings, node.content).trim().replace(/\s+/gu, ' ') === subtitleText
            )
                instructionInBody = true
        })
    }
    // Use the authored wait indicator when present; text-only variants receive the same scene in their body.
    let waitIndicator = false
    let bodyWaitHeading: string | null = null
    const listedWaitHeadings = new Set([
        SCREEN_WAIT_COPY_V2[document.kind].heading,
        ...Object.values(BUSY_COPY_V2).map((copy) => copy.heading),
    ])
    const readingNow = bindings.live?.state.pending?.startsWith('Reading') === true
    visitVariantNodesV2(selected.variant, selected.prefix, ({ node, path, hidden }) => {
        if (
            !hidden &&
            path.startsWith(`${selected.prefix}body`) &&
            node.type === 'Text' &&
            node.content.kind === 'literal' &&
            listedWaitHeadings.has(node.content.text) &&
            bodyWaitHeading === null
        )
            bodyWaitHeading = documentText(document, bindings, node.content)
        if (
            !hidden &&
            path.startsWith(`${selected.prefix}body`) &&
            ((node.type === 'Progress' && node.binding === 'build') ||
                (readingNow &&
                    ((node.type === 'Progress' && node.binding === 'reading') ||
                        (node.type === 'Meter' && node.binding === 'pages-read'))))
        )
            waitIndicator = true
    })
    const waitingNow = selected.name === 'busy' || selected.name === 'pending'
    const waitRevealed = useWaitReveal(waitingNow || bindings.preparingDocument === true, bodyPage)
    // Retained content stays while the app prepares a new document; its small scene appears only after the same delay.
    const preparingRevealed = bindings.preparingDocument === true && !waitingNow && waitRevealed
    const headerTitle = documentText(document, bindings, selected.variant.header.title)
    const authoredWaitHeading = bodyWaitHeading ?? headerTitle
    // Only repeated interface copy is a duplicate; factual and bound page text always stays visible.
    const headerDuplicatePaths = new Set<string>()
    if (waitingNow)
        visitVariantNodesV2(selected.variant, selected.prefix, ({ node, path, hidden }) => {
            if (
                !hidden &&
                path.startsWith(`${selected.prefix}body`) &&
                node.type === 'Text' &&
                node.content.kind === 'literal' &&
                documentText(document, bindings, node.content).trim().replace(/\s+/gu, ' ') ===
                    headerTitle.trim().replace(/\s+/gu, ' ')
            )
                headerDuplicatePaths.add(path)
        })
    const citations = oneOpenerPerSection(
        plannedVariant,
        selected.prefix,
        citationPlanV2(plannedVariant, selected.prefix, planSources, {
            includeManualPages: true,
            lowPriorityPaths,
        }),
        planSources,
    )
    const { relocated, moved } = relocatedOpeners(document, selected.variant, selected.prefix, citations, omitted)
    const environment: Environment = {
        document,
        bindings,
        prefix: selected.prefix,
        photoLoaded: heldReady,
        showRegions: false,
        loaded: (): void => setLoadedCapture(expectedPhoto),
        omittedDuplicates: omitted,
        actionNumbers: {},
        relocated,
        movedOpeners: moved,
        planSources,
        sections,
        sectionChanged: (path, open): void => {
            setSectionState((held) => ({
                id: bodyPage,
                values: { ...(held.id === bodyPage ? held.values : {}), [path]: open },
            }))
        },
        citations,
        leading: null,
        trailing: null,
        guidePillPaths: new Set<string>(),
        rootScroll,
        scrollBottomPadding: document.kind === 'guide' ? barHeight : 0,
        page: bodyPage,
        photoBranch: heldPhotoBranch(selected.variant.body, `${selected.prefix}body`),
        waiting: waitingNow,
        waitHeading: bindings.preparingDocument === true ? waitHeadingOf(bindings, document.kind) : authoredWaitHeading,
        waitLabel: bindings.preparingDocument === true ? waitHeadingOf(bindings, document.kind) : undefined,
        headerDuplicatePaths,
        waitVisible: waitRevealed,
        waitScene: waitingNow && waitRevealed,
    }
    if (environment.waitScene && !waitIndicator)
        environment.leading = (
            <WaitScene environment={environment} mark={marked(environment, `${selected.prefix}body`)} />
        )
    const findRegions = (node: ScreenNodeV2): boolean =>
        node.type === 'VerdictCard' ? node.showRegions : 'children' in node && node.children.some(findRegions)
    environment.showRegions = findRegions(selected.variant.body)
    if (document.kind === 'guide') {
        const labels = new Set<string>()
        const paths = new Set<string>()
        visitVariantNodesV2(plannedVariant, selected.prefix, ({ node, path, hidden }) => {
            if (hidden || node.type !== 'Badge') return
            const label = documentText(document, bindings, node.label).trim().replace(/\s+/gu, ' ')
            if (!labels.has(label)) {
                labels.add(label)
                paths.add(path)
            }
        })
        environment.guidePillPaths = paths
    }
    const guideReady = document.kind === 'guide' && selected.name === 'ready'
    const guideImages: { node: Extract<ScreenNodeV2, { type: 'Image' }>; path: string }[] = []
    const safetySlots: { node: ScreenNodeV2; path: string }[] = []
    const checkSlots: { node: ScreenNodeV2; path: string }[] = []
    const partSlots: { node: ScreenNodeV2; path: string }[] = []
    const guideProgressSlots: { node: ScreenNodeV2; path: string }[] = []
    if (guideReady) {
        const step = screenFacts(bindings.session ?? null)?.steps.find((item) => item.stepId === document.bound.stepId)
        const normalizedTitle = normalizedGuideTitle(step?.title ?? '')
        visitVariantNodesV2(selected.variant, selected.prefix, ({ node, path, hidden }) => {
            if (hidden || !path.startsWith(`${selected.prefix}body`)) return
            if (node.type === 'Image' && node.source.kind !== 'capture') {
                guideImages.push({ node, path })
                omitted.add(path)
            }
            if (node.type === 'Progress' && node.binding === 'step') {
                guideProgressSlots.push({ node, path })
                omitted.add(path)
            }
            if (
                node.type === 'Section' &&
                containsSafety(node, document) &&
                !safetySlots.some((slot) => path.startsWith(`${slot.path}.`))
            ) {
                safetySlots.push({ node, path })
                omitted.add(path)
            }
            if (
                node.type === 'Section' &&
                documentText(document, bindings, node.title) === 'Check your work' &&
                !safetySlots.some((slot) => path === slot.path || path.startsWith(`${slot.path}.`)) &&
                !checkSlots.some((slot) => path.startsWith(`${slot.path}.`))
            ) {
                checkSlots.push({ node, path })
                omitted.add(path)
            }
            if (node.type === 'PieceTile') {
                partSlots.push({ node, path })
                omitted.add(path)
            }
            if (node.type === 'Text' && normalizedTitle !== '') {
                const titleFact =
                    node.content.kind === 'fact'
                        ? document.facts.find(
                              (fact) => fact.factId === (node.content.kind === 'fact' ? node.content.factId : ''),
                          )
                        : undefined
                if (
                    titleFact?.kind !== 'safety' &&
                    titleFact?.basis !== 'safety-note' &&
                    normalizedGuideTitle(documentText(document, bindings, node.content)) === normalizedTitle
                ) {
                    omitted.add(path)
                }
            }
            if (
                node.type === 'Text' &&
                document.metadata.stepActions === 1 &&
                node.content.kind === 'literal' &&
                /^[·\s]+$/u.test(node.content.text)
            )
                omitted.add(path)
        })
        environment.actionNumbers = actionNumbers(environment, selected.variant, selected.prefix)
        const reference = guideImages[0]
        const fallback =
            reference === undefined ? (
                <View style={styles.manualFallback}>
                    <Caption>There is no picture for this step.</Caption>
                </View>
            ) : (
                <ReferenceImage node={reference.node} environment={environment} path={reference.path} hero />
            )
        const motion = !motionManualMatches ? (
            <StepMotionHint scene={null} fallback={fallback} />
        ) : __DEV__ && DEMO_MODE === 'fixture' && guideMotionPreview !== undefined ? (
            <StepMotionHint
                scene={guideMotionPreview}
                fallback={fallback}
                active={scope.active && !attention}
                stepLabel={documentText(document, bindings, { kind: 'bound', key: 'step-position' })}
                onAvailabilityChange={motionChanged}
            />
        ) : (
            <GuideStepMotion
                session={bindings.session}
                stepId={document.bound.stepId}
                pageUris={bindings.pageUris}
                pageImageStatus={bindings.pageImageStatus}
                active={scope.active && !attention}
                readOnly={bindings.readOnly === true}
                fallback={fallback}
                stepLabel={documentText(document, bindings, { kind: 'bound', key: 'step-position' })}
                onAvailabilityChange={motionChanged}
            />
        )
        const slot = (item: { node: ScreenNodeV2; path: string }): ReactElement => (
            <Node
                key={item.path}
                {...item}
                environment={{
                    ...environment,
                    omittedDuplicates: new Set([...omitted].filter((at) => at !== item.path)),
                }}
            />
        )
        environment.leading = (
            <>
                <SectionHeader title={motionHero ? 'Watch it' : 'From the manual'} />
                <CoachTarget id="guide-hero" label="Manual picture">
                    <CoachTarget id="guide-hero-frame" label="Manual picture">
                        <View testID="guide-motion-hero" style={{ marginBottom: space.lg }}>
                            {motion}
                        </View>
                    </CoachTarget>
                </CoachTarget>
                {safetySlots.map(slot)}
                <GuideManualStrip images={guideImages} environment={environment} />
            </>
        )
        // Section source planning preceded title omissions, so their sources remain reachable.
        environment.trailing = (
            <>
                <GuidePieces environment={environment} />
                {partSlots.length === 0 ? null : <View style={{ gap: space.sm }}>{partSlots.map(slot)}</View>}
                {checkSlots.map(slot)}
            </>
        )
    }
    environment.trailing = (
        <>
            {guideReady ? environment.trailing : null}
            {document.kind === 'more' &&
            bindings.live?.state.route === 'overview' &&
            bindings.session !== undefined &&
            bindings.readOnly !== true ? (
                <ReviewCounts
                    session={bindings.session}
                    controller={bindings.live.controller}
                    busy={bindings.live.state.pending !== null || bindings.live.state.storageReadOnly}
                />
            ) : null}
            {bindings.inspect && document.kind !== 'judge' ? (
                <Judge
                    environment={environment}
                    panel="built-view"
                    mark={marked(environment, `${selected.prefix}body`)}
                />
            ) : null}
        </>
    )
    const action = (
        node: Omit<ScreenVariantV2['bar']['primary'], 'type'>,
        role: 'primary' | 'secondary',
    ): BarAction => {
        const resolved = bindings.resolve(node.intent)
        const isCamera =
            document.kind === 'camera' &&
            node.intent.intent === 'capture' &&
            (node.intent.target === 'take-photo' || node.intent.target === 'retake')
        const isDismiss =
            node.intent.intent === 'navigate' &&
            node.intent.target === 'back' &&
            (node.label === 'Close' || node.label === 'Back')
        return {
            label: node.label,
            accessibilityLabel: node.label,
            compactLabel:
                document.kind === 'guide'
                    ? node.label === 'Take photo'
                        ? 'Photo'
                        : node.label === 'Quick check'
                          ? 'Check'
                          : undefined
                    : undefined,
            icon: node.icon ?? undefined,
            onPress:
                bindings.readOnly === true || preparingAction(bindings, node.intent)
                    ? (): void => undefined
                    : isCamera
                      ? (bindings.camera?.capture ?? resolved.run)
                      : resolved.run,
            disabled:
                bindings.readOnly === true ||
                preparingAction(bindings, node.intent) ||
                (isCamera
                    ? selected.name === 'busy' || bindings.camera?.ready !== true
                    : (!isDismiss && (selected.name === 'busy' || selected.name === 'pending')) || !resolved.enabled),
            nativeID: marked(environment, `${selected.prefix}bar.${role}`),
            testID: isCamera
                ? 'camera-shutter'
                : role === 'primary' && bindings.testIds?.primary !== undefined
                  ? bindings.testIds.primary
                  : role === 'secondary' && bindings.testIds?.secondary !== undefined
                    ? bindings.testIds.secondary
                    : ['camera', 'judge', 'compare'].includes(document.kind)
                      ? undefined
                      : barTestId(document.kind as never, role, node.intent),
        }
    }
    const navigationControls =
        essentialControls ??
        (document.kind === 'guide' && bindings.live !== null ? (
            <EssentialDocumentControls
                kind="guide"
                variant={selected.variant}
                state={bindings.live.state}
                entry={bindings.live.entry}
                busy={selected.name !== 'ready' || bindings.workInProgress === true}
                resolve={bindings.resolve}
                controller={bindings.live.controller}
                nav={bindings.live.nav}
            />
        ) : undefined)
    return (
        <RenderOriginProvider origin={originAt(environment, `${selected.prefix}body`)}>
            <ScreenBody
                testID={testID}
                nativeID={mergeNativeIds(
                    `truebuild-document-root:${document.screenId}`,
                    marked(environment, `${selected.prefix}body`),
                )}
                insetTop={bindings.insetTop ?? insets.top}
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
                        <View
                            testID="document-header-copy"
                            nativeID={marked(environment, `${selected.prefix}header`)}
                            style={{ flex: 1, minWidth: 0, gap: space.xs }}
                        >
                            {document.kind === 'home' ? (
                                <Label tone="accent" style={{ fontSize: 15 }}>
                                    TrueBuild
                                </Label>
                            ) : null}
                            {guideReady ? (
                                <Label>
                                    {documentText(document, bindings, { kind: 'bound', key: 'step-position' })}
                                </Label>
                            ) : null}
                            <PageHeader
                                display={document.kind === 'home'}
                                title={
                                    guideReady
                                        ? documentText(document, bindings, { kind: 'bound', key: 'step-title' }) ||
                                          headerTitle
                                        : headerTitle
                                }
                                subtitle={
                                    document.kind === 'home'
                                        ? 'Pick up a build or add a new manual.'
                                        : guideReady || instructionInBody
                                          ? undefined
                                          : subtitleText || undefined
                                }
                            />
                        </View>
                        {guideReady && selected.variant.bar.secondary?.label === 'Ask about this step' ? (
                            <IconButton
                                label="Ask about this step"
                                icon="help"
                                testID={
                                    bindings.testIds?.secondary ??
                                    barTestId('guide', 'secondary', selected.variant.bar.secondary.intent)
                                }
                                nativeID={marked(environment, `${selected.prefix}bar.secondary`)}
                                disabled={action(selected.variant.bar.secondary, 'secondary').disabled}
                                onPress={action(selected.variant.bar.secondary, 'secondary').onPress}
                            />
                        ) : null}
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
                {guideProgressSlots.slice(0, 1).map((progress) => (
                    <View key={progress.path} style={{ paddingHorizontal: space.md }}>
                        <Node
                            {...progress}
                            environment={{
                                ...environment,
                                omittedDuplicates: new Set([...omitted].filter((at) => at !== progress.path)),
                            }}
                        />
                    </View>
                ))}
                <Animated.View
                    key={bodyMount}
                    nativeID={marked(environment, `${selected.prefix}body`)}
                    style={[styles.grow, fade, stepMotion]}
                >
                    {selected.variant.body.type === 'Scroll' ? (
                        <Node node={selected.variant.body} environment={environment} path={`${selected.prefix}body`} />
                    ) : (
                        <ViewerScrollView
                            ref={rootScroll}
                            keyboardShouldPersistTaps="handled"
                            nestedScrollEnabled
                            contentContainerStyle={{
                                padding: space.md,
                                paddingBottom: space.md + environment.scrollBottomPadding,
                                gap: space.sm,
                                ...(width >= 768
                                    ? { width: '100%' as const, maxWidth: 720, alignSelf: 'center' as const }
                                    : {}),
                            }}
                        >
                            {environment.leading}
                            <Node
                                node={selected.variant.body}
                                environment={environment}
                                path={`${selected.prefix}body`}
                            />
                            {environment.trailing}
                        </ViewerScrollView>
                    )}
                </Animated.View>
                {preparingRevealed ? (
                    <View style={{ paddingHorizontal: space.md }}>
                        <BlueprintLoader
                            testID="document-preparing-wait"
                            heading
                            phase="screen"
                            compact
                            label={waitHeadingOf(bindings, document.kind)}
                            running={scope.active && !attention}
                        />
                    </View>
                ) : null}
                {document.kind === 'guide' ? null : essentialControls}
                <FixedBottomBar
                    onHeight={document.kind === 'guide' ? setBarHeight : undefined}
                    nativeID={marked(environment, `${selected.prefix}bar.primary`)}
                    reasonNativeID={marked(environment, `${selected.prefix}bar.primary`)}
                    primary={{
                        ...action(selected.variant.bar.primary, 'primary'),
                        icon:
                            guideReady && selected.variant.bar.primary.label === 'Take photo'
                                ? 'camera'
                                : (selected.variant.bar.primary.icon ?? undefined),
                    }}
                    navigation={
                        document.kind === 'guide' && isValidElement<{ primary?: ReactNode }>(navigationControls)
                            ? navigationControls
                            : undefined
                    }
                    secondary={
                        selected.variant.bar.secondary === null ||
                        (guideReady && selected.variant.bar.secondary.label === 'Ask about this step')
                            ? undefined
                            : action(selected.variant.bar.secondary, 'secondary')
                    }
                    reason={
                        document.kind === 'camera'
                            ? null
                            : ((environment.waiting &&
                              [environment.waitHeading, selected.variant.bar.primary.label].includes(
                                  bindings.resolve(selected.variant.bar.primary.intent).reason ?? '',
                              )
                                  ? null
                                  : bindings.resolve(selected.variant.bar.primary.intent).reason) ??
                              (guideReady ? 'Check your work with a photo' : null))
                    }
                />
            </ScreenBody>
        </RenderOriginProvider>
    )
}

/** App-owned catalog/quantities stay live while the immutable document is shown. */
function GuidePieces({ environment }: { environment: Environment }): ReactElement | null {
    const { bindings, document } = environment
    const items = bindings.stepPieces ?? []
    const facts = screenFacts(bindings.session ?? null)
    const step = facts?.steps.find((candidate) => candidate.stepId === document.bound.stepId)
    const parts = (step?.parts ?? []).flatMap((required) => {
        const part = facts?.parts.find((candidate) => candidate.partId === required.partId)
        return part === undefined
            ? []
            : [
                  {
                      part,
                      name: part.name.state === 'known' ? part.name.value : 'Part',
                      count: required.quantity.state === 'known' ? required.quantity.value : null,
                  },
              ]
    })
    if (items.length === 0 && parts.length === 0) return null
    return (
        <RenderOriginProvider origin="shell">
            <View testID={`guide-pieces-${document.bound.stepId ?? 'none'}`} nativeID={originId('shell')}>
                <SectionHeader title="Parts you need" trailing={<Caption>{items.length || parts.length}</Caption>} />
                {items.length > 0 ? (
                    <PiecesGrid
                        presentation="chips"
                        pieces={bindings.pieces ?? []}
                        items={items}
                        pieceIds={items.map((item) => item.pieceId)}
                        cutouts={bindings.pieceCutouts}
                    />
                ) : (
                    <View testID="pieces-grid" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                        {parts.map(({ part, name, count }) => (
                            <View key={part.partId} style={{ gap: space.xxs }}>
                                <PartChip
                                    name={name}
                                    count={count}
                                    testID={`piece-tile-${part.partId}`}
                                    quantityTestID={`piece-quantity-${part.partId}`}
                                />
                                {part.dimensions === null ? null : <Caption>{part.dimensions}</Caption>}
                                {part.name.state === 'known' ? null : <Caption>{part.name.reason}</Caption>}
                            </View>
                        ))}
                    </View>
                )}
            </View>
        </RenderOriginProvider>
    )
}

const styles = StyleSheet.create({
    manualFallback: {
        width: '100%',
        aspectRatio: 1.6,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.md,
    },
    stack: { gap: space.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    numbered: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
    numberedText: { flex: 1, minWidth: 0 },
    sectionTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
    sourceLink: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: space.xxs },
    underlined: { textDecorationLine: 'underline' },
    header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, flexShrink: 0 },
    grow: { flex: 1, minWidth: 0 },
    touch: { minHeight: touchTarget, justifyContent: 'center', alignSelf: 'stretch', flexShrink: 0 },
    camera: { height: 360, overflow: 'hidden', borderRadius: radius.lg },
    judge: { gap: space.xs, padding: space.md },
})
