import {
    SCREEN_LIMITS,
    type AppIntent,
    type ManualFact,
    type ScreenIcon,
    type ScreenLeafNode,
    type ScreenNode,
    type ScreenProposal,
} from '@truebuild/contracts'

import { plain, type GroundingContext, type Witness } from './context'
import { splitLossless } from './text'
import { canonicalLabel, headerTitles } from './ui-copy'

/**
 * Required content and replacement chrome of the version 1 grounding (deprecated protocol, see `screens/service.ts`).
 *
 * Version 1 grounds a model proposal and may add to it what a person must never be without: the actual verdict or
 * answer, the manual's safety notes and directions, and a header and bar the screen can stand on when the model's are
 * not acceptable. This module builds exactly those pieces. It composes no screen: when nothing the model wrote survives,
 * version 1 publishes the honest `shell` (an empty body, every mandatory fact in the remainder) and the native screen is
 * the screen. The complete document is version 2's job (`buildFallbackDocumentV2` in the contracts).
 */

export type Origin = 'generated' | 'fallback'
export type Header = ScreenProposal['header']
export type Bar = ScreenProposal['bar']
type Leaf = ScreenLeafNode
export type InstructionNode = Extract<ScreenNode, { type: 'Instruction' }>

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

/** Deterministic header and bar for a kind, used when a model-chosen component is not acceptable. */
export const fallbackHeader = headerFor
export const fallbackBar = barFor

/** The screen with no body: only the chrome a kind stands on. Required content is added by `withRequiredContent`. */
export function shellScreen(context: GroundingContext): Screen {
    return {
        header: headerFor(context),
        headerOrigin: 'fallback',
        items: [],
        bar: barFor(context),
        primaryOrigin: 'fallback',
        secondaryOrigin: 'fallback',
        facts: [],
    }
}
