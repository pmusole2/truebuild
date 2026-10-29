import {
    isPlainScreenText,
    SCREEN_LIMITS,
    type AppIntent,
    type ManualFact,
    type ScreenIcon,
    type ScreenKind,
    type ScreenLeafNode,
    type ScreenNode,
    type ScreenProposal,
} from '@truebuild/contracts'

import { plain, type GroundingContext, type Witness } from './context'
import { splitLossless } from './text'
import {
    canonicalLabel,
    EMPTY_LIBRARY_TEXT,
    FACT_CANCEL_LABELS,
    FACT_EDITOR_LABELS,
    FACT_PROMPTS,
    FACT_SAVE_LABELS,
    failureText,
    headerTitles,
    instructionCopy,
    QUESTION_SUBMIT_LABELS,
    SOURCE_LABELS,
} from './ui-copy'

type ManualFactKind = ManualFact['kind']

export type Origin = 'generated' | 'fallback'
export type Header = ScreenProposal['header']
export type Bar = ScreenProposal['bar']
type Leaf = ScreenLeafNode
export type InstructionNode = Extract<ScreenNode, { type: 'Instruction' }>
export type WarningNode = Extract<ScreenNode, { type: 'Warning' }>

/** One top-level body entry with the server-owned origin of itself and of each child. */
export interface Item {
    node: ScreenNode
    origin: Origin
    childOrigins?: readonly Origin[]
    /** Required content (safety, actual verdict/answer, full original facts) is never trimmed for count. */
    required?: boolean
}

/** A manual fact the document publishes, where it shows, and who decided that. */
export interface FactSlot {
    fact: ManualFact
    placement: 'body' | 'remainder'
    origin: Origin
}

/** A screen before sources are reindexed: `citations` index `GroundingContext.sources`. */
export interface Screen {
    header: Header
    headerOrigin: Origin
    items: Item[]
    bar: Bar
    primaryOrigin: Origin
    secondaryOrigin: Origin
    /** Published manual facts; filled by `withRequiredContent` once the body is final. */
    facts: FactSlot[]
}

export class Tally {
    droppedBlocks = 0
    droppedItems = 0
    replacedComponents = 0
    /** Required manual facts the composition did not place; they are published for the mandatory section. */
    forcedSafety = 0
    forcedRequired = 0
}

const intent = <I extends AppIntent['intent']>(
    name: I,
    target: Extract<AppIntent, { intent: I }>['target'],
): AppIntent => ({ intent: name, target }) as AppIntent

const header = (title: string, subtitle: string | null = null): Header => ({
    type: 'ScreenHeader',
    title: plain(title, SCREEN_LIMITS.title),
    subtitle: subtitle === null ? null : plain(subtitle, SCREEN_LIMITS.subtitle),
    trailing: null,
})

const primary = (to: AppIntent, icon: ScreenIcon | null = null): Bar['primary'] => ({
    type: 'PrimaryAction',
    label: plain(canonicalLabel(to), SCREEN_LIMITS.action),
    icon,
    intent: to,
})
const secondary = (to: AppIntent, icon: ScreenIcon | null = null): NonNullable<Bar['secondary']> => ({
    type: 'SecondaryAction',
    label: plain(canonicalLabel(to), SCREEN_LIMITS.action),
    icon,
    intent: to,
})

const cap = (refs: readonly number[]): number[] => refs.slice(0, SCREEN_LIMITS.citations)
const item = (node: ScreenNode, required = false, origin: Origin = 'fallback'): Item => ({ node, origin, required })

/** Complete text as consecutive Instruction blocks of at most twenty words each (nothing is clipped). */
export function instructionNodes(text: string, refs: readonly number[], strong: boolean): InstructionNode[] {
    return splitLossless(text, SCREEN_LIMITS.instructionChars, SCREEN_LIMITS.instructionWords).map((chunk) => ({
        type: 'Instruction',
        text: chunk,
        emphasis: strong ? 'strong' : 'quiet',
        citations: cap(refs),
    }))
}

/** DetailsDisclosure blocks holding complete leaf blocks, as many as the child bound requires. */
export function disclosures(label: string, leaves: readonly Leaf[]): ScreenNode[] {
    const out: ScreenNode[] = []
    for (let at = 0; at < leaves.length; at += SCREEN_LIMITS.children) {
        out.push({
            type: 'DetailsDisclosure',
            label,
            initiallyOpen: false,
            children: leaves.slice(at, at + SCREEN_LIMITS.children),
        })
    }
    return out
}

