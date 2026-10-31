import { z } from 'zod'

import { canonicalJson } from './screen-context'
import { aiEffortSchema } from './telemetry'
import {
    appIntentSchema,
    ICON_NAMES,
    isPlainScreenText,
    MANUAL_FACT_BASES,
    MANUAL_FACT_KINDS,
    SCREEN_KINDS,
    screenBoundSchema,
    screenSourceSchema,
    screenUiStateSchema,
    TIP_TARGETS,
    type AppIntent,
    type ScreenKind,
} from './screen'

/**
 * Whole-screen document, version 2. The model owns EVERY node it chooses: header, back and actions, the recursive body
 * tree, the fixed action bar, overlays and coach marks, and a full variant for each busy/pending/empty/error/recovery
 * state. The server owns identity, provenance, timing, the fact and source tables and the mandatory-witness list; it
 * never appends, merges or repairs content into a model document (a document that omits a mandatory witness is
 * rejected, repaired once, then replaced by the complete deterministic document of the same catalog).
 *
 * Strictly additive: the v1 `ScreenDocument` exports keep working. Version 2 must be requested explicitly.
 */
export const SCREEN_DOCUMENT_V2_VERSION = 2 as const
/** Catalog of the version 2 document family (node types, tokens, bindings). */
export const SCREEN_CATALOG_V2_VERSION = 2 as const

/**
 * PROVISIONAL resource guards. They bound memory and validation work, not quality, and none was chosen by measurement:
 * the native device benchmark and the paid live run justify (or change) them before acceptance. Two different things are
 * bounded: what ONE variant asks a renderer to hold (`nodes`, `depth`, `children`) and what the whole document costs to
 * send (`documentNodes`, the flat wire payload of every variant together).
 */
export const DOCUMENT_V2_LIMITS = {
    /**
     * Nodes in ONE variant (body, bar and overlays): the render bound of the active screen. Derived from the largest
     * valid manual step (305 required facts, each a Text plus a Citation, plus grouping), not from a device.
     */
    nodes: 1024,
    /** Nodes in the whole document, every variant together: the payload budget (six variants at the render bound). */
    documentNodes: 6144,
    /** Depth of one tree (its root is depth 1). */
    depth: 12,
    children: 64,
    overlays: 4,
    headerActions: 3,
    /**
     * The most facts one step can publish (304 manual facts) plus the most a held check (verdict + 100 missing) and a
     * companion answer (answer + 100 missing) add.
     */
    facts: 506,
    /** Distinct sources one document can cite: one own region per manual fact plus the step diagram. Beyond: page-level. */
    sources: 320,
    /** Source indexes one citation node lists: every manual page, so a page-level citation of any fact fits one node. */
    citationIndexes: 20,
    manualLibrary: 12,
} as const

/** The v1 kinds plus the full-screen camera, the judge view and the manual comparison, each a distinct document. */
export const SCREEN_KINDS_V2 = [...SCREEN_KINDS, 'camera', 'judge', 'compare'] as const
export const screenKindV2Schema = z.enum(SCREEN_KINDS_V2)
export type ScreenKindV2 = z.infer<typeof screenKindV2Schema>

/** Kinds bound to one step of a reviewed manual (camera only in `build-photo` mode, see `uiState.camera`). */
export const STEP_KINDS_V2: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>([
    'guide',
    'result',
    'questions',
    'answer',
    'recovery',
    'camera',
])

export const VARIANT_STATES = ['busy', 'pending', 'empty', 'error', 'recovery', 'confirming'] as const
export type VariantState = (typeof VARIANT_STATES)[number]
const EMPTY_STATE_KINDS: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>([
    'home',
    'add',
    'pages',
    'questions',
    'compare',
])

/**
 * Variants a document of this kind must carry (the rest are optional). `confirming` (the Stop/Keep confirmation of a
 * reading that is being cancelled) is required exactly when the requirements carry its actions (the reading
 * cancellation witness), and is rejected otherwise.
 */
export function requiredStatesV2(kind: ScreenKindV2, requirements?: Pick<RequirementsV2, 'confirm'>): VariantState[] {
    const states: VariantState[] = EMPTY_STATE_KINDS.has(kind)
        ? ['busy', 'pending', 'empty', 'error', 'recovery']
        : ['busy', 'pending', 'error', 'recovery']
    return kind === 'reading' && (requirements?.confirm.length ?? 0) > 0 ? [...states, 'confirming'] : states
}

const NONCRITICAL_KINDS: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>([
    'home',
    'reading',
    'guide',
    'completion',
    'judge',
    'compare',
    'result',
    'answer',
])
/**
 * `step-page` (noncritical, Wonder policy stage) for home, reading, every guide, completion, judge, compare and the
 * result and answer screens (the verdict or answer itself is already published by the Spark API; the app shows the
 * complete photo-gated deterministic document at once and swaps in the composed one); `screen` (latency-sensitive,
 * Spark policy stage, effort still unmeasured) for the rest, More included.
 */
export function screenStageV2(kind: ScreenKindV2): 'screen' | 'step-page' {
    return NONCRITICAL_KINDS.has(kind) ? 'step-page' : 'screen'
}

/** Closed intents a document of this kind may offer. The server additionally gates review state and the held verdict. */
export const INTENTS_BY_KIND_V2: Readonly<Record<ScreenKindV2, readonly AppIntent['intent'][]>> = {
    home: ['navigate', 'capture', 'open-details', 'show-tips'],
    add: ['navigate', 'capture', 'open-details', 'show-tips'],
    pages: ['navigate', 'capture', 'confirm', 'open-details', 'show-tips'],
    reading: ['navigate', 'retry', 'open-details', 'show-tips'],
    'quick-check': ['navigate', 'confirm', 'retry', 'ask', 'open-details', 'show-tips'],
    guide: ['navigate', 'capture', 'check', 'ask', 'confirm', 'open-details', 'show-tips'],
    camera: ['navigate', 'capture', 'confirm', 'retry', 'open-details', 'show-tips'],
    result: ['navigate', 'capture', 'check', 'ask', 'confirm', 'retry', 'open-details', 'show-tips'],
    questions: ['navigate', 'capture', 'ask', 'open-details', 'show-tips'],
    answer: ['navigate', 'capture', 'ask', 'confirm', 'open-details', 'show-tips'],
    // Ask, capture and confirm exist only for a More that holds a reviewed step (and a held photo / pass): see intentAllowedV2.
    more: ['navigate', 'open-details', 'show-tips', 'ask', 'capture', 'confirm'],
    completion: ['navigate', 'open-details', 'show-tips'],
    error: ['navigate', 'retry', 'open-details'],
    recovery: ['navigate', 'capture', 'check', 'ask', 'retry', 'open-details', 'show-tips'],
    judge: ['navigate', 'open-details', 'show-tips'],
    compare: ['navigate', 'open-details', 'show-tips'],
}

/** The reading cancellation witness: the app confirms before it stops a running reading (see the `confirming` variant). */
export const READING_CANCELLATION_V2 = 'confirm-before-stop' as const
/** What the app is busy doing, in the closed words the busy variant is authored for (see `BUSY_COPY_V2`). */
export const BUSY_ACTIVITIES_V2 = [
    'working',
    'reading',
    'checking',
    'second-opinion',
    'asking',
    'question-waiting',
    'saving',
] as const
export type BusyActivityV2 = (typeof BUSY_ACTIVITIES_V2)[number]

/**
 * App state a v2 composition may bind to: the v1 state plus the camera and judge views and the witnesses below. Ids,
 * flags and closed words only. A kind uses (and its context key covers) only the fields `screenUiForKindV2` lists.
 */
export const screenUiStateV2Schema = screenUiStateSchema.extend({
    /** Reading: cancelling a running reading asks first. Absent: no confirmation variant exists. */
    reading: z
        .strictObject({ cancellation: z.literal(READING_CANCELLATION_V2) })
        .nullable()
        .optional(),
    /** Every kind but error/more/judge/compare: what the app is busy doing (null/absent: idle). */
    busy: z
        .strictObject({ activity: z.enum(BUSY_ACTIVITIES_V2) })
        .nullable()
        .optional(),
    /** More: the reading languages the Choice offers (codes the reader already accepts). */
    language: z
        .strictObject({ options: z.array(z.string().trim().min(1).max(16)).min(1).max(40) })
        .nullable()
        .optional(),
    /** More: the app can state what it stores here (the live count is bound text and never part of the key). */
    settings: z
        .strictObject({ storage: z.literal(true) })
        .nullable()
        .optional(),
    /**
     * Camera: the actual state of the device camera. `failed` (the camera could not start or stopped) and `canAskAgain`
     * (the system will still show its permission prompt; `false`: only the device settings can grant it) are optional and
     * default to `false`/`null`. Absent state is never read as granted.
     */
    camera: z
        .strictObject({
            mode: z.enum(['build-photo', 'manual-page']),
            permission: z.enum(['granted', 'undetermined', 'denied']),
            failed: z.boolean().optional(),
            canAskAgain: z.boolean().nullable().optional(),
        })
        .nullable()
        .optional(),
    judge: z.strictObject({ builtView: z.boolean() }).nullable().optional(),
    /**
     * Error, recovery and reading: the app holds a problem notice (`operation-notice` binds its plain words). Presence
     * only: the notice text, the manual and the cause never reach the model or the builder.
     */
    failure: z
        .strictObject({ notice: z.literal(true) })
        .nullable()
        .optional(),
    /**
     * Pages: a reading was just cancelled and the app holds the cancellation notice (`operation-notice` binds its plain
     * words). Presence only. This is the only way a screen other than error/recovery/reading states the notice: it is
     * the actual cancellation, not a problem (`failure` stays exact to its three kinds).
     */
    cancelled: z
        .strictObject({ reading: z.literal(true) })
        .nullable()
        .optional(),
})
export type ScreenUiStateV2 = z.infer<typeof screenUiStateV2Schema>

