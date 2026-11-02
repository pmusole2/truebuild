import {
    appIntentSchema,
    SCREEN_LIMITS,
    type ScreenDocument,
    type ScreenDocumentSource,
    type ScreenNode,
} from '@truebuild/contracts'

import { SHOWN_FACT_LIMIT, shownScreenSchema, type ShownBlock, type ShownScreen } from '../../providers/shown-screen'
import { canonicalJson, type GroundingContext } from './context'
import { intentAllowed } from './ground'
import { normalize } from './text'
import {
    ACTION_LABELS,
    CAMERA_CUES,
    CAMERA_PILLS,
    DETAILS_LABELS,
    headerTitles,
    instructionCopy,
    SOURCE_LABELS,
    TIP_COPY,
} from './ui-copy'

type Origin = ShownBlock['origin']
type Sources = NonNullable<ShownBlock['sources']>

/**
 * What a published step page showed, kept by the server when it issues the page. It is a projection of the validated
 * document only (never of a model draft). It is not trusted when it is used: `resolveShown` checks every selection
 * against the manual of the request before anything reaches a provider.
 */
export interface IssuedShown {
    header: ShownScreen['header']
    bar: ShownScreen['bar']
    blocks: ShownBlock[]
    /** The manual facts the document published and where each one shows. */
    facts: { factId: string; placement: 'body' | 'remainder' }[]
}

/** What a provider is given about the shown page: the composition plus the facts that were on it. */
export interface ResolvedShown {
    shown: ShownScreen | undefined
    facts: { id: string; kind: string; text: string }[]
}

const present = <K extends string, V>(key: K, list: readonly V[]): { [P in K]?: V[] } =>
    list.length === 0 ? {} : ({ [key]: [...list] } as { [P in K]?: V[] })

function project(
    node: ScreenNode,
    path: string,
    origin: Origin,
    cites: (indexes: readonly number[] | undefined) => Sources,
): ShownBlock {
    const base = { path, type: node.type, origin }
    switch (node.type) {
        case 'Instruction':
            return { ...base, emphasis: node.emphasis, text: node.text, ...present('sources', cites(node.citations)) }
        case 'Warning':
            return { ...base, tone: node.tone, text: node.text, ...present('sources', cites(node.citations)) }
        case 'ConfirmFact':
            return { ...base, text: node.text, ...present('sources', cites(node.citations)) }
        case 'HeroFigure':
            return {
                ...base,
                ...(node.caption === null ? {} : { text: node.caption }),
                figure: { source: node.source, refId: node.refId, fit: node.fit, region: node.region ?? null },
            }
        case 'PartList':
            return {
                ...base,
                parts: node.items.map((item) => ({ partId: item.partId, label: item.label, quantity: item.quantity })),
            }
        case 'QuantityChip':
            return { ...base, parts: [{ partId: node.partId, label: node.label, quantity: node.quantity }] }
        case 'ManualDirections':
            return { ...base, emphasis: node.emphasis, factIds: [...node.factIds] }
        case 'SourceDetails':
            return { ...base, label: node.label, ...present('sources', cites(node.sources)) }
        case 'CameraGuidance':
            return { ...base, label: node.cue }
        case 'ActionLink':
            return { ...base, label: node.label, emphasis: node.emphasis }
        case 'DetailsDisclosure':
            return { ...base, label: node.label }
        case 'Tip':
            return { ...base, label: node.heading }
        case 'Group':
        case 'StepProgress':
        case 'ChoiceList':
        case 'ResultBanner':
        case 'AnswerCard':
        case 'Skeleton':
        case 'PhotoWithRegions':
        case 'ManualLibrary':
        case 'PageGallery':
        case 'FactPrompt':
        case 'FactEditor':
        case 'QuestionComposer':
            return base
        default: {
            // A catalog addition must be projected deliberately, never silently dropped from what the model is told.
            const unprojected: never = node
            return unprojected
        }
    }
}

