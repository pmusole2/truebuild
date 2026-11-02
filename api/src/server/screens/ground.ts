import {
    SCREEN_LIMITS,
    screenProposalSchema,
    type AppIntent,
    type PublishedManualFact,
    type ScreenDocumentSource,
    type ScreenKind,
    type ScreenLeafNode,
    type ScreenNode,
    type ScreenProposal,
    type ScreenSource,
} from '@truebuild/contracts'
import type { z } from 'zod'

import {
    answerItems,
    detailItems,
    fallbackBar,
    fallbackHeader,
    verdictItems,
    Tally,
    type Bar,
    type FactSlot,
    type Header,
    type Item,
    type Origin,
    type Screen,
} from './required'
import type { GroundingContext, Witness } from './context'
import { plain, STEP_KINDS } from './context'
import { normalize } from './text'
import {
    actionLabel,
    CAMERA_CUES,
    CAMERA_PILLS,
    CHOICE_PROMPTS,
    DETAILS_LABELS,
    EMPTY_LIBRARY_TEXT,
    FACT_CANCEL_LABELS,
    FACT_EDITOR_LABELS,
    FACT_PROMPTS,
    FACT_SAVE_LABELS,
    headerTitles,
    instructionCopy,
    listedCopy,
    MORE_LABEL,
    QUESTION_PROMPTS,
    QUESTION_SUBMIT_LABELS,
    SOURCE_LABELS,
    TIP_COPY,
} from './ui-copy'

type Leaf = ScreenLeafNode
type ProposalNode = ScreenProposal['body'][number]
type ProposalLeaf = Exclude<
    ProposalNode,
    {
        type:
            | 'Group'
            | 'DetailsDisclosure'
            | 'ManualLibrary'
            | 'PageGallery'
            | 'FactPrompt'
            | 'FactEditor'
            | 'QuestionComposer'
            | 'SourceDetails'
            | 'CameraGuidance'
            | 'ManualDirections'
    }
>
type ProposalHeavy = Exclude<ProposalNode, ProposalLeaf | { type: 'Group' | 'DetailsDisclosure' }>