// ---------------------------------------------------------------------------------------------------------------------
// Tokens and bindings. Closed enums only: no style value, URL, code or markup can be expressed.
// ---------------------------------------------------------------------------------------------------------------------

export const TONES = ['neutral', 'info', 'success', 'caution', 'critical'] as const
export const SPACES = ['none', 'xs', 'sm', 'md', 'lg', 'xl'] as const
export const toneSchema = z.enum(TONES)
export const spaceSchema = z.enum(SPACES)
const align = z.enum(['start', 'center', 'end', 'stretch'])
const justify = z.enum(['start', 'center', 'end', 'between'])
const emphasis = z.enum(['quiet', 'normal', 'strong'])
const iconSchema = z.enum(ICON_NAMES)
const fit = z.enum(['cover', 'contain'])

/** Live text the app resolves from its own state (never written by the model). Allowed wherever a TextRef is. */
export const CORE_BOUND_TEXT_KEYS = [
    'manual-title',
    'step-title',
    'step-position',
    'pages-summary',
    'steps-summary',
    'completion-summary',
    'review-reason',
    'review-position',
] as const
/**
 * App-owned wording the native binder resolves (privacy-copy.ts, what is stored, how it works): whole sentences, so
 * they are body text only (`Text.content`). Keeping them out of the other fifteen text positions keeps the provider's
 * finite schema under its enum budget.
 */
export const APP_TEXT_KEYS = [
    'privacy-stay',
    'privacy-read',
    'privacy-check',
    'privacy-ask',
    'privacy-camera',
    'privacy-library',
    'privacy-once',
    'storage-summary',
    'storage-note',
    'help-scan',
    'help-look',
    'help-next',
    'help-ask',
    'operation-notice',
    'held-question',
] as const
/** The app-owned key that states the current problem notice (see `ScreenUiStateV2.failure`). */
export const OPERATION_NOTICE_KEY_V2 = 'operation-notice' as const
/**
 * The app-owned key that quotes the question the held answer was given for. The native binder resolves it from the
 * question of the PUBLISHED inputs the document was composed for, never from a mutable draft. It is the person's own
 * words, not a manual fact, and exists only on a More that holds an answer.
 */
export const HELD_QUESTION_KEY_V2 = 'held-question' as const
export const BOUND_TEXT_KEYS = [...CORE_BOUND_TEXT_KEYS, ...APP_TEXT_KEYS] as const
export const PROGRESS_BINDINGS = ['step', 'build', 'reading', 'pages', 'review'] as const
export const METER_BINDINGS = ['build', 'pages-read', 'steps-confirmed'] as const
/** Only the judge's built-view flag is a device-persistent toggle; tips have no preference, only a replay action. */
export const TOGGLE_BINDINGS = ['built-view'] as const
export const CHOICE_BINDINGS = ['language', 'part-target'] as const
export const STEPPER_BINDINGS = ['steps', 'pages'] as const
/** The fact editor owns every draft of the quick check; a bare text field binds only the question. */
export const TEXT_FIELD_BINDINGS = ['question'] as const

const id = z.string().trim().min(1).max(128)
const factId = z.string().trim().min(1).max(160)

function plain(max: number): z.ZodString {
    return z.string().trim().min(1).max(max).refine(isPlainScreenText, { message: 'Plain text required' })
}

/** Where a node's words come from: interface wording, a server-held witnessed fact, or live app state. */
export const textRefSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('literal'), text: plain(120) }),
    z.strictObject({ kind: z.literal('fact'), factId }),
    z.strictObject({ kind: z.literal('bound'), key: z.enum(CORE_BOUND_TEXT_KEYS) }),
])
/** The words of a `Text` node: any TextRef, plus the app-owned sentences (`APP_TEXT_KEYS`). */
export const bodyTextRefSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('literal'), text: plain(120) }),
    z.strictObject({ kind: z.literal('fact'), factId }),
    z.strictObject({ kind: z.literal('bound'), key: z.enum(BOUND_TEXT_KEYS) }),
])
/** Any TextRef a node can carry (the superset: `Text.content` may also bind the app-owned sentences). */
export type TextRefV2 = z.infer<typeof bodyTextRefSchema>
/** A TextRef of every position but `Text.content` (headers, titles, labels, prompts, captions). */
export type LabelTextRefV2 = z.infer<typeof textRefSchema>

const sourceIndexes = z
    .array(
        z
            .number()
            .int()
            .min(0)
            .max(DOCUMENT_V2_LIMITS.sources - 1),
    )
    .min(1)
    .max(DOCUMENT_V2_LIMITS.citationIndexes)

/** Existing source assets only: a cited manual source, a session page, the held capture or a known part. */
export const imageSourceSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('source'),
        index: z
            .number()
            .int()
            .min(0)
            .max(DOCUMENT_V2_LIMITS.sources - 1),
    }),
    z.strictObject({ kind: z.literal('page'), pageId: id }),
    z.strictObject({ kind: z.literal('capture') }),
    z.strictObject({ kind: z.literal('part'), partId: id }),
])

const actionFields = { label: plain(32), icon: iconSchema.nullable(), intent: appIntentSchema }

// ---------------------------------------------------------------------------------------------------------------------
// Catalog. Leaves first; the layout containers are recursive (any family may nest in any container up to the depth).
// ---------------------------------------------------------------------------------------------------------------------

function leaf<T extends string, S extends z.ZodRawShape>(
    type: T,
    shape: S,
): z.ZodObject<{ type: z.ZodLiteral<T> } & S, z.core.$strict> {
    return z.strictObject({ type: z.literal(type), ...shape })
}

// Content
const textNode = leaf('Text', {
    content: bodyTextRefSchema,
    role: z.enum(['display', 'title', 'heading', 'body', 'label', 'caption']),
    emphasis,
    tone: toneSchema,
    align: z.enum(['start', 'center', 'end']),
})
const iconNode = leaf('Icon', { name: iconSchema, tone: toneSchema, size: z.enum(['sm', 'md', 'lg']) })
const imageNode = leaf('Image', {
    source: imageSourceSchema,
    fit,
    ratio: z.enum(['hero', 'wide', 'square', 'tall']),
    caption: textRefSchema.nullable(),
})
const badgeNode = leaf('Badge', { label: textRefSchema, tone: toneSchema })
const citationNode = leaf('Citation', {
    sources: sourceIndexes,
    label: textRefSchema.nullable(),
    display: z.enum(['chip', 'thumbnail']),
})
const checklistNode = leaf('Checklist', {
    items: z
        .array(z.strictObject({ label: textRefSchema, state: z.enum(['todo', 'done', 'note']) }))
        .min(1)
        .max(24),
})
const progressNode = leaf('Progress', { binding: z.enum(PROGRESS_BINDINGS), label: textRefSchema.nullable() })
const meterNode = leaf('Meter', {
    binding: z.enum(METER_BINDINGS),
    label: textRefSchema.nullable(),
    tone: toneSchema,
})

// Controls
export const primaryActionNodeSchema = leaf('PrimaryAction', actionFields)
export const secondaryActionNodeSchema = leaf('SecondaryAction', actionFields)
const toggleNode = leaf('Toggle', { binding: z.enum(TOGGLE_BINDINGS), label: textRefSchema })
const choiceNode = leaf('Choice', {
    prompt: textRefSchema.nullable(),
    options: z.discriminatedUnion('mode', [
        z.strictObject({
            mode: z.literal('intents'),
            items: z
                .array(z.strictObject({ label: plain(32), intent: appIntentSchema }))
                .min(2)
                .max(6),
        }),
        z.strictObject({ mode: z.literal('bound'), binding: z.enum(CHOICE_BINDINGS) }),
    ]),
})
const stepperNode = leaf('Stepper', { binding: z.enum(STEPPER_BINDINGS), label: textRefSchema.nullable() })

// Native capabilities (the native implementation stays controller-owned; the document configures and places it)
const cameraViewNode = leaf('CameraView', {
    mode: z.enum(['build-photo', 'manual-page']),
    cue: plain(40),
    pill: plain(24).nullable(),
    tipTarget: z.enum(TIP_TARGETS).nullable(),
})
const manualPageNode = leaf('ManualPage', {
    sources: sourceIndexes,
    fit,
    label: textRefSchema.nullable(),
    initiallyOpen: z.boolean(),
})
const pieceTileNode = leaf('PieceTile', {
    partId: id,
    showQuantity: z.boolean(),
    size: z.enum(['sm', 'md', 'lg']),
})
const verdictCardNode = leaf('VerdictCard', {
    result: z.enum(['check', 'question']),
    variant: z.enum(['banner', 'card']),
    showReason: z.boolean(),
    showRegions: z.boolean(),
})
const judgePanelNode = leaf('JudgePanel', { panel: z.enum(['about-check', 'built-view', 'stages']) })
const compareColumnsNode = leaf('CompareColumns', { subject: z.literal('manuals') })
const coachMarkNode = leaf('CoachMark', {
    targetId: z.enum(TIP_TARGETS),
    heading: plain(40),
    body: plain(120),
    placement: z.enum(['above', 'below', 'auto']),
})
// Bounded native input and bound-collection controls
const manualListNode = leaf('ManualList', {
    entries: z.union([
        z.literal('recent'),
        z.strictObject({ manualIds: z.array(id).min(1).max(DOCUMENT_V2_LIMITS.manualLibrary) }),
    ]),
    layout: z.enum(['cards', 'rows']),
    showProgress: z.boolean(),
})
const pageListNode = leaf('PageList', { layout: z.enum(['list', 'grid']), showNumbers: z.boolean() })
const textFieldNode = leaf('TextField', {
    binding: z.enum(TEXT_FIELD_BINDINGS),
    label: textRefSchema,
    placeholder: plain(48).nullable(),
})
const factEditorNode = leaf('FactEditor', {
    kind: z.enum(['orientation', 'checks']),
    label: plain(48),
    saveLabel: plain(32),
    cancelLabel: plain(32),
})