/** The projection of a published document. Origins are the server's own; an unknown origin is never claimed generated. */
export function issueShown(document: ScreenDocument): IssuedShown {
    const origins = document.metadata.origins
    const originOf = (path: string): Origin => (origins?.[path] === 'generated' ? 'generated' : 'fallback')
    const sources: readonly ScreenDocumentSource[] = document.sources ?? []
    const cites = (indexes: readonly number[] | undefined): Sources =>
        (indexes ?? [])
            .flatMap((index) => {
                const source = sources[index]
                return source === undefined ? [] : [{ pageId: source.pageId, region: source.region }]
            })
            .slice(0, SCREEN_LIMITS.citations)
    const blocks = document.body.flatMap((node, index): ShownBlock[] => [
        project(node, `body.${index}`, originOf(`body.${index}`), cites),
        ...(node.type === 'Group' || node.type === 'DetailsDisclosure'
            ? node.children.map((child, at) =>
                  project(child, `body.${index}.children.${at}`, originOf(`body.${index}.children.${at}`), cites),
              )
            : []),
    ])
    const action = (value: { label: string; intent: { intent: string; target: string } } | null): ShownAction | null =>
        value === null ? null : { label: value.label, intent: value.intent.intent, target: value.intent.target }
    return {
        header: { title: document.header.title, subtitle: document.header.subtitle },
        bar: { primary: action(document.bar.primary)!, secondary: action(document.bar.secondary) },
        blocks,
        facts: (document.manualFacts ?? []).map((fact) => ({ factId: fact.factId, placement: fact.placement })),
    }
}

type ShownAction = NonNullable<ShownScreen['bar']>['primary']

const regionKey = (region: unknown): string => canonicalJson(region ?? null)

/**
 * Re-verifies an issued projection against the manual of the current request. The document only chooses and orders:
 * fact texts, part names and quantities are read from the current manual, a region or source must be one the manual
 * itself carries, and wording must be closed interface copy or the manual's own words. Anything that fails is dropped,
 * never repaired, so a provider never receives an unverified claim about what the person saw.
 */
