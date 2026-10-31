import { z } from 'zod'

import {
    BOUND_TEXT_KEYS,
    CONTAINER_SHAPES_V2,
    CORE_BOUND_TEXT_KEYS,
    DOCUMENT_V2_LIMITS,
    LEAF_SCHEMAS_V2,
    barV2Schema,
    fixtureIdV2Schema,
    headerActionV2Schema,
    syntheticAuthorV2Schema,
    type CardNodeV2,
    type GridNodeV2,
    type RowNodeV2,
    type ScrollNodeV2,
    type SectionNodeV2,
    type StackNodeV2,
} from './document-v2'
import { isPlainScreenText } from './screen'
import { canonicalJson } from './screen-context'

/**
 * Model-authored PARAMETERIZED LAYOUT RECORD (version 1) for the two screens that publish an actual Spark result: `result`
 * (a check: pass, refuse or cannot_verify) and `answer`. A model authors layout, placement, styling, the row pattern of
 * repeated facts and every branch's actions ONCE; `compileLayoutTemplateV2` (see document-v2-layout-template-compile.ts)
 * turns it synchronously into a complete `ScreenDocumentV2` for the actual current result.
 *
 * The record holds NO data: no fact id, no fact text, no source index, no photo, no verdict, no title of a manual or a
 * step, no identity. Where the screen must state something witnessed it holds a typed SLOT that the compiler fills from
 * the shared material of the exact current inputs:
 *
 * - `FactText`        the words of the current fact of a `RepeatFacts` row (a fact reference, never copied text);
 * - `FactCitations`   the current fact's source indexes, in Citation nodes of at most `chunk` indexes (none: none);
 * - `ResultCard`      a VerdictCard bound to the current check or question;
 * - `{kind:'state'}`  the closed state/busy heading or detail copy of the variant being compiled (never in `ready`);
 * - `RepeatFacts`     one model-authored row per fact of a fact set, optionally grouped in model-authored containers;
 * - `WhenFacts`       its children only when the fact set is not empty (no dangling heading over nothing);
 * - `WhenPartTargets` (version 3, the held Question) its children only when a bound part chooser can resolve.
 *
 * Everything else is the existing catalog, unchanged and strictly typed. Actions live only in each variant's `bar` and
 * in the typed header controls; the compiler adds none. The existing shared gates (structure, mandatory witnesses,
 * closed interface copy, earned state, intents) decide whether the compiled document is acceptable.
 */
export const LAYOUT_TEMPLATE_V2_VERSION = 1 as const
/**
 * `result` records of this version also carry the `ready.checking` branch: the screen of the held photo before its check
 * returns (see `pendingCheckV2`). Version 1 records are unchanged and cannot compile that screen.
 */
export const LAYOUT_TEMPLATE_V2_CHECKING_VERSION = 2 as const
/**
 * `questions` records exist only in this version: the Question sheet over the photo the app holds (one ready variant
 * and the five waiting, empty and failing variants, no result). They alone may place the catalog's `TextField` (the
 * question) and its bound part-target `Choice` (the latter only inside `WhenPartTargets`); versions 1 and 2 refuse
 * all three.
 */
export const LAYOUT_TEMPLATE_V2_QUESTIONS_VERSION = 3 as const

/**
 * Resource guards of the RECORD itself (the compiled document keeps `DOCUMENT_V2_LIMITS` untouched). They bound the work
 * of validating an untrusted record, not its quality; none was chosen by measurement.
 */
export const LAYOUT_TEMPLATE_LIMITS_V2 = {
    /** Template nodes of one record, every variant together (a repeated row counts once, not once per fact). */
    nodes: 2048,
    /** Nesting of one template tree (the compiled tree may be one level deeper where a group wraps the rows). */
    depth: DOCUMENT_V2_LIMITS.depth,
    /** Nesting of the raw JSON accepted before any schema runs. */
    jsonDepth: 64,
} as const