// Layout leaves (no children)
const dividerNode = leaf('Divider', { inset: z.boolean() })
const spacerNode = leaf('Spacer', { size: spaceSchema })

/** The childless catalog nodes. The provider wire format reuses these exactly (plus an id). */
export const LEAF_SCHEMAS_V2 = [
    textNode,
    iconNode,
    imageNode,
    badgeNode,
    citationNode,
    checklistNode,
    progressNode,
    meterNode,
    primaryActionNodeSchema,
    secondaryActionNodeSchema,
    toggleNode,
    choiceNode,
    stepperNode,
    cameraViewNode,
    manualPageNode,
    pieceTileNode,
    verdictCardNode,
    judgePanelNode,
    compareColumnsNode,
    coachMarkNode,
    manualListNode,
    pageListNode,
    textFieldNode,
    factEditorNode,
    dividerNode,
    spacerNode,
] as const

type LeafNodeV2 = z.infer<(typeof LEAF_SCHEMAS_V2)[number]>
type Gap = z.infer<typeof spaceSchema>
type Align = z.infer<typeof align>

export interface StackNodeV2 {
    type: 'Stack'
    gap: Gap
    align: Align
    children: ScreenNodeV2[]
}
export interface RowNodeV2 {
    type: 'Row'
    gap: Gap
    align: Align
    justify: z.infer<typeof justify>
    wrap: boolean
    children: ScreenNodeV2[]
}
export interface GridNodeV2 {
    type: 'Grid'
    columns: 1 | 2 | 3 | 4
    gap: Gap
    children: ScreenNodeV2[]
}
export interface CardNodeV2 {
    type: 'Card'
    surface: 'plain' | 'raised' | 'tinted'
    tone: z.infer<typeof toneSchema>
    padding: Gap
    children: ScreenNodeV2[]
}
export interface SectionNodeV2 {
    type: 'Section'
    title: TextRefV2 | null
    collapsible: boolean
    initiallyOpen: boolean
    children: ScreenNodeV2[]
}
export interface ScrollNodeV2 {
    type: 'Scroll'
    axis: 'vertical' | 'horizontal'
    children: ScreenNodeV2[]
}
export type ContainerNodeV2 = StackNodeV2 | RowNodeV2 | GridNodeV2 | CardNodeV2 | SectionNodeV2 | ScrollNodeV2
export type ScreenNodeV2 = LeafNodeV2 | ContainerNodeV2
export type ScreenNodeTypeV2 = ScreenNodeV2['type']
export type PrimaryActionNodeV2 = z.infer<typeof primaryActionNodeSchema>
export type SecondaryActionNodeV2 = z.infer<typeof secondaryActionNodeSchema>

export const LAYOUT_NODE_TYPES = ['Stack', 'Row', 'Grid', 'Card', 'Section', 'Divider', 'Spacer', 'Scroll'] as const
export const CONTENT_NODE_TYPES = [
    'Text',
    'Icon',
    'Image',
    'Badge',
    'Citation',
    'Checklist',
    'Progress',
    'Meter',
] as const
export const CONTROL_NODE_TYPES = ['PrimaryAction', 'SecondaryAction', 'Toggle', 'Choice', 'Stepper'] as const
export const NATIVE_NODE_TYPES = [
    'CameraView',
    'ManualPage',
    'PieceTile',
    'VerdictCard',
    'JudgePanel',
    'CompareColumns',
    'CoachMark',
    'ManualList',
    'PageList',
    'TextField',
    'FactEditor',
] as const
export const NODE_TYPES_V2 = [
    ...LAYOUT_NODE_TYPES,
    ...CONTENT_NODE_TYPES,
    ...CONTROL_NODE_TYPES,
    ...NATIVE_NODE_TYPES,
] as const

const children = (node: z.ZodType<ScreenNodeV2>): z.ZodArray<z.ZodType<ScreenNodeV2>> =>
    z.array(node).max(DOCUMENT_V2_LIMITS.children)

/** Properties of each container besides its children: the single definition the tree and the wire format share. */
export const CONTAINER_SHAPES_V2 = {
    Stack: { gap: spaceSchema, align },
    Row: { gap: spaceSchema, align, justify, wrap: z.boolean() },
    Grid: { columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), gap: spaceSchema },
    Card: { surface: z.enum(['plain', 'raised', 'tinted']), tone: toneSchema, padding: spaceSchema },
    Section: { title: textRefSchema.nullable(), collapsible: z.boolean(), initiallyOpen: z.boolean() },
    Scroll: { axis: z.enum(['vertical', 'horizontal']) },
} as const
export const CONTAINER_TYPES_V2 = Object.keys(CONTAINER_SHAPES_V2) as (keyof typeof CONTAINER_SHAPES_V2)[]

/** One catalog node. Recursive: containers hold any node, bounded by `validateStructureV2` (depth, count). */
export const screenNodeV2Schema: z.ZodType<ScreenNodeV2> = z.lazy(() =>
    z.discriminatedUnion('type', [
        ...LEAF_SCHEMAS_V2,
        ...CONTAINER_TYPES_V2.map((type) =>
            leaf(type, { ...CONTAINER_SHAPES_V2[type], children: children(screenNodeV2Schema) }),
        ),
    ] as unknown as [(typeof LEAF_SCHEMAS_V2)[number], ...(typeof LEAF_SCHEMAS_V2)[number][]]),
)

// ---------------------------------------------------------------------------------------------------------------------
// Variants: header, body, fixed action bar and overlays, for the ready state and for each state variant.
// ---------------------------------------------------------------------------------------------------------------------

export const headerActionV2Schema = z.strictObject({ label: plain(32), icon: iconSchema, intent: appIntentSchema })
export type HeaderActionV2 = z.infer<typeof headerActionV2Schema>
export const headerV2Schema = z.strictObject({
    title: textRefSchema,
    subtitle: textRefSchema.nullable(),
    /** Typed back affordance (a closed navigate intent). Null: this variant has no back. */
    back: headerActionV2Schema.nullable(),
    actions: z.array(headerActionV2Schema).max(DOCUMENT_V2_LIMITS.headerActions),
})
export type HeaderV2 = z.infer<typeof headerV2Schema>

/** Exactly one primary action; the secondary is optional. Neither is ever supplied by the native app. */
export const barV2Schema = z.strictObject({
    primary: primaryActionNodeSchema,
    secondary: secondaryActionNodeSchema.nullable(),
})
export type BarV2 = z.infer<typeof barV2Schema>

/**
 * A tooltip: one coach mark anchored to its own existing coach target. Nothing else is published as an overlay: a
 * generic sheet has no open/close trigger in the catalog, so More, the judge view and the question sheet stay separately
 * composed documents. The anchor must equal the mark's target (see `validateStructureV2`).
 */
export const overlayV2Schema = z.strictObject({
    kind: z.literal('tooltip'),
    anchor: z.enum(TIP_TARGETS),
    content: coachMarkNode,
})
export type OverlayV2 = z.infer<typeof overlayV2Schema>

export const screenVariantV2Schema = z.strictObject({
    header: headerV2Schema,
    body: screenNodeV2Schema,
    bar: barV2Schema,
    overlays: z.array(overlayV2Schema).max(DOCUMENT_V2_LIMITS.overlays),
})
export type ScreenVariantV2 = z.infer<typeof screenVariantV2Schema>

const statesShape = Object.fromEntries(VARIANT_STATES.map((state) => [state, screenVariantV2Schema.nullable()])) as {
    [S in VariantState]: z.ZodNullable<typeof screenVariantV2Schema>
}
export const screenStatesV2Schema = z.strictObject(statesShape)
export type ScreenStatesV2 = z.infer<typeof screenStatesV2Schema>

/** What the model returns: its ready variant plus its state variants. No identity, provenance, timing or text tables. */
export const screenProposalV2Schema = z.strictObject({
    ...screenVariantV2Schema.shape,
    states: screenStatesV2Schema,
})
export type ScreenProposalV2 = z.infer<typeof screenProposalV2Schema>

// ---------------------------------------------------------------------------------------------------------------------
// Walking a document: node paths, children and the facts, sources and intents a node mentions.
// ---------------------------------------------------------------------------------------------------------------------

export function nodeChildrenV2(node: ScreenNodeV2): readonly ScreenNodeV2[] {
    return 'children' in node ? node.children : []
}