/** Machine issue codes for a rejected proposal: JSON path and static rule only, never the rejected text. */
export function issueCodes(error: z.ZodError): string[] {
    return error.issues.slice(0, 12).map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code}`)
}

export function validateProposal(
    value: unknown,
): { ok: true; proposal: ScreenProposal } | { ok: false; issues: string[] } {
    const parsed = screenProposalSchema.safeParse(value)
    return parsed.success ? { ok: true, proposal: parsed.data } : { ok: false, issues: issueCodes(parsed.error) }
}

const INTENTS_BY_KIND: Readonly<Record<ScreenKind, readonly AppIntent['intent'][]>> = {
    home: ['navigate', 'capture', 'open-details', 'show-tips'],
    add: ['navigate', 'capture', 'open-details', 'show-tips'],
    pages: ['navigate', 'capture', 'confirm', 'open-details', 'show-tips'],
    reading: ['navigate', 'retry', 'open-details', 'show-tips'],
    'quick-check': ['navigate', 'confirm', 'retry', 'ask', 'open-details', 'show-tips'],
    guide: ['navigate', 'capture', 'check', 'ask', 'confirm', 'open-details', 'show-tips'],
    result: ['navigate', 'capture', 'check', 'ask', 'confirm', 'retry', 'open-details', 'show-tips'],
    questions: ['navigate', 'capture', 'ask', 'open-details', 'show-tips'],
    answer: ['navigate', 'capture', 'ask', 'confirm', 'open-details', 'show-tips'],
    more: ['navigate', 'open-details', 'show-tips'],
    completion: ['navigate', 'open-details', 'show-tips'],
    error: ['navigate', 'retry', 'open-details'],
    recovery: ['navigate', 'capture', 'check', 'ask', 'retry', 'open-details', 'show-tips'],
}

/**
 * Whether an intent may appear on this screen. Advancing past a step or manual from a result screen requires the
 * decision the server holds to be a pass: a document can never promote an uncertain or refused check.
 */
/** What a screen composed from unreviewed (freshly parsed) facts may offer: never a build action. */
const UNREVIEWED_INTENTS: readonly AppIntent['intent'][] = ['navigate', 'open-details', 'show-tips']

export function intentAllowed(intent: AppIntent, context: GroundingContext): boolean {
    if (!INTENTS_BY_KIND[context.kind].includes(intent.intent)) return false
    if (!context.reviewed && STEP_KINDS.has(context.kind)) return UNREVIEWED_INTENTS.includes(intent.intent)
    if (intent.intent === 'confirm' && (intent.target === 'step' || intent.target === 'manual')) {
        return context.kind !== 'result' || context.decision === 'pass'
    }
    return true
}

/** Side facts one grounding pass collects, so the caller can complete or account for them. */
interface Pass {
    context: GroundingContext
    tally: Tally
    /** Complete facts of which only a sentence was stated; the full original must stay reachable. */
    partial: Set<string>
    /** Manual fact ids a ManualDirections block of this composition already names (each fact shows once). */
    named: Set<string>
}

interface Support {
    refs: number[]
    witnesses: Witness[]
}

/**
 * A factual text is supported only if it is, word for word (ignoring case and punctuation), a complete evidence unit
 * of the validated manual or result with at least one real source. Any citation the model attached must index the
 * supplied source table and be one of that unit's own sources; a foreign or empty support drops the claim.
 */
function support(text: string, claimed: readonly number[], pass: Pass): Support | null {
    const matches = (pass.context.units.get(normalize(text)) ?? []).filter(
        (witness) =>
            witness.kind !== 'manual' && witness.kind !== 'part' && witness.refs.length > 0 && witness.complete,
    )
    if (matches.length === 0) return null
    const refs = [...new Set(matches.flatMap((witness) => witness.refs))]
    // A block carries at most `citations` sources: a unit with more is not restated (it stays in the fact payload).
    if (refs.length > SCREEN_LIMITS.citations) return null
    if (claimed.some((index) => index >= pass.context.sources.length || !refs.includes(index))) return null
    for (const witness of matches) if (witness.whole !== null) pass.partial.add(witness.whole)
    return { refs, witnesses: matches }
}

const cap = (refs: readonly number[]): number[] => refs.slice(0, SCREEN_LIMITS.citations)

interface Grounded {
    node: Leaf
    origin: Origin
}

const keep = (node: Leaf, origin: Origin = 'generated'): Grounded => ({ node, origin })
const keepHeavy = (node: ScreenNode, origin: Origin = 'generated'): { node: ScreenNode; origin: Origin } => ({
    node,
    origin,
})

function groundLeaf(node: ProposalLeaf, pass: Pass): Grounded | null {
    const { context, tally } = pass
    switch (node.type) {
        case 'Instruction': {
            const copy = instructionCopy(context).some((candidate) => normalize(candidate) === normalize(node.text))
            const cited = copy ? null : support(node.text, node.citations, pass)
            if (!copy && cited === null) return null
            return keep({ ...node, citations: copy ? [] : cap(cited?.refs ?? []) })
        }
        case 'Warning': {
            const cited = support(node.text, node.citations, pass)
            if (cited === null) return null
            const critical = cited.witnesses.some((witness) => witness.critical)
            const tone = critical ? 'critical' : node.tone
            return keep({ ...node, tone, citations: cap(cited.refs) }, tone === node.tone ? 'generated' : 'fallback')
        }
        case 'ConfirmFact': {
            const cited = support(node.text, node.citations, pass)
            return cited !== null &&
                intentAllowed(node.confirm, context) &&
                (node.dismiss === null || intentAllowed(node.dismiss, context))
                ? keep({ ...node, citations: cap(cited.refs) })
                : null
        }
        case 'Tip': {
            const copy = TIP_COPY[node.targetId]
            return normalize(copy.heading) === normalize(node.heading) && normalize(copy.text) === normalize(node.text)
                ? keep({ ...node, heading: copy.heading, text: copy.text })
                : null
        }
        case 'ResultBanner': {
            // Placeholder for the model's chosen slot: the actual validated text replaces it (see forceRequired).
            return context.kind === 'result' && context.decision !== null && node.verdict === context.decision
                ? keep(node)
                : null
        }
        case 'AnswerCard': {
            return context.kind === 'answer' && context.result?.kind === 'question' ? keep(node) : null
        }
        case 'PartList': {
            const items = node.items.flatMap((item) => {
                const name = context.partNames.get(item.partId)
                if (name === undefined || normalize(name) !== normalize(item.label)) {
                    tally.droppedItems += 1
                    return []
                }
                const known = context.quantities.get(item.partId)
                if (item.quantity !== null && item.quantity !== known) tally.droppedItems += 1
                return [
                    {
                        ...item,
                        label: name,
                        quantity: item.quantity !== null && item.quantity === known ? known : null,
                    },
                ]
            })
            const unchanged =
                items.length === node.items.length &&
                items.every(
                    (item, index) =>
                        item.partId === node.items[index]?.partId &&
                        item.label === node.items[index]?.label &&
                        item.quantity === node.items[index]?.quantity,
                )
            return items.length > 0 ? keep({ ...node, items }, unchanged ? 'generated' : 'fallback') : null
        }
        case 'QuantityChip': {
            const name = context.partNames.get(node.partId)
            return name !== undefined &&
                normalize(name) === normalize(node.label) &&
                context.quantities.get(node.partId) === node.quantity
                ? keep(node)
                : null
        }
        case 'StepProgress': {
            if (context.step === null || node.current !== context.stepIndex + 1 || node.total !== context.stepCount) {
                return null
            }
            const title = context.witnesses.find((witness) => witness.id === 'title')
            const labelled =
                node.label !== null && title !== undefined && normalize(title.text) === normalize(node.label)
            return keep(
                { ...node, label: labelled ? node.label : null },
                node.label === null || labelled ? 'generated' : 'fallback',
            )
        }
        case 'HeroFigure': {
            const known =
                node.source === 'page'
                    ? context.citedPageIds.has(node.refId)
                    : node.source === 'capture'
                      ? context.captureId !== null && node.refId === context.captureId
                      : context.stepPartIds.has(node.refId)
            if (!known) return null
            const caption = node.caption === null ? null : support(node.caption, [], pass)
            if (node.caption !== null && caption === null) return null
            const { sourceRefIndex, ...rest } = node
            if (node.source === 'part') {
                // A part has no image of its own: its figure is the manual page region where the part is named. The
                // server resolves that real, drawable source; the model's choice of a part is not the content.
                const named = context.witnesses.find((witness) => witness.id === `part:${node.refId}`)
                const source = named?.complete === true ? context.sources[named.refs[0] ?? -1] : undefined
                if (source === undefined) return null
                if (sourceRefIndex != null) tally.droppedItems += 1
                return keep({ ...rest, source: 'page', refId: source.pageId, region: source.region }, 'fallback')
            }
            // The model may choose an existing figure region of this page by index; the box comes from the manual.
            const chosen = sourceRefIndex == null ? undefined : context.sources[sourceRefIndex]
            const region =
                node.source === 'page' && chosen !== undefined && chosen.pageId === node.refId ? chosen.region : null
            if (sourceRefIndex != null && region === null) tally.droppedItems += 1
            return keep({ ...rest, region })
        }
        case 'PhotoWithRegions': {
            if (context.captureId === null || node.captureId !== context.captureId) return null
            const regions = node.regions.flatMap((region) => {
                const known = region.role === 'next' ? context.regions.next : context.regions.target
                return known !== null && known.partId === region.partId && context.stepPartIds.has(region.partId)
                    ? [{ partId: region.partId, role: region.role, box: known.region }]
                    : []
            })
            const observed = node.showObserved ? context.regions.observed : null
            return regions.length > 0 || observed !== null
                ? keep({ type: 'PhotoWithRegions', captureId: node.captureId, observed, regions })
                : null
        }
        case 'ChoiceList': {
            if (!node.options.every((option) => intentAllowed(option.intent, context))) return null
            let replaced = false
            const options = node.options.map((option) => {
                const label = actionLabel(option.label, option.intent)
                replaced ||= label.replaced
                return { ...option, label: label.label }
            })
            const prompt =
                node.prompt === null ||
                CHOICE_PROMPTS.some((candidate) => normalize(candidate) === normalize(node.prompt!))
                    ? node.prompt
                    : null
            replaced ||= prompt !== node.prompt
            return keep({ ...node, prompt, options }, replaced ? 'fallback' : 'generated')
        }
        case 'ActionLink': {
            if (!intentAllowed(node.intent, context)) return null
            const label = actionLabel(node.label, node.intent)
            return keep({ ...node, label: label.label }, label.replaced ? 'fallback' : 'generated')
        }
        case 'Skeleton':
            // A finished generated screen has no placeholders.
            return null
    }
}

/**
 * Blocks bound to live app data or to the step's complete manual facts. They reference that data by id or by the
 * fixed word `current`, so a model can choose a block, its place, emphasis and closed wording, but never the data.
 */
function groundHeavy(node: ProposalHeavy, pass: Pass): { node: ScreenNode; origin: Origin } | null {
    const { context, tally } = pass
    const ui = context.ui
    switch (node.type) {
        case 'ManualLibrary': {
            const library = ui?.library
            if (context.kind !== 'home' || !library) return null
            let entries = node.entries
            if (entries !== 'recent') {
                const known = new Set(library.entries.map((entry) => entry.manualId))
                const listed = [...new Set(entries.manualIds)].filter((manualId) => known.has(manualId))
                tally.droppedItems += entries.manualIds.length - listed.length
                if (listed.length === 0) return null
                entries = { manualIds: listed }
            }
            const empty = node.emptyText === null ? null : listedCopy(node.emptyText, EMPTY_LIBRARY_TEXT)
            const changed =
                entries !== node.entries ||
                (entries !== 'recent' &&
                    node.entries !== 'recent' &&
                    entries.manualIds.length !== node.entries.manualIds.length) ||
                empty?.replaced === true
            return keepHeavy({ ...node, entries, emptyText: empty?.text ?? null }, changed ? 'fallback' : 'generated')
        }
        case 'PageGallery':
            return (context.kind === 'add' || context.kind === 'pages') &&
                ui?.pages &&
                (node.action === null || intentAllowed(node.action, context))
                ? keepHeavy(node)
                : null
        case 'FactPrompt': {
            const question = context.kind === 'quick-check' ? ui?.review?.currentQuestion : null
            if (!question) return null
            const prompt = listedCopy(node.prompt, FACT_PROMPTS[question.kind])
            // The detail may only be the manual's own stated reason for this question, word for word.
            const reason = question.reason === null ? null : plain(question.reason, SCREEN_LIMITS.text)
            const detail = node.detail !== null && reason !== null && normalize(node.detail) === normalize(reason)
            const title = context.witnesses.find((witness) => witness.id === `title:${question.stepId}`)
            return keepHeavy(
                {
                    ...node,
                    prompt: prompt.text,
                    detail: detail ? node.detail : null,
                    citations: (title?.complete ? title.refs : []).slice(0, SCREEN_LIMITS.citations),
                },
                prompt.replaced || (node.detail !== null && !detail) ? 'fallback' : 'generated',
            )
        }
        case 'FactEditor': {
            const question = context.kind === 'quick-check' ? ui?.review?.currentQuestion : null
            if (!question || node.kind !== question.kind) return null
            const label = listedCopy(node.label, FACT_EDITOR_LABELS[question.kind])
            const save = listedCopy(node.saveLabel, FACT_SAVE_LABELS)
            const cancel = listedCopy(node.cancelLabel, FACT_CANCEL_LABELS)
            return keepHeavy(
                { ...node, label: label.text, saveLabel: save.text, cancelLabel: cancel.text },
                label.replaced || save.replaced || cancel.replaced ? 'fallback' : 'generated',
            )
        }
        case 'QuestionComposer': {
            if (!context.reviewed || !ui?.capture || !['questions', 'answer', 'result'].includes(context.kind)) {
                return null
            }
            const prompt = node.prompt === null ? null : listedCopy(node.prompt, QUESTION_PROMPTS)
            const submit = listedCopy(node.submitLabel, QUESTION_SUBMIT_LABELS)
            const hasParts = (context.step?.parts.length ?? 0) > 0
            const scope = node.partScope === 'step-parts' && !hasParts ? 'none' : node.partScope
            return keepHeavy(
                { ...node, prompt: prompt?.text ?? null, submitLabel: submit.text, partScope: scope },
                prompt?.replaced === true || submit.replaced || scope !== node.partScope ? 'fallback' : 'generated',
            )
        }
        case 'SourceDetails': {
            if (!STEP_KINDS.has(context.kind)) return null
            const sources = [...new Set(node.sources)].filter((index) => index < context.sources.length)
            tally.droppedItems += node.sources.length - sources.length
            if (sources.length === 0) return null
            const label = listedCopy(node.label, SOURCE_LABELS)
            return keepHeavy(
                { ...node, label: label.text, sources },
                label.replaced || sources.length !== node.sources.length ? 'fallback' : 'generated',
            )
        }
        case 'CameraGuidance': {
            if (!context.reviewed || !['guide', 'questions', 'recovery'].includes(context.kind)) return null
            const cue = listedCopy(node.cue, CAMERA_CUES)
            const pill = node.pill === null ? null : listedCopy(node.pill, CAMERA_PILLS)
            return keepHeavy(
                { ...node, cue: cue.text, pill: pill?.text ?? null },
                cue.replaced || pill?.replaced === true ? 'fallback' : 'generated',
            )
        }
        case 'ManualDirections': {
            const known = new Set(context.manualFacts.map((fact) => fact.factId))
            const factIds: string[] = []
            for (const factId of node.factIds) {
                if (known.has(factId) && !pass.named.has(factId)) {
                    pass.named.add(factId)
                    factIds.push(factId)
                }
            }
            tally.droppedItems += node.factIds.length - factIds.length
            return factIds.length === 0
                ? null
                : keepHeavy({ ...node, factIds }, factIds.length === node.factIds.length ? 'generated' : 'fallback')
        }
    }
}

const HEAVY_TYPES: ReadonlySet<string> = new Set<string>([
    'ManualLibrary',
    'PageGallery',
    'FactPrompt',
    'FactEditor',
    'QuestionComposer',
    'SourceDetails',
    'CameraGuidance',
    'ManualDirections',
])

const isHeavy = (node: ProposalNode): node is ProposalHeavy => HEAVY_TYPES.has(node.type)

function groundNode(node: ProposalNode, pass: Pass): Item | null {
    const { tally } = pass
    if (isHeavy(node)) {
        const grounded = groundHeavy(node, pass)
        if (grounded === null) {
            tally.droppedBlocks += 1
            return null
        }
        return { node: grounded.node, origin: grounded.origin }
    }
    if (node.type === 'Group' || node.type === 'DetailsDisclosure') {
        const children = node.children.flatMap((child) => groundLeaf(child, pass) ?? [])
        tally.droppedBlocks += node.children.length - children.length
        if (children.length === 0) return null
        if (node.type === 'Group') {
            return {
                node: { ...node, children: children.map((child) => child.node) },
                origin: 'generated',
                childOrigins: children.map((child) => child.origin),
            }
        }
        const listed = DETAILS_LABELS.find((label) => normalize(label) === normalize(node.label))
        return {
            node: { ...node, label: listed ?? MORE_LABEL, children: children.map((child) => child.node) },
            origin: listed === undefined ? 'fallback' : 'generated',
            childOrigins: children.map((child) => child.origin),
        }
    }
    const grounded = groundLeaf(node, pass)
    if (grounded === null) {
        tally.droppedBlocks += 1
        return null
    }
    return { node: grounded.node, origin: grounded.origin }
}

function groundedHeader(proposal: ScreenProposal['header'], pass: Pass): Header | null {
    const { context } = pass
    const title = normalize(proposal.title)
    const titled =
        headerTitles(context).some((candidate) => normalize(candidate) === title) ||
        (context.units.get(title) ?? []).some((witness) => witness.id === 'title' || witness.id === 'manual:title')
    const subtitled =
        proposal.subtitle === null ||
        (context.units.get(normalize(proposal.subtitle)) ?? []).some(
            (witness) => witness.id === 'title' || witness.id === 'manual:title',
        )
    return titled && subtitled && (proposal.trailing === null || intentAllowed(proposal.trailing, context))
        ? proposal
        : null
}

function groundedBar(
    proposal: ScreenProposal['bar'],
    context: GroundingContext,
): { bar: Bar; primary: Origin; secondary: Origin } | null {
    if (
        !intentAllowed(proposal.primary.intent, context) ||
        (proposal.secondary !== null && !intentAllowed(proposal.secondary.intent, context))
    ) {
        return null
    }
    const primary = actionLabel(proposal.primary.label, proposal.primary.intent)
    const secondary = proposal.secondary && actionLabel(proposal.secondary.label, proposal.secondary.intent)
    return {
        bar: {
            primary: { ...proposal.primary, label: primary.label },
            secondary: proposal.secondary && secondary ? { ...proposal.secondary, label: secondary.label } : null,
        },
        primary: primary.replaced ? 'fallback' : 'generated',
        secondary: secondary?.replaced ? 'fallback' : 'generated',
    }
}

const textOf = (node: ScreenNode): string | null =>
    node.type === 'Instruction' || node.type === 'Warning' || node.type === 'ResultBanner' || node.type === 'AnswerCard'
        ? node.text
        : null

function allTexts(items: readonly Item[]): Set<string> {
    const found = new Set<string>()
    for (const entry of items) {
        const text = textOf(entry.node)
        if (text !== null) found.add(normalize(text))
        if (entry.node.type === 'Group' || entry.node.type === 'DetailsDisclosure') {
            for (const child of entry.node.children) {
                const childText = textOf(child)
                if (childText !== null) found.add(normalize(childText))
            }
        }
    }
    return found
}

const totalNodes = (items: readonly Item[]): number =>
    items.reduce(
        (total, entry) =>
            total +
            1 +
            (entry.node.type === 'Group' || entry.node.type === 'DetailsDisclosure' ? entry.node.children.length : 0),
        0,
    )

const fits = (items: readonly Item[]): boolean =>
    items.length <= SCREEN_LIMITS.bodyNodes && totalNodes(items) <= SCREEN_LIMITS.totalNodes

/**
 * Reserves required blocks (the actual verdict or answer and the complete originals of partly stated facts) before
 * optional trimming: optional blocks give way first, last to first. Returns false only when the required blocks alone
 * exceed the bounds. The mandatory manual facts are not body blocks, so they never compete for these slots.
 */
function pack(items: Item[], tally: Tally): boolean {
    while (!fits(items)) {
        let index = items.length - 1
        while (index >= 0 && items[index]!.required === true) index -= 1
        if (index < 0) break
        items.splice(index, 1)
        tally.droppedBlocks += 1
    }
    return fits(items)
}

export interface ForcedResult {
    screen: Screen
    /**
     * False when the actual verdict or answer cannot fit one document body; the caller then publishes a shell with
     * the mandatory manual facts intact, never a lossy screen.
     */
    complete: boolean
}

/** The manual fact a partly stated witness belongs to, so its complete original can stay reachable. */
function factIdOf(witnessId: string): string {
    const alternative = /^alt:(.+?)(?::titled)?$/u.exec(witnessId)
    if (alternative) return `alternative:${alternative[1]}`
    if (witnessId.startsWith('fix:')) return `correction:${witnessId.slice(4)}`
    return witnessId
}

/** Top-level ManualDirections blocks name facts; a fact is placed in the body only if one of them survived packing. */
function publishFacts(items: readonly Item[], pass: Pass): FactSlot[] {
    const { context, tally } = pass
    const placed = new Map<string, Origin>()
    for (const entry of items) {
        if (entry.node.type !== 'ManualDirections') continue
        for (const factId of entry.node.factIds) placed.set(factId, entry.origin)
    }
    // A fact of which the composition stated only a sentence keeps its complete original reachable.
    const partial = new Set([...pass.partial].map(factIdOf))
    const slots: FactSlot[] = []
    for (const fact of context.manualFacts) {
        const origin = placed.get(fact.factId)
        const required = fact.basis !== 'direction'
        if (origin === undefined && !required && !partial.has(fact.factId)) continue
        if (origin === undefined && required) tally.forcedSafety += 1
        slots.push({ fact, placement: origin === undefined ? 'remainder' : 'body', origin: origin ?? 'fallback' })
    }
    return slots
}

/**
 * Content that must be visible regardless of composition. The actual verdict and answer text always replaces model
 * text (at every allowed depth) and keeps the model's chosen position. The mandatory manual facts (every typed safety
 * note, and for an unclassified step every known direction) are published complete with their own sources: placed in
 * the body where the composition names them in a ManualDirections block, otherwise in the remainder section. The
 * complete original of any fact the composition only partly stated stays reachable the same way.
 */
function forceRequired(screen: Screen, pass: Pass): ForcedResult {
    const { context, tally } = pass
    let items = [...screen.items]

    const substitute = (kind: 'verdict' | 'answer'): void => {
        const actual = kind === 'verdict' ? verdictItems(context) : answerItems(context)
        if (actual.length === 0) return
        const type = kind === 'verdict' ? 'ResultBanner' : 'AnswerCard'
        const at = items.findIndex(
            (entry) =>
                entry.node.type === type ||
                ((entry.node.type === 'Group' || entry.node.type === 'DetailsDisclosure') &&
                    entry.node.children.some((child) => child.type === type)),
        )
        // A nested result must be lifted into a visible required slot. Its old container cannot keep an unchecked
        // placeholder, and that app-chosen placement is a fallback component even when its text was already correct.
        const model = at >= 0 && items[at]!.node.type === type ? items[at]! : undefined
        const first = actual[0]!
        // The model's block counts as generated only if the actual text is exactly what it wrote.
        const same =
            model !== undefined &&
            ((model.node.type === 'ResultBanner' &&
                first.node.type === 'ResultBanner' &&
                normalize(model.node.text) === normalize(first.node.text)) ||
                (model.node.type === 'AnswerCard' &&
                    first.node.type === 'AnswerCard' &&
                    normalize(model.node.text) === normalize(first.node.text) &&
                    normalize(model.node.caveat ?? '') === normalize(first.node.caveat ?? '')))
        const placed = actual.map((entry, index) =>
            index === 0 && same ? { ...entry, origin: 'generated' as Origin } : entry,
        )
        if (!same) tally.forcedRequired += 1
        // Remove every placeholder at all allowed depths, keeping child origins aligned after removal.
        const slot = at >= 0 ? at : 0
        items = items.flatMap((entry): Item[] => {
            if (entry.node.type === type) return []
            if (entry.node.type !== 'Group' && entry.node.type !== 'DetailsDisclosure') return [entry]
            const children = entry.node.children.flatMap((child, index) =>
                child.type === type ? [] : [{ node: child, origin: entry.childOrigins?.[index] ?? entry.origin }],
            )
            return children.length === 0
                ? []
                : [
                      {
                          ...entry,
                          node: { ...entry.node, children: children.map((child) => child.node) },
                          childOrigins: children.map((child) => child.origin),
                      },
                  ]
        })
        items.splice(Math.min(slot, items.length), 0, ...placed)
    }
    if (context.kind === 'result' && context.decision !== null) substitute('verdict')
    if (context.kind === 'answer' && context.result?.kind === 'question') substitute('answer')

    // The complete original of a non-fact text (a title, say) of which only a sentence was stated stays reachable.
    const present = allTexts(items)
    const known = new Set(context.manualFacts.map((fact) => fact.factId))
    const wholes = context.witnesses.filter(
        (witness) =>
            pass.partial.has(witness.id) &&
            witness.whole === null &&
            !known.has(factIdOf(witness.id)) &&
            !present.has(normalize(witness.text)),
    )
    if (wholes.length > 0) items.push(...detailItems(MORE_LABEL, wholes))

    const complete = pack(items, tally)
    return { screen: { ...screen, items, facts: publishFacts(items, pass) }, complete }
}

export function withRequiredContent(screen: Screen, context: GroundingContext, tally = new Tally()): ForcedResult {
    return forceRequired(screen, { context, tally, partial: new Set(), named: new Set() })
}

export interface GroundedProposal extends ForcedResult {
    tally: Tally
}

/**
 * Turns a schema-valid model proposal into publishable content: every factual text must be a complete evidence unit
 * of the validated manual or result (closed UI copy is checked separately), data blocks bind only to live app data,
 * region geometry and part names come from the manual and result, the actual verdict/answer and the mandatory manual
 * facts are forced visible, and unacceptable header or action components are replaced by deterministic ones. Returns
 * null when nothing model-authored survives.
 */
export function groundProposal(proposal: ScreenProposal, context: GroundingContext): GroundedProposal | null {
    const tally = new Tally()
    const pass: Pass = { context, tally, partial: new Set(), named: new Set() }
    const items = proposal.body.flatMap((node) => groundNode(node, pass) ?? [])
    if (items.length === 0) return null

    const header = groundedHeader(proposal.header, pass)
    if (header === null) tally.replacedComponents += 1
    const bar = groundedBar(proposal.bar, context)
    if (bar === null) tally.replacedComponents += 1
    tally.replacedComponents += [bar?.primary, bar?.secondary].filter((origin) => origin === 'fallback').length

    const screen: Screen = {
        header: header ?? fallbackHeader(context),
        headerOrigin: header === null ? 'fallback' : 'generated',
        items,
        bar: bar?.bar ?? fallbackBar(context),
        primaryOrigin: bar?.primary ?? 'fallback',
        secondaryOrigin: bar?.secondary ?? 'fallback',
        facts: [],
    }
    return { ...forceRequired(screen, pass), tally }
}

export interface FinalScreen {
    header: Header
    body: ScreenNode[]
    bar: Bar
    sources: ScreenDocumentSource[]
    manualFacts: PublishedManualFact[]
    origins: Record<string, ScreenSource>
    source: 'generated' | 'fallback'
}

/**
 * Reindexes block citations from the context source table to the document's own `sources` (only what is cited,
 * in order of first use) and names the origin of every component.
 */
export function finalize(screen: Screen, context: GroundingContext): FinalScreen {
    const map = new Map<number, number>()
    const sources: ScreenDocumentSource[] = []
    const remap = (citations: readonly number[]): number[] =>
        citations.flatMap((index) => {
            const ref = context.sources[index]
            if (ref === undefined) return []
            let target = map.get(index)
            if (target === undefined) {
                target = sources.length
                map.set(index, target)
                sources.push({ pageId: ref.pageId, region: ref.region })
            }
            return [target]
        })
    const rewrite = <N extends ScreenNode>(node: N): N => {
        if (node.type === 'Instruction' || node.type === 'Warning' || node.type === 'ConfirmFact') {
            return { ...node, citations: remap(node.citations) }
        }
        if (node.type === 'ResultBanner' || node.type === 'AnswerCard' || node.type === 'FactPrompt') {
            return { ...node, citations: remap(node.citations) }
        }
        if (node.type === 'SourceDetails') {
            return { ...node, sources: [...new Set(remap(node.sources))] }
        }
        if (node.type === 'Group' || node.type === 'DetailsDisclosure') {
            return { ...node, children: node.children.map((child) => rewrite(child) as typeof child) }
        }
        return node
    }
    const origins: Record<string, ScreenSource> = { header: screen.headerOrigin }
    const body = screen.items.map((entry, index) => {
        origins[`body.${index}`] = entry.origin
        const node = rewrite(entry.node)
        if (node.type === 'Group' || node.type === 'DetailsDisclosure') {
            node.children.forEach((_child, child) => {
                origins[`body.${index}.children.${child}`] = entry.childOrigins?.[child] ?? entry.origin
            })
        }
        return node
    })
    origins['bar.primary'] = screen.primaryOrigin
    if (screen.bar.secondary !== null) origins['bar.secondary'] = screen.secondaryOrigin
    // Mandatory facts are published whole: their own actual references, never reindexed or capped.
    const manualFacts = screen.facts.map((slot, index): PublishedManualFact => {
        origins[`facts.${index}`] = slot.origin
        return { ...slot.fact, placement: slot.placement }
    })
    return {
        header: screen.header,
        body,
        bar: screen.bar,
        sources,
        manualFacts,
        origins,
        source: Object.values(origins).some((origin) => origin === 'generated') ? 'generated' : 'fallback',
    }
}