export function detailItems(label: string, facts: readonly Witness[]): Item[] {
    const leaves = facts.flatMap((fact) => instructionNodes(fact.text, fact.refs, false))
    return disclosures(label, leaves).map((node) => item(node, true))
}

/** The actual verdict text: the banner carries the first chunk, any remainder follows as quiet instructions. */
export function verdictItems(context: GroundingContext): Item[] {
    const result = context.result?.kind === 'check' ? context.result.value : null
    const decision = context.decision
    if (!result || decision === null) return []
    const witness = context.witnesses.find((candidate) => candidate.id === 'verdict')
    if (!witness) return []
    const [first = witness.text, ...rest] = splitLossless(witness.text, SCREEN_LIMITS.text)
    const banner: ScreenNode = {
        type: 'ResultBanner',
        verdict: decision,
        text: first,
        citations: cap(witness.refs),
    }
    const remainder = rest
        .flatMap((chunk) => splitLossless(chunk, SCREEN_LIMITS.instructionChars, SCREEN_LIMITS.instructionWords))
        .map<ScreenNode>((chunk) => ({
            type: 'Instruction',
            text: chunk,
            emphasis: 'normal',
            citations: cap(witness.refs),
        }))
    return [item(banner, true), ...remainder.map((node) => item(node, true))]
}

/** The actual answer in full, its first missing-evidence note as the caveat when it fits, the rest under a label. */
export function answerItems(context: GroundingContext): Item[] {
    const answered = context.result?.kind === 'question' ? context.result.value : null
    const witness = context.witnesses.find((candidate) => candidate.id === 'answer')
    if (!answered || !witness) return []
    const missing = context.witnesses.filter((candidate) => candidate.kind === 'missing')
    const [firstMissing] = missing
    const caveat = firstMissing !== undefined && Array.from(firstMissing.text).length <= 120 ? firstMissing : undefined
    const cards = splitLossless(witness.text, SCREEN_LIMITS.answer).map<ScreenNode>((chunk, index) => ({
        type: 'AnswerCard',
        text: chunk,
        caveat: index === 0 && caveat ? caveat.text : null,
        citations: cap(witness.refs),
    }))
    const leftover = missing.filter((candidate) => candidate !== caveat)
    const leaves = leftover.flatMap((entry) => instructionNodes(entry.text, entry.refs, false))
    return [
        ...cards.map((node) => item(node, true)),
        ...disclosures('What is missing', leaves).map((n) => item(n, true)),
    ]
}

function regionBlock(context: GroundingContext): Item[] {
    const regions = [
        ...(context.regions.next
            ? [{ partId: context.regions.next.partId, role: 'next' as const, box: context.regions.next.region }]
            : []),
        ...(context.regions.target
            ? [{ partId: context.regions.target.partId, role: 'target' as const, box: context.regions.target.region }]
            : []),
    ]
    if (context.captureId === null || (regions.length === 0 && context.regions.observed === null)) return []
    return [
        item({
            type: 'PhotoWithRegions',
            captureId: context.captureId,
            observed: context.regions.observed,
            regions,
        }),
    ]
}

/** The step's facts, safety first, then the given kinds, then manual order. Each fact is named once. */
export function orderedFactIds(context: GroundingContext, lead: readonly ManualFactKind[] = []): string[] {
    const facts = context.manualFacts
    const rank = (kind: ManualFactKind): number => (kind === 'safety' ? 0 : lead.includes(kind) ? 1 : 2)
    return facts
        .map((fact, index) => ({ fact, index }))
        .sort((a, b) => rank(a.fact.kind) - rank(b.fact.kind) || a.index - b.index)
        .map((entry) => entry.fact.factId)
}

/** One ManualDirections block naming every known fact of the step: the complete, source-witnessed directions. */
function directionsBlock(context: GroundingContext, lead: readonly ManualFactKind[] = []): Item[] {
    const factIds = orderedFactIds(context, lead)
    return factIds.length === 0 ? [] : [item({ type: 'ManualDirections', factIds, emphasis: 'normal' })]
}