/** A path names one component of a document: `header`, `body.0.2`, `bar.primary`, `states.busy.overlays.0`, ... */
export const COMPONENT_PATH_V2 =
    /^(?:states\.(?:busy|pending|empty|error|recovery|confirming)\.)?(?:header(?:\.back|\.actions\.[0-2])?|bar\.(?:primary|secondary)|(?:body|overlays\.[0-3])(?:\.\d{1,2})*)$/u

export type VariantRef = { name: 'ready' | VariantState; prefix: string; variant: ScreenVariantV2 }

export function variantsOfV2(document: {
    header: HeaderV2
    body: ScreenNodeV2
    bar: BarV2
    overlays: readonly OverlayV2[]
    states: ScreenStatesV2
}): VariantRef[] {
    const out: VariantRef[] = [
        {
            name: 'ready',
            prefix: '',
            variant: {
                header: document.header,
                body: document.body,
                bar: document.bar,
                overlays: [...document.overlays],
            },
        },
    ]
    for (const state of VARIANT_STATES) {
        const variant = document.states[state]
        if (variant) out.push({ name: state, prefix: `states.${state}.`, variant })
    }
    return out
}

export interface VisitedNode {
    node: ScreenNodeV2
    path: string
    depth: number
    /**
     * True when the node is not visible until the person opens it: under a collapsed Section, or anywhere in an overlay
     * (a tooltip appears only on demand and a sheet only when opened). A hidden node discharges no visible requirement.
     */
    hidden: boolean
}

/** Every node of one variant with its canonical path, in document order (header actions are not nodes). */
export function visitVariantNodesV2(
    variant: ScreenVariantV2,
    prefix: string,
    visit: (entry: VisitedNode) => void,
): void {
    const walk = (node: ScreenNodeV2, path: string, depth: number, hidden: boolean): void => {
        visit({ node, path, depth, hidden })
        const collapsed = hidden || (node.type === 'Section' && node.collapsible && !node.initiallyOpen)
        nodeChildrenV2(node).forEach((child, index) => walk(child, `${path}.${index}`, depth + 1, collapsed))
    }
    walk(variant.body, `${prefix}body`, 1, false)
    walk(variant.bar.primary, `${prefix}bar.primary`, 1, false)
    if (variant.bar.secondary) walk(variant.bar.secondary, `${prefix}bar.secondary`, 1, false)
    variant.overlays.forEach((overlay, index) => walk(overlay.content, `${prefix}overlays.${index}`, 1, true))
}

/** Paths of every component of each variant that carries an origin: header, back, actions, and every node. */
export function variantComponentPathsV2(
    document: Parameters<typeof variantsOfV2>[0],
): { name: 'ready' | VariantState; prefix: string; paths: string[] }[] {
    return variantsOfV2(document).map(({ name, prefix, variant }) => {
        const paths = [`${prefix}header`]
        if (variant.header.back) paths.push(`${prefix}header.back`)
        variant.header.actions.forEach((_action, index) => paths.push(`${prefix}header.actions.${index}`))
        visitVariantNodesV2(variant, prefix, (entry) => paths.push(entry.path))
        return { name, prefix, paths }
    })
}

/** Paths of every component of a document that carries an origin: header, back, actions, and every node. */
export function componentPathsV2(document: Parameters<typeof variantsOfV2>[0]): string[] {
    return variantComponentPathsV2(document).flatMap((variant) => variant.paths)
}

/**
 * The origin every component of one variant carries. A variant is attributed as a whole: the document's `source`,
 * except a state variant that `metadata.carried` names, which keeps the `generated` origin of the document that really
 * authored it. Nothing else can make a component `generated`.
 */
export function variantOriginV2(
    metadata: { source: 'generated' | 'fallback'; carried?: CarriedStatesV2 | undefined },
    name: 'ready' | VariantState,
): 'generated' | 'fallback' {
    return name !== 'ready' && metadata.carried?.[name] !== undefined ? 'generated' : metadata.source
}

/** Every TextRef a node carries (its words), in document order. */
export function nodeTextRefsV2(node: ScreenNodeV2): TextRefV2[] {
    switch (node.type) {
        case 'Text':
            return [node.content]
        case 'Image':
            return node.caption ? [node.caption] : []
        case 'Badge':
            return [node.label]
        case 'Citation':
        case 'Progress':
        case 'Meter':
        case 'Stepper':
        case 'ManualPage':
            return node.label ? [node.label] : []
        case 'Checklist':
            return node.items.map((entry) => entry.label)
        case 'Toggle':
            return [node.label]
        case 'Choice':
            return node.prompt ? [node.prompt] : []
        case 'TextField':
            return [node.label]
        case 'Section':
            return node.title ? [node.title] : []
        default:
            return []
    }
}

/** Fact ids a node states (a VerdictCard states the verdict, answer and missing-evidence facts of the held result). */
export function nodeFactIdsV2(node: ScreenNodeV2): string[] {
    return nodeTextRefsV2(node).flatMap((ref) => (ref.kind === 'fact' ? [ref.factId] : []))
}

/** Indexes of the document `sources` a node cites directly. */
export function nodeSourceIndexesV2(node: ScreenNodeV2): number[] {
    if (node.type === 'Citation' || node.type === 'ManualPage') return [...node.sources]
    if (node.type === 'Image' && node.source.kind === 'source') return [node.source.index]
    return []
}

/** Closed intents a node offers. */
export function nodeIntentsV2(node: ScreenNodeV2): AppIntent[] {
    if (node.type === 'PrimaryAction' || node.type === 'SecondaryAction') return [node.intent]
    if (node.type === 'Choice' && node.options.mode === 'intents') return node.options.items.map((item) => item.intent)
    return []
}

// ---------------------------------------------------------------------------------------------------------------------
// Published document.
// ---------------------------------------------------------------------------------------------------------------------

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const regionBox = z
    .strictObject({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().gt(0).max(1),
        height: z.number().gt(0).max(1),
    })
    .refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1, { message: 'Region must lie in the image' })
export const documentSourceV2Schema = z.strictObject({ pageId: id, region: regionBox.nullable() })
export type DocumentSourceV2 = z.infer<typeof documentSourceV2Schema>

export const FACT_KINDS_V2 = [...MANUAL_FACT_KINDS, 'verdict', 'answer', 'missing'] as const
/**
 * `unresolved-safety`: a statement about the EXTRACTION, never manual text. The reading of a step could not make out a
 * printed safety note (`state: 'unknown'`), and an unreadable note is not a known manual fact, so this one fixed fact
 * (see `UNRESOLVED_SAFETY_FACT_ID_V2`) is how the document still says so. It cites no source (the manual says nothing
 * to cite), repeats none of the extraction's own reasons and is required, like a known safety note, in every variant.
 *
 * `overview`: the title of a step the quick check of a fully known manual states so the person has something to confirm
 * (see `OVERVIEW_FACT_PREFIX_V2`). Not a direction and not a safety fact: it is required only in that ready screen.
 */
export const FACT_BASES_V2 = [...MANUAL_FACT_BASES, 'unresolved-safety', 'result', 'overview'] as const
/**
 * A complete, source-witnessed statement the document may show by reference: the manual's own words (never clipped,
 * not subject to the model-text plain rule), the actual validated result, or the fixed unresolved-safety explanation
 * of a witnessed extraction state (which has no manual text or source to cite). Server-owned; the model only places it.
 */
export const factV2Schema = z.strictObject({
    factId,
    kind: z.enum(FACT_KINDS_V2),
    basis: z.enum(FACT_BASES_V2),
    text: z.string().min(1).max(2_100),
    sourceRefs: z.array(documentSourceV2Schema).max(100),
})
export type FactV2 = z.infer<typeof factV2Schema>
/** Facts of these bases must be shown in every variant that carries them (see `requirements`). */
export const isRequiredFactV2 = (fact: Pick<FactV2, 'basis'>): boolean =>
    fact.basis !== 'direction' && fact.basis !== 'overview'

/**
 * Identity and words of the one fact of basis `unresolved-safety`: a step whose extraction left a safety note unreadable
 * states it once, however many notes were unreadable. The words are fixed. They say nothing the manual says and nothing
 * about which note, so a document can neither soften nor invent the missing warning. Only the shared material derives
 * it (see `documentMaterialV2`); the model never writes it.
 */
export const UNRESOLVED_SAFETY_FACT_ID_V2 = 'state:safety-unreadable' as const
export const UNRESOLVED_SAFETY_TEXT_V2 = 'A safety note could not be read. Add a clearer page before building.' as const

/** Identity prefix of the step-title facts of a quick check's overview (`overview:step:<stepId>`). */
export const OVERVIEW_FACT_PREFIX_V2 = 'overview:step:' as const
/** An overview fact: required, visibly, in the ready variant of the quick check that published it, and nowhere else. */
export const isOverviewFactV2 = (fact: Pick<FactV2, 'basis'>): boolean => fact.basis === 'overview'
/**
 * Parts of the overview that must be visible without opening anything; the rest of the known parts are still owed in
 * the ready variant, but may sit behind a disclosure. (A manual has at most 256 parts: all are listed, none is dropped.)
 */
export const OVERVIEW_PARTS_VISIBLE_V2 = 6 as const
/** The bound text that names the manual: the overview of a quick check owes it, visibly, in its ready variant. */
export const OVERVIEW_TITLE_KEY_V2 = 'manual-title' as const