/**
 * Fact sets a `RepeatFacts` / `WhenFacts` selects from the facts the compiled VARIANT may state (a waiting or failing
 * variant of a held result is never offered the result: its result sets are empty, and the record may not use them there).
 *
 * - `safety`      manual facts of kind `safety`, the unresolved-safety statement included;
 * - `directions`  required manual facts that are not safety;
 * - `details`     optional manual facts (not required, not safety);
 * - `verdict`     the one `result:verdict` / `result:answer` fact (ready only);
 * - `missing`     the `result:missing:N` / `result:answer-missing:N` facts (ready only).
 */
export const FACT_SETS_V2 = ['safety', 'directions', 'details', 'verdict', 'missing'] as const
export type FactSetV2 = (typeof FACT_SETS_V2)[number]
/** The sets that read the actual result: legal in the ready variants only. */
export const RESULT_FACT_SETS_V2: readonly FactSetV2[] = ['verdict', 'missing']

// ---------------------------------------------------------------------------------------------------------------------
// Text references: wording only. No fact reference (a fact is stated through a slot), no free placeholder.
// ---------------------------------------------------------------------------------------------------------------------

// A free placeholder (`{name}`, `{{name}}`, `${name}`, `%s`, `[[name]]`) would invite later substitution; never accepted.
const PLACEHOLDER = /\{|\}|\$\{|%[sd@]|\[\[|\]\]/u

const literalText = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(isPlainScreenText, { message: 'Plain text required' })
    .refine((text) => !PLACEHOLDER.test(text), { message: 'No placeholder in text' })
const literalRef = z.strictObject({ kind: z.literal('literal'), text: literalText })
/** Closed state copy of the variant being compiled: its busy/state heading or detail. Not available in `ready`. */
const stateRef = z.strictObject({ kind: z.literal('state'), part: z.enum(['heading', 'detail']) })

export const templateLabelRefSchema = z.discriminatedUnion('kind', [
    literalRef,
    z.strictObject({ kind: z.literal('bound'), key: z.enum(CORE_BOUND_TEXT_KEYS) }),
    stateRef,
])
export type TemplateLabelRefV2 = z.infer<typeof templateLabelRefSchema>
export const templateBodyRefSchema = z.discriminatedUnion('kind', [
    literalRef,
    z.strictObject({ kind: z.literal('bound'), key: z.enum(BOUND_TEXT_KEYS) }),
    stateRef,
])
export type TemplateBodyRefV2 = z.infer<typeof templateBodyRefSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Nodes. The catalog leaves a record may place, re-typed only where a text reference or a source is replaced by a slot.
// ---------------------------------------------------------------------------------------------------------------------

type LeafSchema = (typeof LEAF_SCHEMAS_V2)[number]
type LeafOf<T extends string> = Extract<LeafSchema, { shape: { type: z.ZodLiteral<T> } }>

function leafOf<T extends string>(type: T): LeafOf<T> {
    const found = LEAF_SCHEMAS_V2.find((schema) => schema.shape.type.value === type)
    if (found === undefined) throw new Error(`Unknown catalog leaf ${type}`)

    return found as unknown as LeafOf<T>
}

function node<T extends string, S extends z.ZodRawShape>(
    type: T,
    shape: S,
): z.ZodObject<{ type: z.ZodLiteral<T> } & S, z.core.$strict> {
    return z.strictObject({ type: z.literal(type), ...shape })
}

const textShape = leafOf('Text').shape
const { content: _content, type: _textType, ...textLook } = textShape
const citationShape = leafOf('Citation').shape
const verdictShape = leafOf('VerdictCard').shape
const labelOrNull = templateLabelRefSchema.nullable()

const textNode = node('Text', { ...textLook, content: templateBodyRefSchema })
const imageNode = node('Image', {
    // The held photo only: a page, a part or a cited-source picture would need an identity the record must not hold.
    source: z.strictObject({ kind: z.literal('capture') }),
    fit: leafOf('Image').shape.fit,
    ratio: leafOf('Image').shape.ratio,
    caption: labelOrNull,
})
const badgeNode = node('Badge', { label: templateLabelRefSchema, tone: leafOf('Badge').shape.tone })
const checklistNode = node('Checklist', {
    items: z
        .array(z.strictObject({ label: templateLabelRefSchema, state: z.enum(['todo', 'done', 'note']) }))
        .min(1)
        .max(24),
})
const progressNode = node('Progress', { binding: leafOf('Progress').shape.binding, label: labelOrNull })
const meterNode = node('Meter', {
    binding: leafOf('Meter').shape.binding,
    label: labelOrNull,
    tone: leafOf('Meter').shape.tone,
})
const iconNode = leafOf('Icon')
const dividerNode = leafOf('Divider')
const spacerNode = leafOf('Spacer')

/** The words of the CURRENT fact of the enclosing `RepeatFacts` row: compiled to a Text of `{kind:'fact', factId}`. */
const factTextNode = node('FactText', textLook)
/** The current fact's source indexes, `chunk` per Citation node (none for a fact without sources). */
const factCitationsNode = node('FactCitations', {
    display: citationShape.display,
    label: labelOrNull,
    chunk: z.number().int().min(1).max(DOCUMENT_V2_LIMITS.citationIndexes),
})
/** A VerdictCard of the CURRENT result (check on `result`, question on `answer`). Ready variants only. */
const resultCardNode = node('ResultCard', {
    variant: verdictShape.variant,
    showReason: verdictShape.showReason,
    showRegions: verdictShape.showRegions,
})

const LEAVES = [
    textNode,
    iconNode,
    imageNode,
    badgeNode,
    checklistNode,
    progressNode,
    meterNode,
    dividerNode,
    spacerNode,
    factTextNode,
    factCitationsNode,
    resultCardNode,
] as const

export type TemplateLeafV2 = z.infer<(typeof LEAVES)[number]>

/**
 * The catalog's own two Question leaves, re-typed narrowly (version 3 only). The field binds the question and nothing
 * else; the chooser binds the part target and nothing else, so it can never offer intents or languages or carry a part.
 */
const textFieldNode = node('TextField', {
    binding: z.literal('question'),
    label: templateLabelRefSchema,
    placeholder: z.null(),
})
const choiceNode = node('Choice', {
    prompt: labelOrNull,
    options: z.strictObject({ mode: z.literal('bound'), binding: z.literal('part-target') }),
})
const QUESTION_LEAVES = [textFieldNode, choiceNode] as const

export type TemplateQuestionLeafV2 = z.infer<(typeof QUESTION_LEAVES)[number]>

type Bare<T extends { children: unknown }> = Omit<T, 'children'>

export interface TemplateStackV2 extends Bare<StackNodeV2> {
    children: TemplateNodeV2[]
}
export interface TemplateRowV2 extends Bare<RowNodeV2> {
    children: TemplateNodeV2[]
}
export interface TemplateGridV2 extends Bare<GridNodeV2> {
    children: TemplateNodeV2[]
}
export interface TemplateCardV2 extends Bare<CardNodeV2> {
    children: TemplateNodeV2[]
}
export interface TemplateSectionV2 extends Omit<SectionNodeV2, 'children' | 'title'> {
    title: TemplateLabelRefV2 | null
    children: TemplateNodeV2[]
}
export interface TemplateScrollV2 extends Bare<ScrollNodeV2> {
    children: TemplateNodeV2[]
}
export type TemplateContainerV2 =
    TemplateStackV2 | TemplateRowV2 | TemplateGridV2 | TemplateCardV2 | TemplateSectionV2 | TemplateScrollV2

/** A container as the wrapper of a group of repeated rows (no title, so never a Section). */
export type TemplateGroupContainerV2 =
    Bare<StackNodeV2> | Bare<RowNodeV2> | Bare<GridNodeV2> | Bare<CardNodeV2> | Bare<ScrollNodeV2>

/**
 * One row per fact of `source`, in material order. `row` is the model's own row pattern (a container whose descendants
 * may hold `FactText` and `FactCitations`). `group` is the model's own grouping: rows are wrapped, `size` at a time, in
 * a copy of `container` (the way a very large manual stays within the children and node guards); null: the rows are
 * placed directly in the parent. No fact: no node.
 */
export interface RepeatFactsV2 {
    type: 'RepeatFacts'
    source: FactSetV2
    group: { size: number; container: TemplateGroupContainerV2 } | null
    row: TemplateContainerV2
}
/** Its children only when `source` selects at least one fact; they are placed directly in the parent. */
export interface WhenFactsV2 {
    type: 'WhenFacts'
    source: FactSetV2
    children: TemplateNodeV2[]
}
/**
 * Version 3 only. Its children, placed directly in the parent, only when the current material can resolve a bound
 * part-target `Choice`: the app holds the photo and the step has at least one named part. The record supplies no part,
 * id, label or figure; the part list stays the app's own.
 */
export interface WhenPartTargetsV2 {
    type: 'WhenPartTargets'
    children: TemplateNodeV2[]
}
/** Every node any record version may place; which versions accept which node is decided by their schemas. */
export type TemplateNodeV2 =
    TemplateLeafV2 | TemplateQuestionLeafV2 | TemplateContainerV2 | RepeatFactsV2 | WhenFactsV2 | WhenPartTargetsV2

const children = (schema: z.ZodType<TemplateNodeV2>): z.ZodArray<z.ZodType<TemplateNodeV2>> =>
    z.array(schema).max(DOCUMENT_V2_LIMITS.children)

const GROUP_TYPES = ['Stack', 'Row', 'Grid', 'Card', 'Scroll'] as const
const factSet = z.enum(FACT_SETS_V2)

const groupSchema = z.strictObject({
    size: z.number().int().min(1).max(DOCUMENT_V2_LIMITS.children),
    container: z.discriminatedUnion(
        'type',
        GROUP_TYPES.map((type) => node(type, CONTAINER_SHAPES_V2[type])) as unknown as [
            z.ZodObject<{ type: z.ZodLiteral<string> }>,
        ],
    ),
})

interface Dialect {
    node: z.ZodType<TemplateNodeV2>
    row: z.ZodType<TemplateContainerV2>
}

/**
 * The recursive schemas of one record dialect. Versions 1 and 2 share the first; version 3 (the held Question) adds the
 * form field, the part chooser and the part conditional to the nodes a record may place, and nothing else, so the older
 * dialects refuse all three exactly as they always have.
 */
function dialectOf(question: boolean): Dialect {
    const containerOf = (type: keyof typeof CONTAINER_SHAPES_V2): z.ZodType<TemplateContainerV2> => {
        const shape =
            type === 'Section' ? { ...CONTAINER_SHAPES_V2.Section, title: labelOrNull } : CONTAINER_SHAPES_V2[type]

        return node(type, { ...shape, children: children(nodeSchema) }) as unknown as z.ZodType<TemplateContainerV2>
    }
    const row: z.ZodType<TemplateContainerV2> = z.lazy(() =>
        z.discriminatedUnion('type', [
            containerOf('Stack'),
            containerOf('Row'),
            containerOf('Grid'),
            containerOf('Card'),
            containerOf('Section'),
            containerOf('Scroll'),
        ] as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>]),
    ) as unknown as z.ZodType<TemplateContainerV2>
    const nodeSchema: z.ZodType<TemplateNodeV2> = z.lazy(() =>
        z.discriminatedUnion('type', [
            ...LEAVES,
            ...(question ? QUESTION_LEAVES : []),
            containerOf('Stack'),
            containerOf('Row'),
            containerOf('Grid'),
            containerOf('Card'),
            containerOf('Section'),
            containerOf('Scroll'),
            node('RepeatFacts', { source: factSet, group: groupSchema.nullable(), row }),
            node('WhenFacts', { source: factSet, children: children(nodeSchema) }),
            ...(question ? [node('WhenPartTargets', { children: children(nodeSchema) })] : []),
        ] as unknown as [(typeof LEAVES)[number]]),
    ) as unknown as z.ZodType<TemplateNodeV2>

    return { node: nodeSchema, row }
}