function stepScreen(context: GroundingContext): Item[] {
    const { step } = context
    if (!step) return []
    const title = context.witnesses.find((candidate) => candidate.id === 'title')
    const items: Item[] = [
        item({ type: 'StepProgress', current: context.stepIndex + 1, total: context.stepCount, label: null }),
        ...(title && title.refs.length > 0 && title.complete
            ? instructionNodes(title.text, title.refs, true).map((n) => item(n))
            : []),
    ]
    // A part name is shown verbatim or not at all: one that is not plain text (markup, a link, a control character) would
    // make the whole document invalid, and altering it would misname the part. It stays in the manual's own details.
    const parts = step.parts.slice(0, SCREEN_LIMITS.listItems).flatMap((part) => {
        const label = context.partNames.get(part.partId)
        return label === undefined || Array.from(label).length > 60 || !isPlainScreenText(label)
            ? []
            : [{ partId: part.partId, label, quantity: context.quantities.get(part.partId) ?? null }]
    })
    if (parts.length > 0) items.push(item({ type: 'PartList', items: parts, showQuantities: true }))
    // The complete original facts, never reduced to a shortened direction.
    items.push(...directionsBlock(context))
    if (context.reviewed) {
        items.push(item({ type: 'CameraGuidance', cue: CAMERA_CUE, pill: null, tipTarget: 'guide-hero-frame' }))
    }
    return items
}

function recoveryItems(context: GroundingContext): Item[] {
    const lead = instructionCopy(context).flatMap((text) => instructionNodes(text, [], true).map((node) => item(node)))
    // Corrections lead the complete directions: the fix comes first, after any safety.
    return [...lead, ...directionsBlock(context, ['correction'])]
}

/** The sources of the actual result (or of the step) as one collapsed look at the manual pages. */
function sourceBlock(context: GroundingContext, witnessId: string): Item[] {
    const witness = context.witnesses.find((candidate) => candidate.id === witnessId)
    const sources = (witness?.refs ?? []).slice(0, SCREEN_LIMITS.citations)
    return sources.length === 0
        ? []
        : [item({ type: 'SourceDetails', label: SOURCE_LABELS[0], sources, fit: 'contain', initiallyOpen: false })]
}

const CAMERA_CUE = 'Keep the whole step in view'

/** Full-screen blocks a static kind can honestly show from the live app state the request carried. */
function stateBlocks(context: GroundingContext): Item[] {
    const ui = context.ui
    switch (context.kind) {
        case 'home':
            return ui?.library
                ? [
                      item({
                          type: 'ManualLibrary',
                          entries: 'recent',
                          layout: 'cards',
                          showProgress: true,
                          emptyText: EMPTY_LIBRARY_TEXT[0],
                      }),
                  ]
                : []
        case 'pages':
            return ui?.pages
                ? [item({ type: 'PageGallery', pages: 'session', layout: 'list', showNumbers: true, action: null })]
                : []
        case 'quick-check': {
            const question = ui?.review?.currentQuestion
            if (!question) return []
            const title = context.witnesses.find((witness) => witness.id === `title:${question.stepId}`)
            const detail =
                question.reason !== null && Array.from(question.reason).length <= SCREEN_LIMITS.text
                    ? plain(question.reason, SCREEN_LIMITS.text)
                    : null
            return [
                item({
                    type: 'FactPrompt',
                    questionRef: 'current',
                    prompt: FACT_PROMPTS[question.kind][0],
                    detail,
                    citations: (title?.complete ? title.refs : []).slice(0, SCREEN_LIMITS.citations),
                }),
                item({
                    type: 'FactEditor',
                    questionRef: 'current',
                    kind: question.kind,
                    label: FACT_EDITOR_LABELS[question.kind][0],
                    saveLabel: FACT_SAVE_LABELS[0],
                    cancelLabel: FACT_CANCEL_LABELS[0],
                }),
            ]
        }
        case 'questions':
            return ui?.capture
                ? [
                      item({
                          type: 'QuestionComposer',
                          captureRef: 'current',
                          prompt: null,
                          partScope: (context.step?.parts.length ?? 0) > 0 ? 'step-parts' : 'none',
                          submitLabel: QUESTION_SUBMIT_LABELS[0],
                      }),
                  ]
                : []
        case 'more':
            return [
                ...(ui?.sections?.includes('about-this-check')
                    ? [
                          item({
                              type: 'ActionLink',
                              label: 'About this check',
                              icon: 'info',
                              intent: intent('open-details', 'about-check'),
                              emphasis: 'normal',
                          }),
                      ]
                    : []),
                ...(ui?.sections?.includes('tips')
                    ? [
                          item({
                              type: 'ActionLink',
                              label: 'Show tips',
                              icon: 'help',
                              intent: intent('show-tips', 'screen'),
                              emphasis: 'quiet',
                          }),
                      ]
                    : []),
            ]
        default:
            return []
    }
}