/**
 * The result type a `result:*` fact belongs to: the verdict and its missing evidence belong to the held check; the answer
 * and its missing evidence to the held answer. A document can hold both (a retained check and the answer given about its
 * photo), so each `VerdictCard` states only the facts of its own `result` type.
 */
export function resultFactCardV2(factId: string): 'check' | 'question' | null {
    if (factId === 'result:verdict' || factId.startsWith('result:missing:')) return 'check'
    if (factId === 'result:answer' || factId.startsWith('result:answer-missing:')) return 'question'
    return null
}

/** The fact ids a `VerdictCard` of this result type states when it shows its reason. */
export const verdictCardFactIdsV2 = (card: 'check' | 'question', facts: readonly Pick<FactV2, 'factId'>[]): string[] =>
    facts.filter((fact) => resultFactCardV2(fact.factId) === card).map((fact) => fact.factId)

/**
 * Mandatory witnesses, computed by the server from the validated context and published so anyone can check them:
 * a document is invalid unless its ready variant shows every one, and its facts appear in every variant that is present.
 */
export const requirementsV2Schema = z.strictObject({
    /**
     * Facts to state (safety notes, the unreadable-safety statement, unclassified-step directions, the verdict, answer and
     * missing evidence).
     */
    facts: z.array(factId).max(DOCUMENT_V2_LIMITS.facts),
    /** Indexes of `sources` that must be cited visibly (sources of the required facts and of the result). */
    sources: z
        .array(
            z
                .number()
                .int()
                .min(0)
                .max(DOCUMENT_V2_LIMITS.sources - 1),
        )
        .max(DOCUMENT_V2_LIMITS.sources),
    /** Intents the ready variant must offer. */
    actions: z.array(appIntentSchema).max(8),
    /** Native node types the ready variant must contain (camera, verdict, judge or comparison view). */
    nodes: z.array(z.enum(NODE_TYPES_V2)).max(4),
    /** Intents the `confirming` variant must offer, and nothing else (the reading cancellation witness); else empty. */
    confirm: z.array(appIntentSchema).max(2),
    /**
     * A held result with its capture: the ready, busy and pending variants all show that photo (an `Image` of source
     * capture), and busy/pending never state the verdict.
     */
    capture: z.boolean(),
    /**
     * Quick check: the index into `sources` of the question step's own picture, which the ready variant shows as an
     * `Image` of that source (null: the step has no usable source, nothing is shown and nothing is invented).
     */
    figure: z
        .number()
        .int()
        .min(0)
        .max(DOCUMENT_V2_LIMITS.sources - 1)
        .nullable(),
    /**
     * The app holds a problem notice (`uiState.failure`): the variants that show a failure state it exactly once as the
     * bound `operation-notice` text (see `noticeShownInV2`), and no other variant does.
     */
    notice: z.boolean(),
    /**
     * Quick check of a fully known manual: every known part of the manual (a `PieceTile` of each, the first
     * `OVERVIEW_PARTS_VISIBLE_V2` visible, the rest possibly behind a disclosure) the ready variant must offer; else empty.
     * A document without the field (written before it existed) owes none.
     */
    parts: z.array(id).max(256).default([]),
})
export type RequirementsV2 = z.infer<typeof requirementsV2Schema>

export const FALLBACK_REASONS_V2 = [
    'disabled',
    'fixture',
    'unconfigured',
    'timeout',
    'provider_error',
    'invalid_output',
    'repair_failed',
    'missing_requirement',
    'unsupported_content',
    'stale',
    'busy',
] as const
export type FallbackReasonV2 = (typeof FALLBACK_REASONS_V2)[number]
const nullableMs = z.number().min(0).nullable()
const nullableCount = z.number().int().min(0).nullable()

/**
 * Where a published document's content came from. `live`: the live API runtime (a fallback after a real failure is still
 * `live`). `synthetic-fixture`: a fixture/test runtime, no model claimed. `recorded-generation`: a model response that was
 * really recorded once (by the run named in `model`, `effort`, `generatedAt` and `fixtureId`) and bound to its context
 * later, so it was observed at record time and nothing about its timing or usage is known now. `local-deterministic`:
 * built on the device without a server (generation off).
 */
export const DOCUMENT_EVIDENCE_V2 = ['live', 'synthetic-fixture', 'recorded-generation', 'local-deterministic'] as const
export type DocumentEvidenceV2 = (typeof DOCUMENT_EVIDENCE_V2)[number]
/** Identity of one recording: lowercase words, digits, dots, dashes and underscores (`recorded-home-first-launch-v1`). */
export const fixtureIdV2Schema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/u)

/** Test fixture identity; separate from a Meta inference response and its effort/usage. */
export const syntheticAuthorV2Schema = z.strictObject({
    model: z.literal('Test fixture'),
    effort: z.literal('ultra'),
    recordedAt: z.iso.datetime(),
    fixtureId: fixtureIdV2Schema,
})
export type SyntheticAuthorV2 = z.infer<typeof syntheticAuthorV2Schema>

/**
 * Who really authored a state variant that sits on a document built for another context (see
 * `rebindGeneratedStatesV2`): the generated or recorded document it was taken from, with that document's own model,
 * effort, date and recording identity. Never the time it was carried, never a claim about a deterministic template.
 */
export const carriedStateV2Schema = z.strictObject({
    /** `screenId` of the generated document that authored the variant. */
    fromScreenId: sha256,
    evidence: z.enum(['live', 'synthetic-fixture', 'recorded-generation']),
    model: z.enum(['muse-spark-1.3', 'muse-wonder-1.0']).nullable(),
    effort: aiEffortSchema.nullable(),
    generatedAt: z.iso.datetime(),
    promptVersion: z.number().int().min(0),
    fixtureId: fixtureIdV2Schema.nullable(),
    authoring: syntheticAuthorV2Schema.optional(),
})
export type CarriedStateV2 = z.infer<typeof carriedStateV2Schema>
/** Closed by construction: a state of the catalog, never `ready` (the ready screen states this context's facts). */
export const carriedStatesV2Schema = z.strictObject(
    Object.fromEntries(VARIANT_STATES.map((state) => [state, carriedStateV2Schema.optional()])) as {
        [S in VariantState]: z.ZodOptional<typeof carriedStateV2Schema>
    },
)
export type CarriedStatesV2 = z.infer<typeof carriedStatesV2Schema>

export const documentMetadataV2Schema = z.strictObject({
    /** `generated`: the model's document, accepted unchanged. `fallback`: the complete deterministic document. */
    source: screenSourceSchema.exclude(['shell']),
    /** Server-owned origin of each component path (see `componentPathsV2`). Uniform with `source`. */
    origins: z.record(z.string().regex(COMPONENT_PATH_V2), screenSourceSchema.exclude(['shell'])),
    /** Indexes of `sources` each node cites or states (via facts), keyed by path. Server-computed. */
    sourceMap: z.record(
        z.string().regex(COMPONENT_PATH_V2),
        z
            .array(
                z
                    .number()
                    .int()
                    .min(0)
                    .max(DOCUMENT_V2_LIMITS.sources - 1),
            )
            .max(DOCUMENT_V2_LIMITS.sources),
    ),
    /**
     * `live`: served by the live API runtime, including its unconfigured or failed-provider fallback. It proves no
     * provider call by itself: a fallback's unobserved model, effort, timing and usage remain null.
     * `synthetic-fixture`: a fixture/test runtime (a `generated` document with it claims no model, effort, timing or
     * usage). `recorded-generation`: a recorded model response (names its model, effort, date and `fixtureId`; claims no
     * timing or usage). `local-deterministic`: built on the device without a server (generation off).
     */
    evidence: z.enum(DOCUMENT_EVIDENCE_V2),
    /** Identity of the recording; present exactly when `evidence` is `recorded-generation`. */
    fixtureId: fixtureIdV2Schema.nullable().optional(),
    /**
     * State variants taken from generated documents of other contexts, keyed by state, each with the provenance of the
     * document that authored it. Only a `fallback` document carries any; its other variants stay `fallback`.
     */
    carried: carriedStatesV2Schema.optional(),
    authoring: syntheticAuthorV2Schema.optional(),
    stage: z.enum(['screen', 'step-page']),
    model: z.enum(['muse-spark-1.3', 'muse-wonder-1.0']).nullable(),
    effort: aiEffortSchema.nullable(),
    fallbackReason: z.enum(FALLBACK_REASONS_V2).nullable(),
    repaired: z.boolean(),
    /** Machine issue count of a rejected first attempt, when one occurred (never the rejected content). */
    rejectedIssues: z.number().int().min(0).nullable(),
    cacheHit: z.boolean(),
    catalogVersion: z.literal(SCREEN_CATALOG_V2_VERSION),
    promptVersion: z.number().int().min(0),
    generatedAt: z.iso.datetime(),
    timing: z.strictObject({
        timeToProviderMs: nullableMs,
        providerMs: nullableMs,
        parseValidateMs: nullableMs,
        totalMs: nullableMs,
        paceWaitMs: nullableMs.optional(),
        networkMs: nullableMs.optional(),
        bodyMs: nullableMs.optional(),
    }),
    usage: z.strictObject({
        inputTokens: nullableCount,
        cachedTokens: nullableCount,
        outputTokens: nullableCount,
        reasoningTokens: nullableCount,
    }),
})
export type DocumentMetadataV2 = z.infer<typeof documentMetadataV2Schema>