const baseDialect = dialectOf(false)
const questionsDialect = dialectOf(true)
export const templateNodeSchema: z.ZodType<TemplateNodeV2> = baseDialect.node

// ---------------------------------------------------------------------------------------------------------------------
// Variants and the record.
// ---------------------------------------------------------------------------------------------------------------------

const templateHeaderSchema = z.strictObject({
    title: templateLabelRefSchema,
    subtitle: labelOrNull,
    back: headerActionV2Schema.nullable(),
    actions: z.array(headerActionV2Schema).max(DOCUMENT_V2_LIMITS.headerActions),
})
export type TemplateHeaderV2 = z.infer<typeof templateHeaderSchema>

/** One variant. No overlays: a result, answer or question screen has no coach target. The bar is the typed bar. */
export interface TemplateVariantV2 {
    header: TemplateHeaderV2
    body: TemplateContainerV2
    bar: z.infer<typeof barV2Schema>
}
const variantSchemaOf = (body: z.ZodType<TemplateContainerV2>): z.ZodType<TemplateVariantV2> =>
    z.strictObject({
        header: templateHeaderSchema,
        body,
        bar: barV2Schema,
    }) as unknown as z.ZodType<TemplateVariantV2>
export const templateVariantSchema = variantSchemaOf(baseDialect.row)
const questionsVariantSchema = variantSchemaOf(questionsDialect.row)