const STATIC_KINDS = new Set<ScreenKind>([
    'home',
    'add',
    'pages',
    'reading',
    'quick-check',
    'questions',
    'more',
    'completion',
    'error',
])

function barFor(context: GroundingContext): Bar {
    const ask = secondary(intent('ask', 'about-step'), 'help')
    switch (context.kind) {
        case 'home':
            return {
                primary: context.session
                    ? primary(intent('navigate', 'guide'), 'arrowRight')
                    : primary(intent('navigate', 'add'), 'plus'),
                secondary: null,
            }
        case 'add':
            return {
                primary: primary(intent('capture', 'take-photo'), 'camera'),
                secondary: secondary(intent('capture', 'choose-pages'), 'image'),
            }
        case 'pages':
            return {
                primary: primary(intent('confirm', 'reading'), 'arrowRight'),
                secondary: secondary(intent('capture', 'add-page'), 'plus'),
            }
        case 'reading':
            return { primary: primary(intent('navigate', 'pages'), 'chevronLeft'), secondary: null }
        case 'quick-check':
            return {
                primary: primary(intent('confirm', 'facts'), 'check'),
                secondary: secondary(intent('retry', 'reading'), 'refresh'),
            }
        case 'guide':
        case 'recovery':
            // Facts that have not been confirmed yet never open a camera or a check.
            if (!context.reviewed)
                return { primary: primary(intent('navigate', 'quick-check'), 'check'), secondary: null }
            return {
                primary:
                    context.kind === 'guide'
                        ? primary(intent('capture', 'take-photo'), 'camera')
                        : primary(intent('capture', 'retake'), 'camera'),
                secondary: ask,
            }
        case 'result':
            return context.decision === 'pass'
                ? { primary: primary(intent('confirm', 'step'), 'arrowRight'), secondary: ask }
                : { primary: primary(intent('capture', 'retake'), 'camera'), secondary: ask }
        case 'questions':
            return {
                primary: primary(intent('ask', 'about-step'), 'help'),
                secondary: secondary(intent('capture', 'take-photo'), 'camera'),
            }
        case 'answer':
            return {
                primary: primary(intent('navigate', 'guide'), 'chevronLeft'),
                secondary: secondary(intent('ask', 'about-step'), 'help'),
            }
        case 'more':
            return { primary: primary(intent('navigate', 'home'), 'chevronLeft'), secondary: null }
        case 'completion':
            return { primary: primary(intent('navigate', 'home'), 'check'), secondary: null }
        case 'error':
            return {
                primary: primary(intent('retry', 'last-action'), 'refresh'),
                secondary: secondary(intent('navigate', 'home'), 'chevronLeft'),
            }
    }
}

function headerFor(context: GroundingContext): Header {
    const [title = 'This step'] = headerTitles(context)
    if (context.kind === 'guide') return header(title, context.step?.title ?? null)
    if (context.kind === 'questions' || context.kind === 'recovery') return header(title, context.step?.title ?? null)
    if (context.kind === 'home') return header(context.session?.title ?? title)
    return header(title)
}

/** The deterministic, always-valid composition of a screen from validated facts alone. */
export function composeDeterministic(context: GroundingContext): Screen {
    let items: Item[]
    if (STATIC_KINDS.has(context.kind)) {
        items = instructionCopy(context).flatMap((text) => instructionNodes(text, [], true).map((n) => item(n)))
        if (context.kind === 'reading') items.push(item({ type: 'Skeleton', variant: 'lines', lines: 3 }))
        if (context.kind === 'error') {
            items = instructionNodes(failureText(context.failure), [], false).map((n) => item(n))
        }
        items.push(...stateBlocks(context))
    } else if (context.kind === 'guide') items = stepScreen(context)
    else if (context.kind === 'result') {
        items = [...verdictItems(context), ...regionBlock(context), ...sourceBlock(context, 'verdict')]
    } else if (context.kind === 'answer') items = [...answerItems(context), ...sourceBlock(context, 'answer')]
    else items = recoveryItems(context)
    return {
        header: headerFor(context),
        headerOrigin: 'fallback',
        items,
        bar: barFor(context),
        primaryOrigin: 'fallback',
        secondaryOrigin: 'fallback',
        facts: [],
    }
}

/** Deterministic header and bar for a kind, used when a model-chosen component is not acceptable. */
export const fallbackHeader = headerFor
export const fallbackBar = barFor