/** Canonical identity of a source reference: the page and the exact figure region. */
export const sourceKeyV2 = (source: DocumentSourceV2): string => `${source.pageId}|${canonicalJson(source.region)}`

/**
 * Resolves manual references to indexes of a document `sources` table: the exact page-and-region entry, else the
 * page-level entry (`region: null`) of the same page, which is how a table that exceeded the exact-region cap stays
 * complete (see `sourcePrecision` in the material). A reference with neither is simply absent from the result, so a
 * missing entry can never be mistaken for a satisfied one. Sorted, unique.
 */
export function sourceResolverV2(
    sources: readonly DocumentSourceV2[],
): (refs: readonly DocumentSourceV2[]) => number[] {
    const exact = new Map<string, number>()
    const pages = new Map<string, number>()
    sources.forEach((source, index) => {
        exact.set(sourceKeyV2(source), index)
        if (source.region === null) pages.set(source.pageId, index)
    })
    return (refs) => {
        const found = new Set<number>()
        for (const ref of refs) {
            const index = exact.get(sourceKeyV2(ref)) ?? pages.get(ref.pageId)
            if (index !== undefined) found.add(index)
        }
        return [...found].sort((a, b) => a - b)
    }
}

export const sourceIndexesOfRefsV2 = (
    sources: readonly DocumentSourceV2[],
    refs: readonly DocumentSourceV2[],
): number[] => sourceResolverV2(sources)(refs)

/**
 * Per node path, the `sources` indexes the node cites directly or states through facts it references (a VerdictCard
 * states every result fact), and per header the sources of the facts its title or subtitle states. The published
 * document must carry exactly this map: it is recomputed, never trusted.
 */
export function sourceMapV2(
    document: Parameters<typeof variantsOfV2>[0] & {
        facts: readonly FactV2[]
        sources: readonly DocumentSourceV2[]
    },
): Record<string, number[]> {
    const resolve = sourceResolverV2(document.sources)
    const factIndexes = new Map(document.facts.map((fact) => [fact.factId, resolve(fact.sourceRefs)]))
    const result = { check: [] as number[], question: [] as number[] }
    for (const fact of document.facts) {
        const card = resultFactCardV2(fact.factId)
        if (card !== null) result[card].push(...(factIndexes.get(fact.factId) ?? []))
    }
    const map: Record<string, number[]> = {}
    for (const { prefix, variant } of variantsOfV2(document)) {
        const header = new Set<number>()
        for (const ref of [variant.header.title, variant.header.subtitle]) {
            if (ref?.kind === 'fact') for (const index of factIndexes.get(ref.factId) ?? []) header.add(index)
        }
        if (header.size > 0) map[`${prefix}header`] = [...header].sort((a, b) => a - b)
        visitVariantNodesV2(variant, prefix, (entry) => {
            const indexes = new Set<number>(nodeSourceIndexesV2(entry.node))
            for (const reference of nodeFactIdsV2(entry.node)) {
                for (const index of factIndexes.get(reference) ?? []) indexes.add(index)
            }
            if (entry.node.type === 'VerdictCard') for (const index of result[entry.node.result]) indexes.add(index)
            if (indexes.size > 0) map[entry.path] = [...indexes].sort((a, b) => a - b)
        })
    }
    return map
}

/**
 * What the document says about its nodes: the total, the deepest level, the widest container and the largest single
 * variant (the render bound applies to one variant, the payload budget to all of them).
 */
export function structureOfV2(document: Parameters<typeof variantsOfV2>[0]): {
    nodes: number
    depth: number
    widest: number
    variantNodes: number
} {
    let nodes = 0
    let depth = 0
    let widest = 0
    let variantNodes = 0
    for (const { prefix, variant } of variantsOfV2(document)) {
        let inVariant = 0
        visitVariantNodesV2(variant, prefix, (entry) => {
            inVariant += 1
            depth = Math.max(depth, entry.depth)
            widest = Math.max(widest, nodeChildrenV2(entry.node).length)
        })
        nodes += inVariant
        variantNodes = Math.max(variantNodes, inVariant)
    }
    return { nodes, depth, widest, variantNodes }
}

/**
 * What one selected variant must show, derived from the document `requirements` and the screen kind. The facts and the
 * sources of the facts are mandatory wherever the person can be: in every variant, except that a waiting variant
 * (`busy`/`pending`) of a held result never states the result (a calm screen shows the held photo until the verdict is
 * revealed). Actions and native nodes belong to the variant that can honestly offer them: `ready` offers the screen's
 * own actions and native views, `empty` the way to fill it, `error`/`recovery` a way out (a retry or a navigation) and
 * never a capability they cannot have (a camera view or a capture while the camera is unavailable); `busy`/`pending`
 * need none; `confirming` offers exactly the confirmation's two intents.
 */
export interface VariantPolicyV2 {
    facts: string[]
    sources: number[]
    actions: AppIntent[]
    /** At least one retry or navigation must be offered. */
    recover: boolean
    nodes: ScreenNodeTypeV2[]
    forbiddenNodes: ScreenNodeTypeV2[]
    /** Intents this variant cannot honestly offer. */
    forbiddenIntents: AppIntent['intent'][]
    /** Exact intents (name and target) this variant cannot offer. */
    forbiddenPairs: AppIntent[]
    /** Facts this variant must not state (the held result, while it is not yet revealed). */
    forbiddenFacts: string[]
    /** Overview step facts this variant must not state, visibly or not (only the ready screen of a quick check earns them). */
    forbiddenOverview: string[]
    /** The overview's picture, parts and manual title are not shown here either (a waiting or failing overview claims nothing). */
    withholdOverview: boolean
    /** The bound manual title must be visible (the overview's ready screen). */
    title: boolean
    /** Parts that must have a tile, visible or behind a disclosure. */
    parts: string[]
    /** How many of `parts` must be visible without opening anything. */
    partsVisible: number
    /** When set, the only intents this variant may offer. */
    only: AppIntent[] | null
    /** The held photo (an `Image` of source capture) must be visible. */
    capture: boolean
    /** An `Image` of this `sources` index (the question step's picture) must be visible. */
    figure: number | null
    /** The bound `operation-notice` is stated exactly once (true) or not at all (false). */
    notice: boolean
    /** The camera stays mounted: a `CameraView` at the same spine as the ready variant's. */
    camera: boolean
}

/** Variants that state the operation notice when the app holds one: the failure screens, never a working screen. */
export function noticeShownInV2(kind: ScreenKindV2, name: 'ready' | VariantState): boolean {
    // The pages a cancelled reading returns to state the cancellation notice once, in their ready screen only.
    if (kind === 'pages') return name === 'ready'
    if (kind === 'error' || kind === 'recovery') return name === 'ready' || name === 'error' || name === 'recovery'
    return kind === 'reading' && (name === 'error' || name === 'recovery')
}

/**
 * Where the camera sits in a variant's body: the ancestor node types and child indexes down to the first `CameraView`
 * (null: none). Two variants with the same spine reconcile to the same native view, so the camera is never unmounted
 * when the person's screen switches between them (a photo is being taken while the document changes).
 */
export function cameraSpineV2(variant: Pick<ScreenVariantV2, 'body'>): string | null {
    return spineV2(variant, (node) => node.type === 'CameraView')
}

/**
 * Where the held photo (the first `Image` of source capture) sits in a variant's body, as `cameraSpineV2` does for the
 * camera. A photo-first screen keeps it at the same spine in every variant, so the native Image is never remounted
 * (and never reloaded) when the screen goes from pending to ready or into a failure.
 */
export function photoSpineV2(variant: Pick<ScreenVariantV2, 'body'>): string | null {
    return spineV2(variant, (node) => node.type === 'Image' && node.source.kind === 'capture')
}

function spineV2(variant: Pick<ScreenVariantV2, 'body'>, match: (node: ScreenNodeV2) => boolean): string | null {
    const find = (node: ScreenNodeV2, trail: string[]): string | null => {
        if (match(node)) return trail.join('>')
        const kids = nodeChildrenV2(node)
        for (let at = 0; at < kids.length; at += 1) {
            const found = find(kids[at]!, [...trail, `${node.type}.${at}`])
            if (found !== null) return found
        }
        return null
    }
    return find(variant.body, [])
}

const RESULT_FACT_PREFIX = 'result:'

/** Facts and sources a variant must carry, shared by the schema and the fallback builder. */
export function variantRequirementsV2(
    name: 'ready' | VariantState,
    requirements: RequirementsV2,
    document?: { facts: readonly FactV2[]; sources: readonly DocumentSourceV2[] },
): { facts: string[]; sources: number[]; hiddenFacts: string[] } {
    // A waiting variant never states the held result, and neither does a failure variant of a photo-first screen: the
    // result is revealed only in `ready`, after the held photo (fail closed, not a UI patch).
    const withheld = name === 'busy' || name === 'pending' || (name !== 'ready' && requirements.capture)
    if (!withheld) {
        // A quick check that states what was understood owes it in its ready screen only: a waiting or failing variant
        // claims no step, so a person never sees the manual's steps before the screen that can earn them.
        const overview = name === 'ready' ? (document?.facts ?? []).filter(isOverviewFactV2) : []
        const cited =
            document === undefined
                ? []
                : sourceResolverV2(document.sources)(overview.flatMap((fact) => fact.sourceRefs))
        return {
            facts: [...requirements.facts, ...overview.map((fact) => fact.factId)],
            sources: [...new Set([...requirements.sources, ...cited])],
            hiddenFacts: [],
        }
    }
    const isResult = (factId: string): boolean => factId.startsWith(RESULT_FACT_PREFIX)
    const hiddenFacts = requirements.facts.filter(isResult)
    const facts = requirements.facts.filter((factId) => !isResult(factId))
    if (document === undefined || hiddenFacts.length === 0) {
        return { facts, sources: [...requirements.sources], hiddenFacts }
    }
    const wanted = new Set(facts)
    const resolve = sourceResolverV2(document.sources)
    const sources = resolve(document.facts.filter((fact) => wanted.has(fact.factId)).flatMap((fact) => fact.sourceRefs))
    return { facts, sources, hiddenFacts }
}