/** The waiting and failing variants every result or answer screen owes (`requiredStatesV2`); empty and confirming do not exist. */
export interface TemplateStatesV2 {
    busy: TemplateVariantV2
    pending: TemplateVariantV2
    error: TemplateVariantV2
    recovery: TemplateVariantV2
}
const statesSchema = z.strictObject({
    busy: templateVariantSchema,
    pending: templateVariantSchema,
    error: templateVariantSchema,
    recovery: templateVariantSchema,
})
/** The variants a Question sheet owes (`requiredStatesV2('questions')`): the same four, and the empty one. */
export interface QuestionsTemplateStatesV2 extends TemplateStatesV2 {
    empty: TemplateVariantV2
}
const questionsStatesSchema = z.strictObject({
    busy: questionsVariantSchema,
    pending: questionsVariantSchema,
    empty: questionsVariantSchema,
    error: questionsVariantSchema,
    recovery: questionsVariantSchema,
})

/** The decisions of a held check, each its own explicit ready variant. */
export const LAYOUT_DECISIONS_V2 = ['pass', 'refuse', 'cannot_verify'] as const
export type LayoutDecisionV2 = (typeof LAYOUT_DECISIONS_V2)[number]

interface TemplateBaseV2<V extends number> {
    version: V
    /** Identity of this authoring; must equal `provenance.authoring.fixtureId`. */
    fixtureId: string
    states: TemplateStatesV2
}
/** A check: one explicit ready variant per decision; the compiler reads the actual decision and nothing else to choose. */
export interface ResultLayoutTemplateV2 extends TemplateBaseV2<typeof LAYOUT_TEMPLATE_V2_VERSION> {
    kind: 'result'
    ready: Record<LayoutDecisionV2, TemplateVariantV2>
}
/**
 * A check, version 2: the ready variants of version 1 plus `checking`, the screen of the actual held photo while its
 * check has not returned. It is a ready slot with the state-style copy of the checking activity (`{kind:'state'}`
 * refs are allowed) and no result: result slots are refused there, exactly as in a state variant.
 */