export function resolveShown(issued: IssuedShown, context: GroundingContext): ResolvedShown {
    const closed = new Set<string>(
        [
            ...instructionCopy(context),
            ...headerTitles(context),
            ...Object.values(ACTION_LABELS).flatMap((targets) => Object.values(targets).flat()),
            ...DETAILS_LABELS,
            ...SOURCE_LABELS,
            ...CAMERA_CUES,
            ...CAMERA_PILLS,
            ...Object.values(TIP_COPY).map((copy) => copy.heading),
        ].map(normalize),
    )
    const restatable = context.witnesses.filter(
        (witness) => witness.kind !== 'manual' && witness.kind !== 'part' && witness.complete,
    )
    const normalized = restatable.map((witness) => ({ witness, text: normalize(witness.text) }))
    // The manual's own words: a whole evidence unit or a verbatim piece of one (long text is shown in consecutive pieces).
    const manualWords = (text: string): boolean => {
        const wanted = normalize(text)
        return wanted !== '' && normalized.some((entry) => entry.text.includes(wanted))
    }
    const verifiedText = (text: string): boolean => closed.has(normalize(text)) || manualWords(text)
    const titleUnit = (text: string): boolean =>
        (context.units.get(normalize(text)) ?? []).some((unit) => unit.id === 'title' || unit.id === 'manual:title')
    const sources = new Set(context.sources.map((source) => `${source.pageId}|${regionKey(source.region)}`))
    const knownSource = (source: { pageId: string; region: unknown }): boolean =>
        sources.has(`${source.pageId}|${regionKey(source.region)}`)
    const manual = new Map(context.manualFacts.map((fact) => [fact.factId, fact]))

    const verifyAction = (action: ShownAction): ShownAction | null => {
        const intent = appIntentSchema.safeParse({ intent: action.intent, target: action.target })
        if (!intent.success || !intentAllowed(intent.data, context)) return null
        const labels =
            (ACTION_LABELS[intent.data.intent] as Record<string, readonly string[]>)[intent.data.target] ?? []
        return labels.some((label) => normalize(label) === normalize(action.label)) ? action : null
    }
    const header =
        issued.header !== undefined &&
        (headerTitles(context).some((title) => normalize(title) === normalize(issued.header!.title)) ||
            titleUnit(issued.header.title)) &&
        (issued.header.subtitle === null || titleUnit(issued.header.subtitle))
            ? issued.header
            : undefined
    const primary = issued.bar === undefined ? null : verifyAction(issued.bar.primary)
    const secondary = issued.bar?.secondary == null ? null : verifyAction(issued.bar.secondary)
    const bar = issued.bar !== undefined && primary !== null ? { primary, secondary } : undefined

    const blocks = issued.blocks.map((block): ShownBlock => {
        const { text, label, parts, factIds, figure, sources: cited, ...rest } = block
        const out: ShownBlock = { ...rest }
        if (text !== undefined && verifiedText(text)) out.text = text
        if (label !== undefined && closed.has(normalize(label))) out.label = label
        if (parts !== undefined) {
            const kept = parts.flatMap((part) => {
                const name = context.partNames.get(part.partId)
                if (name === undefined || normalize(name) !== normalize(part.label)) return []
                const quantity = context.quantities.get(part.partId)
                return [
                    { partId: part.partId, label: name, quantity: part.quantity === quantity ? part.quantity : null },
                ]
            })
            if (kept.length > 0) out.parts = kept
        }
        if (factIds !== undefined) {
            const kept = factIds.filter((id) => manual.has(id))
            if (kept.length > 0) out.factIds = kept
        }
        if (figure !== undefined) {
            // Capture heroes belong to result screens; a guide holds no capture, so one here is not accepted.
            const known =
                figure.source === 'page'
                    ? context.citedPageIds.has(figure.refId)
                    : figure.source === 'part'
                      ? context.stepPartIds.has(figure.refId)
                      : context.captureId !== null && figure.refId === context.captureId
            if (known) {
                // The emphasized region must be this page's own region from the manual, never anything else.
                const region =
                    figure.source === 'page' &&
                    figure.region !== null &&
                    knownSource({ pageId: figure.refId, region: figure.region })
                        ? figure.region
                        : null
                out.figure = { ...figure, region }
            }
        }
        if (cited !== undefined) {
            const kept = cited.filter(knownSource)
            if (kept.length > 0) out.sources = kept
        }
        return out
    })

    // The facts that were on the page: manual facts the page names or published as its remainder, and whole or sentence
    // evidence units its own text states. Order follows the page, then the remainder.
    const facts = new Map<string, { id: string; kind: string; text: string }>()
    const addManual = (id: string): void => {
        const fact = manual.get(id)
        if (fact !== undefined && !facts.has(id)) facts.set(id, { id, kind: fact.kind, text: fact.text })
    }
    for (const block of blocks) {
        if (block.text !== undefined) {
            for (const unit of context.units.get(normalize(block.text)) ?? []) {
                if (unit.kind === 'manual' || unit.kind === 'part' || !unit.complete) continue
                if (!facts.has(unit.id)) facts.set(unit.id, { id: unit.id, kind: unit.kind, text: unit.text })
            }
        }
        for (const id of block.factIds ?? []) addManual(id)
    }
    const remainderFactIds = issued.facts
        .filter((slot) => slot.placement === 'remainder' && manual.has(slot.factId))
        .map((slot) => slot.factId)
    for (const id of remainderFactIds) addManual(id)

    const parsed = shownScreenSchema.safeParse({
        ...(header === undefined ? {} : { header }),
        ...(bar === undefined ? {} : { bar }),
        blocks,
        remainderFactIds,
    })
    return {
        // A malformed projection is left out; it must never make a verdict request invalid.
        shown: parsed.success ? parsed.data : undefined,
        facts: [...facts.values()].slice(0, SHOWN_FACT_LIMIT),
    }
}