export function variantPolicyV2(
    kind: ScreenKindV2,
    name: 'ready' | VariantState,
    requirements: RequirementsV2,
    document?: { facts: readonly FactV2[]; sources: readonly DocumentSourceV2[] },
): VariantPolicyV2 {
    const failing = name === 'error' || name === 'recovery'
    const confirming = name === 'confirming'
    const ready = name === 'ready'
    const needs = variantRequirementsV2(name, requirements, document)
    // The overview of a quick check is earned by its ready screen alone; any other variant claims none of it.
    const overviewFacts = (document?.facts ?? []).filter(isOverviewFactV2)
    const overview = overviewFacts.length > 0 || requirements.parts.length > 0
    // A camera that runs stays mounted while its screen waits, and a pending screen never blocks the shutter.
    const cameraReady = kind === 'camera' && requirements.nodes.includes('CameraView')
    const keepCamera = cameraReady && (name === 'busy' || name === 'pending')
    const actions: AppIntent[] =
        name === 'ready' || name === 'empty'
            ? [...requirements.actions]
            : confirming
              ? [...requirements.confirm]
              : cameraReady && name === 'pending'
                ? [{ intent: 'capture', target: 'take-photo' }]
                : []
    return {
        facts: needs.facts,
        sources: needs.sources,
        actions,
        recover: failing,
        nodes: name === 'ready' ? [...requirements.nodes] : keepCamera ? ['CameraView'] : [],
        forbiddenNodes: [
            ...(failing ? (['CameraView'] as const) : []),
            ...(needs.hiddenFacts.length > 0 ? (['VerdictCard'] as const) : []),
        ],
        forbiddenIntents: failing && kind === 'camera' ? ['capture'] : [],
        forbiddenPairs: kind === 'reading' && !confirming ? [{ intent: 'navigate', target: 'reading' }] : [],
        forbiddenFacts: needs.hiddenFacts,
        forbiddenOverview: overview && !ready ? overviewFacts.map((fact) => fact.factId) : [],
        withholdOverview: overview && !ready,
        title: overview && ready,
        parts: ready ? [...requirements.parts] : [],
        partsVisible: ready ? Math.min(OVERVIEW_PARTS_VISIBLE_V2, requirements.parts.length) : 0,
        only: confirming ? [...requirements.confirm] : null,
        capture: requirements.capture && name !== 'confirming',
        figure: name === 'ready' ? requirements.figure : null,
        notice: requirements.notice && noticeShownInV2(kind, name),
        camera: keepCamera,
    }
}

/** Collects the first problem of each rule; shared by the published-document schema and the server's model gate. */
export function validateStructureV2(
    document: Parameters<typeof variantsOfV2>[0] & {
        kind: ScreenKindV2
        requirements?: Pick<RequirementsV2, 'confirm'>
    },
    add: (message: string) => void,
): void {
    const { nodes, depth, variantNodes } = structureOfV2(document)
    if (variantNodes > DOCUMENT_V2_LIMITS.nodes) add('Too many nodes in one variant')
    if (nodes > DOCUMENT_V2_LIMITS.documentNodes) add('Too many nodes in one document')
    if (depth > DOCUMENT_V2_LIMITS.depth) add('Tree is too deep')
    const required = requiredStatesV2(document.kind, document.requirements)
    for (const state of required) {
        if (document.states[state] === null) add(`Missing ${state} variant`)
    }
    if (
        document.requirements !== undefined &&
        document.states.confirming !== null &&
        !required.includes('confirming')
    ) {
        add('A confirming variant needs the reading cancellation witness')
    }
    const allowed = INTENTS_BY_KIND_V2[document.kind]
    let primaries = 0
    for (const { prefix, variant } of variantsOfV2(document)) {
        const intents: AppIntent[] = [
            ...(variant.header.back ? [variant.header.back.intent] : []),
            ...variant.header.actions.map((action) => action.intent),
        ]
        visitVariantNodesV2(variant, prefix, (entry) => {
            intents.push(...nodeIntentsV2(entry.node))
            if (entry.node.type === 'PrimaryAction' && !entry.path.endsWith('bar.primary')) primaries += 1
        })
        if (variant.overlays.some((overlay) => overlay.content.targetId !== overlay.anchor)) {
            add('A tooltip anchors its own coach mark')
        }
        if (intents.some((intent) => !allowed.includes(intent.intent))) add('Intent is not allowed on this screen')
        if (variant.header.back && variant.header.back.intent.intent !== 'navigate') add('Back must navigate')
    }
    if (primaries > 0) add('A primary action lives only in the bar')
}