export interface CheckingResultLayoutTemplateV2 extends TemplateBaseV2<typeof LAYOUT_TEMPLATE_V2_CHECKING_VERSION> {
    kind: 'result'
    ready: Record<LayoutDecisionV2, TemplateVariantV2> & { checking: TemplateVariantV2 }
}
/** An answer: one ready variant. */
export interface AnswerLayoutTemplateV2 extends TemplateBaseV2<typeof LAYOUT_TEMPLATE_V2_VERSION> {
    kind: 'answer'
    ready: TemplateVariantV2
}
/**
 * A Question, version 3: the sheet over the photo the app holds. One ready variant (no decision, no checking, no
 * result) and the five states it owes. The only record that may place `TextField`, `Choice` and `WhenPartTargets`.
 */
export interface QuestionsLayoutTemplateV2 extends TemplateBaseV2<typeof LAYOUT_TEMPLATE_V2_QUESTIONS_VERSION> {
    kind: 'questions'
    ready: TemplateVariantV2
    states: QuestionsTemplateStatesV2
}
export type LayoutTemplateV2 =
    ResultLayoutTemplateV2 | CheckingResultLayoutTemplateV2 | AnswerLayoutTemplateV2 | QuestionsLayoutTemplateV2

const resultTemplateSchema = z.strictObject({
    version: z.literal(LAYOUT_TEMPLATE_V2_VERSION),
    fixtureId: fixtureIdV2Schema,
    kind: z.literal('result'),
    ready: z.strictObject({
        pass: templateVariantSchema,
        refuse: templateVariantSchema,
        cannot_verify: templateVariantSchema,
    }),
    states: statesSchema,
})
const answerTemplateSchema = z.strictObject({
    version: z.literal(LAYOUT_TEMPLATE_V2_VERSION),
    fixtureId: fixtureIdV2Schema,
    kind: z.literal('answer'),
    ready: templateVariantSchema,
    states: statesSchema,
})
const checkingResultTemplateSchema = z.strictObject({
    version: z.literal(LAYOUT_TEMPLATE_V2_CHECKING_VERSION),
    fixtureId: fixtureIdV2Schema,
    kind: z.literal('result'),
    ready: z.strictObject({
        pass: templateVariantSchema,
        refuse: templateVariantSchema,
        cannot_verify: templateVariantSchema,
        checking: templateVariantSchema,
    }),
    states: statesSchema,
})
const questionsTemplateSchema = z.strictObject({
    version: z.literal(LAYOUT_TEMPLATE_V2_QUESTIONS_VERSION),
    fixtureId: fixtureIdV2Schema,
    kind: z.literal('questions'),
    ready: questionsVariantSchema,
    states: questionsStatesSchema,
})
/** Version 1 records, exactly as they have always parsed. */
const layoutTemplateV1Schema = z.discriminatedUnion('kind', [resultTemplateSchema, answerTemplateSchema])
/** Every record version. `parseLayoutTemplateV2` selects the schema by the record's own version, for precise issues. */
export const layoutTemplateV2Schema = z.union([
    questionsTemplateSchema,
    checkingResultTemplateSchema,
    layoutTemplateV1Schema,
]) as unknown as z.ZodType<LayoutTemplateV2>

/**
 * Who authored the record, kept beside it (a sidecar), never inside it: the self-attested offline author (the same
 * `SyntheticAuthorV2` the recorded synthetic documents carry; NOT a provider response, so the compiled document claims no
 * model, effort, timing or usage) and the SHA-256 of the record's canonical JSON (`layoutTemplateSha256V2`), which the
 * compiler recomputes and must match.
 */
export const layoutTemplateProvenanceV2Schema = z.strictObject({
    authoring: syntheticAuthorV2Schema,
    templateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
export type LayoutTemplateProvenanceV2 = z.infer<typeof layoutTemplateProvenanceV2Schema>

// ---------------------------------------------------------------------------------------------------------------------
// Parsing an untrusted record, and the record-only (input independent) rules.
// ---------------------------------------------------------------------------------------------------------------------

/** Canonical hash of a record as the provenance carries it. */
export const layoutTemplateSha256V2 = (template: LayoutTemplateV2, sha256Hex: (text: string) => string): string =>
    sha256Hex(canonicalJson(template))

/** Whether untrusted JSON nests deeper than `max` (iterative: a hostile depth must not overflow the stack). */
function nestsDeeperThan(value: unknown, max: number): boolean {
    const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }]
    for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        if (top.depth > max) return true
        if (typeof top.value !== 'object' || top.value === null) continue
        for (const entry of Object.values(top.value)) stack.push({ value: entry, depth: top.depth + 1 })
    }

    return false
}