export const screenDocumentV2Schema = z
    .strictObject({
        version: z.literal(SCREEN_DOCUMENT_V2_VERSION),
        kind: screenKindV2Schema,
        screenId: sha256,
        /** Identity of the exact manual revision, step, capture and result; `contextKey` hashes the full state. */
        bound: screenBoundSchema,
        metadata: documentMetadataV2Schema,
        ...screenVariantV2Schema.shape,
        states: screenStatesV2Schema,
        facts: z.array(factV2Schema).max(DOCUMENT_V2_LIMITS.facts),
        sources: z.array(documentSourceV2Schema).max(DOCUMENT_V2_LIMITS.sources),
        requirements: requirementsV2Schema,
    })
    .superRefine((document, ctx) => {
        const add = (message: string): void => {
            ctx.addIssue({ code: 'custom', message })
        }
        validateStructureV2(document, add)
        const factIds = new Set(document.facts.map((fact) => fact.factId))
        if (factIds.size !== document.facts.length) add('Duplicate fact identity')
        const limit = document.sources.length
        const { metadata } = document
        const variantPaths = variantComponentPathsV2(document)
        const paths = variantPaths.flatMap((variant) => variant.paths)
        const known = new Set(paths)
        if (
            Object.keys(metadata.origins).some((path) => !known.has(path)) ||
            paths.some((path) => metadata.origins[path] === undefined)
        ) {
            add('Origins must name every component exactly')
        }
        // A variant is attributed as a whole. Its origin is the document source, except a state variant that names the
        // generated document that really authored it in `metadata.carried`: only that provenance makes a component of a
        // fallback document `generated`.
        for (const { name, paths: own } of variantPaths) {
            const expected = variantOriginV2(metadata, name)
            if (own.some((path) => metadata.origins[path] !== undefined && metadata.origins[path] !== expected)) {
                add(
                    expected === 'generated' && metadata.source === 'fallback'
                        ? 'A carried state keeps the origin of the generated document that authored it'
                        : 'Every component origin matches the document source',
                )
            }
        }
        const carried = metadata.carried ?? {}
        for (const state of VARIANT_STATES) {
            const provenance = carried[state]
            if (provenance === undefined) continue
            if (
                provenance.authoring !== undefined &&
                (provenance.evidence !== 'synthetic-fixture' ||
                    provenance.generatedAt !== provenance.authoring.recordedAt)
            ) {
                add('A synthetic state preserves its actual author separately from provider observations')
            }
            if (metadata.source !== 'fallback') add('Only a fallback document carries generated states')
            if (document.states[state] === null) add(`A carried ${state} state must exist`)
            if (provenance.evidence === 'live' && provenance.model === null) add('A carried state names its model')
            if (
                provenance.evidence === 'synthetic-fixture' &&
                (provenance.model !== null || provenance.effort !== null)
            ) {
                add('A carried synthetic state claims no model or effort')
            }
            if (provenance.evidence === 'recorded-generation') {
                if (provenance.model === null || provenance.effort === null) {
                    add('A carried recording names its model and effort')
                }
                if (provenance.fixtureId === null) add('A carried recording names its fixture')
            } else if (provenance.fixtureId !== null) {
                add('Only a recording carries a fixture identity')
            }
        }
        if (Object.keys(metadata.sourceMap).some((path) => !known.has(path))) add('Source map names an unknown path')
        for (const indexes of Object.values(metadata.sourceMap)) {
            if (indexes.some((index) => index >= limit)) add('Source map does not index a document source')
        }
        if (
            metadata.authoring !== undefined &&
            (metadata.source !== 'generated' ||
                metadata.evidence !== 'synthetic-fixture' ||
                metadata.generatedAt !== metadata.authoring.recordedAt ||
                metadata.cacheHit)
        ) {
            add('Synthetic authoring is a generated fixture, never a provider response or cache hit')
        }
        if (metadata.source === 'generated') {
            if (metadata.evidence === 'local-deterministic') add('Generated content is never local')
            if (metadata.evidence === 'live' && metadata.model === null) add('Live generated content names its model')
            if (
                metadata.evidence === 'synthetic-fixture' &&
                (metadata.model !== null ||
                    metadata.effort !== null ||
                    Object.values(metadata.timing).some((value) => value !== null && value !== undefined) ||
                    Object.values(metadata.usage).some((value) => value !== null))
            ) {
                add('A synthetic example claims no model, timing or usage')
            }
            if (metadata.evidence === 'recorded-generation') {
                if (metadata.model === null || metadata.effort === null) {
                    add('A recording names its model and effort')
                }
                if ((metadata.fixtureId ?? null) === null) add('A recording names its fixture')
                if (
                    Object.values(metadata.timing).some((value) => value !== null && value !== undefined) ||
                    Object.values(metadata.usage).some((value) => value !== null)
                ) {
                    add('A recording claims no timing or usage')
                }
                if (metadata.cacheHit) add('A recording is never a cache hit')
            }
            if (metadata.fallbackReason !== null) add('Generated content has no fallback reason')
        } else if (metadata.fallbackReason === null) {
            add('Deterministic content names its reason')
        }
        if (metadata.source !== 'generated' && metadata.evidence === 'recorded-generation') {
            add('Deterministic content is never a recording')
        }
        if ((metadata.fixtureId ?? null) !== null && metadata.evidence !== 'recorded-generation') {
            add('Only a recording carries a fixture identity')
        }
        if (metadata.evidence === 'local-deterministic' && (metadata.model !== null || metadata.effort !== null)) {
            add('Local content claims no model')
        }

        // References and mandatory witnesses, variant by variant: only what the person can see without opening anything
        // counts (an overlay or a collapsed section never discharges a requirement).
        const { requirements } = document
        if (requirements.facts.some((reference) => !factIds.has(reference))) add('A required fact is unknown')
        if (requirements.sources.some((index) => index >= limit)) add('A required source does not exist')
        const resultFacts = {
            check: verdictCardFactIdsV2('check', document.facts),
            question: verdictCardFactIdsV2('question', document.facts),
        }
        const readySpine = cameraSpineV2(document)
        const readyPhotoSpine = photoSpineV2(document)
        for (const { name, prefix, variant } of variantsOfV2(document)) {
            const policy = variantPolicyV2(document.kind, name, requirements, document)
            const stated = new Set<string>()
            const cited = new Set<number>()
            const sourceOpeners = new Set<number>()
            const offered: AppIntent[] = []
            const present = new Set<string>()
            const heldIntents: AppIntent[] = []
            const heldNodes = new Set<string>()
            let photo = false
            const figures = new Set<number>()
            // What the variant holds anywhere, collapsed or not (a withheld claim is refused wherever it hides), and
            // what it shows without opening anything (a requirement is discharged only by that).
            const mentioned = new Set<string>()
            const shownParts = new Set<string>()
            const heldParts = new Set<string>()
            let overviewMark = false
            let titled = false
            let notices = 0
            let visibleNotices = 0
            for (const reference of [variant.header.title, variant.header.subtitle]) {
                if (reference?.kind === 'bound' && reference.key === OVERVIEW_TITLE_KEY_V2) {
                    titled = true
                    overviewMark = true
                }
                if (reference?.kind !== 'fact') continue
                if (!factIds.has(reference.factId)) add('A node states an unknown fact')
                else {
                    stated.add(reference.factId)
                    mentioned.add(reference.factId)
                }
            }
            for (const action of [variant.header.back, ...variant.header.actions]) {
                if (action) {
                    offered.push(action.intent)
                    heldIntents.push(action.intent)
                }
            }
            visitVariantNodesV2(variant, prefix, (entry) => {
                heldNodes.add(entry.node.type)
                heldIntents.push(...nodeIntentsV2(entry.node))
                for (const reference of nodeFactIdsV2(entry.node)) {
                    if (!factIds.has(reference)) add('A node states an unknown fact')
                    else {
                        mentioned.add(reference)
                        if (!entry.hidden) stated.add(reference)
                    }
                }
                if (entry.node.type === 'PieceTile') {
                    heldParts.add(entry.node.partId)
                    overviewMark = true
                    if (!entry.hidden) shownParts.add(entry.node.partId)
                }
                if (entry.node.type === 'Image' || entry.node.type === 'ManualPage') overviewMark = true
                if (
                    nodeTextRefsV2(entry.node).some(
                        (reference) => reference.kind === 'bound' && reference.key === OVERVIEW_TITLE_KEY_V2,
                    )
                ) {
                    overviewMark = true
                    if (!entry.hidden) titled = true
                }
                const indexes = nodeSourceIndexesV2(entry.node)
                if (indexes.some((index) => index >= limit)) add('A node cites a source that does not exist')
                if (entry.node.type === 'Text' && entry.node.content.kind === 'bound') {
                    if (entry.node.content.key === OPERATION_NOTICE_KEY_V2) {
                        notices += 1
                        if (!entry.hidden) visibleNotices += 1
                    }
                }
                if (entry.hidden) return
                if (entry.node.type === 'Image' && entry.node.source.kind === 'source') {
                    figures.add(entry.node.source.index)
                }
                if (entry.node.type === 'VerdictCard' && entry.node.showReason) {
                    for (const reference of resultFacts[entry.node.result]) stated.add(reference)
                }
                for (const index of indexes) cited.add(index)
                if (entry.node.type === 'Citation' || entry.node.type === 'ManualPage') {
                    for (const index of indexes) sourceOpeners.add(index)
                }
                offered.push(...nodeIntentsV2(entry.node))
                present.add(entry.node.type)
                if (entry.node.type === 'Image' && entry.node.source.kind === 'capture') photo = true
            })
            if (policy.facts.some((reference) => !stated.has(reference))) {
                add(`A required fact is missing from the ${name} variant`)
            }
            if (policy.sources.some((index) => !cited.has(index))) {
                add(
                    name === 'ready'
                        ? 'A required citation is missing'
                        : `A required citation is missing from the ${name} variant`,
                )
            }
            // A displayed completion picture must offer its real page. The image itself is not a citation opener.
            if (document.kind === 'completion' && policy.figure !== null && !sourceOpeners.has(policy.figure)) {
                add('A required citation is missing')
            }
            for (const required of policy.actions) {
                if (!offered.some((has) => has.intent === required.intent && has.target === required.target)) {
                    add(
                        name === 'ready'
                            ? 'A required action is missing'
                            : `A required action is missing from the ${name} variant`,
                    )
                }
            }
            for (const type of policy.nodes) {
                if (!present.has(type)) add(`A required ${type} is missing`)
            }
            if (policy.recover && !offered.some((has) => has.intent === 'retry' || has.intent === 'navigate')) {
                add(`The ${name} variant offers no way to recover`)
            }
            if (policy.capture && !photo) add(`The held photo is missing from the ${name} variant`)
            if (policy.figure !== null && !figures.has(policy.figure)) {
                add(`The source picture is missing from the ${name} variant`)
            }
            if (policy.notice ? notices !== 1 || visibleNotices !== 1 : notices > 0) {
                add(
                    policy.notice
                        ? `The ${name} variant must state the operation notice exactly once`
                        : `The ${name} variant states an operation notice it does not hold`,
                )
            }
            if (policy.camera && cameraSpineV2(variant) !== readySpine) {
                add(`The ${name} variant moves the camera`)
            }
            if (policy.capture && name !== 'ready' && photoSpineV2(variant) !== readyPhotoSpine) {
                add(`The ${name} variant moves the held photo`)
            }
            if (policy.forbiddenFacts.some((reference) => mentioned.has(reference))) {
                add(`The ${name} variant states the held result before it is revealed`)
            }
            if (
                policy.forbiddenOverview.some((reference) => mentioned.has(reference)) ||
                (policy.withholdOverview && overviewMark)
            ) {
                add(`The ${name} variant states the manual overview before the ready screen`)
            }
            if (policy.title && !titled) add(`The manual title is missing from the ${name} variant`)
            if (policy.parts.some((partId) => !heldParts.has(partId))) {
                add(`A required part is missing from the ${name} variant`)
            }
            if (policy.parts.filter((partId) => shownParts.has(partId)).length < policy.partsVisible) {
                add(`The first parts must be visible in the ${name} variant`)
            }
            if (
                policy.forbiddenNodes.some((type) => heldNodes.has(type)) ||
                heldIntents.some((has) => policy.forbiddenIntents.includes(has.intent))
            ) {
                add(`The ${name} variant claims a camera it cannot have`)
            }
            const same = (a: AppIntent, b: AppIntent): boolean => a.intent === b.intent && a.target === b.target
            if (heldIntents.some((has) => policy.forbiddenPairs.some((forbidden) => same(has, forbidden)))) {
                add(`The ${name} variant offers an action that belongs to the confirmation`)
            }
            if (
                policy.only !== null &&
                heldIntents.some((has) => !policy.only!.some((allowedIntent) => same(has, allowedIntent)))
            ) {
                add(`The ${name} variant offers more than the confirmation`)
            }
        }
        if (canonicalJson(sourceMapV2(document)) !== canonicalJson(metadata.sourceMap)) {
            add('Source map must equal the recomputed map')
        }
    })

/** Future versions fail to parse and the app keeps its local deterministic document. */
export type ScreenDocumentV2 = z.infer<typeof screenDocumentV2Schema>

/** The kind of a v1 document is a v2 kind; this narrows a v2 kind to a v1 one when it is. */
export function isV1Kind(kind: ScreenKindV2): kind is ScreenKind {
    return (SCREEN_KINDS as readonly string[]).includes(kind)
}