const WAITING_STATES = ['busy', 'pending', 'error', 'recovery'] as const
const QUESTION_STATES = ['busy', 'pending', 'empty', 'error', 'recovery'] as const

/**
 * Every variant of a record with its template path (`ready.pass`, `ready`, `ready.checking`, `states.busy`, ...),
 * whether it fills the document's ready slot, whether it may state the actual result (`result`: the decision branches
 * and the answer; not a state variant, not the checking branch and not a Question, which have no result to state), and
 * whether it may use the closed state copy of a waiting or failing screen (`stateCopy`: the state variants and the
 * checking branch; never a variant that states a verdict, nor the ready Question, which uses its own words).
 */
export function layoutTemplateVariantsV2(template: LayoutTemplateV2): {
    path: string
    ready: boolean
    result: boolean
    stateCopy: boolean
    variant: TemplateVariantV2
}[] {
    const ready =
        template.kind === 'result'
            ? [
                  ...LAYOUT_DECISIONS_V2.map((decision) => ({
                      path: `ready.${decision}`,
                      ready: true,
                      result: true,
                      stateCopy: false,
                      variant: template.ready[decision],
                  })),
                  ...(template.version === LAYOUT_TEMPLATE_V2_CHECKING_VERSION
                      ? [
                            {
                                path: 'ready.checking',
                                ready: true,
                                result: false,
                                stateCopy: true,
                                variant: template.ready.checking,
                            },
                        ]
                      : []),
              ]
            : [
                  {
                      path: 'ready',
                      ready: true,
                      result: template.kind === 'answer',
                      stateCopy: false,
                      variant: template.ready,
                  },
              ]
    const states =
        template.kind === 'questions'
            ? QUESTION_STATES.map((state) => ({
                  path: `states.${state}`,
                  ready: false,
                  result: false,
                  stateCopy: true,
                  variant: template.states[state],
              }))
            : WAITING_STATES.map((state) => ({
                  path: `states.${state}`,
                  ready: false,
                  result: false,
                  stateCopy: true,
                  variant: template.states[state],
              }))

    return [...ready, ...states]
}

const ROW_LEAVES: ReadonlySet<string> = new Set([
    'Text',
    'Icon',
    'Badge',
    'Divider',
    'Spacer',
    'FactText',
    'FactCitations',
])
const CONTAINERS: ReadonlySet<string> = new Set(['Stack', 'Row', 'Grid', 'Card', 'Section', 'Scroll'])

/** Text references a template node carries (wording only: slots carry none). */
function refsOf(item: TemplateNodeV2): (TemplateBodyRefV2 | TemplateLabelRefV2)[] {
    switch (item.type) {
        case 'Text':
            return [item.content]
        case 'Badge':
            return [item.label]
        case 'Image':
            return item.caption === null ? [] : [item.caption]
        case 'Progress':
        case 'Meter':
        case 'FactCitations':
            return item.label === null ? [] : [item.label]
        case 'Checklist':
            return item.items.map((entry) => entry.label)
        case 'Section':
            return item.title === null ? [] : [item.title]
        case 'TextField':
            return [item.label]
        case 'Choice':
            return item.prompt === null ? [] : [item.prompt]
        default:
            return []
    }
}

type VariantEntry = ReturnType<typeof layoutTemplateVariantsV2>[number]

/**
 * Rules of the record alone, before any input is known: where slots and state copy may stand and the size of the record.
 * Machine codes `template:<template path>:<rule>`; a template path names the raw JSON location
 * (`ready.pass.body.children.2.row.children.0`, `states.busy.header`, ...).
 */
export function layoutTemplateIssuesV2(template: LayoutTemplateV2): string[] {
    const issues = new Set<string>()
    const add = (path: string, rule: string): void => {
        issues.add(`template:${path}:${rule}`)
    }
    let count = 0
    const walk = (
        item: TemplateNodeV2,
        path: string,
        depth: number,
        rules: Pick<VariantEntry, 'result' | 'stateCopy'>,
        row: boolean,
        partTargets: boolean,
    ): void => {
        count += 1
        if (depth > LAYOUT_TEMPLATE_LIMITS_V2.depth) add(path, 'too_deep')
        if (row && !ROW_LEAVES.has(item.type) && !CONTAINERS.has(item.type)) add(path, 'not_in_row')
        if ((item.type === 'FactText' || item.type === 'FactCitations') && !row) add(path, 'slot_outside_row')
        if (item.type === 'ResultCard' && !rules.result) add(path, 'result_slot_in_state')
        if (refsOf(item).some((ref) => ref.kind === 'state') && !rules.stateCopy) add(path, 'state_copy_in_ready')
        if (item.type === 'RepeatFacts' || item.type === 'WhenFacts') {
            if (!rules.result && RESULT_FACT_SETS_V2.includes(item.source)) add(path, 'result_slot_in_state')
        }
        // A chooser outside the conditional could not compile for a step without parts: refused here, not per input.
        if (item.type === 'Choice' && !partTargets) add(path, 'choice_outside_when_part_targets')
        if (item.type === 'RepeatFacts') {
            count += item.group === null ? 0 : 1
            walk(item.row, `${path}.row`, depth + (item.group === null ? 1 : 2), rules, true, partTargets)
        } else if ('children' in item) {
            const inside = partTargets || item.type === 'WhenPartTargets'
            item.children.forEach((child, index) =>
                walk(child, `${path}.children.${index}`, depth + 1, rules, row, inside),
            )
        }
        if (item.type === 'WhenFacts' && row) add(path, 'not_in_row')
    }
    for (const entry of layoutTemplateVariantsV2(template)) {
        const { header } = entry.variant
        if ([header.title, header.subtitle].some((ref) => ref?.kind === 'state') && !entry.stateCopy) {
            add(`${entry.path}.header`, 'state_copy_in_ready')
        }
        walk(entry.variant.body, `${entry.path}.body`, 1, entry, false, false)
    }
    if (count > LAYOUT_TEMPLATE_LIMITS_V2.nodes) add('', 'too_many_nodes')

    return [...issues]
}

export type LayoutTemplateParseV2 =
    { ok: true; template: LayoutTemplateV2; canonical: string } | { ok: false; issues: string[] }

/** The schema of a record's own version (a record that names no known version is judged as version 1, as before). */
function layoutTemplateSchemaOf(raw: unknown): z.ZodType<LayoutTemplateV2> {
    const version = typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
    const schema =
        version === LAYOUT_TEMPLATE_V2_CHECKING_VERSION
            ? checkingResultTemplateSchema
            : version === LAYOUT_TEMPLATE_V2_QUESTIONS_VERSION
              ? questionsTemplateSchema
              : layoutTemplateV1Schema

    return schema as unknown as z.ZodType<LayoutTemplateV2>
}

/**
 * Parses an untrusted record (JSON already parsed by the caller). Strict: nothing unknown is accepted or dropped, so the
 * parsed value is the raw value (a record the schema would normalize, say untrimmed text, is refused: its hash would
 * not be the hash of what the author wrote). Machine codes only, never the rejected content.
 */
export function parseLayoutTemplateV2(raw: unknown): LayoutTemplateParseV2 {
    if (nestsDeeperThan(raw, LAYOUT_TEMPLATE_LIMITS_V2.jsonDepth)) return { ok: false, issues: ['template::too_deep'] }
    const parsed = layoutTemplateSchemaOf(raw).safeParse(raw)
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `template:${issue.path.map(String).join('.')}:${issue.code}`)

        return { ok: false, issues: [...new Set(issues)].slice(0, 16) }
    }
    const canonical = canonicalJson(parsed.data)
    if (canonical !== canonicalJson(raw)) return { ok: false, issues: ['template::not_canonical'] }
    const rules = layoutTemplateIssuesV2(parsed.data)

    return rules.length > 0 ? { ok: false, issues: rules.slice(0, 16) } : { ok: true, template: parsed.data, canonical }
}
