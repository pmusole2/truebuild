import { z } from 'zod'

import { aiEffortSchema } from './telemetry'

/**
 * Model-composed screens. The model authors which typed blocks appear, their order, emphasis and wording; it never
 * authors styles, code, markup, URLs, routes, provenance or timings. Everything below is finite by construction:
 * no recursion (groups and disclosures hold leaf blocks only), so depth and node counts are bounded for correctness,
 * not for cost, and a provider JSON schema can be generated without $ref.
 */
export const SCREEN_DOCUMENT_VERSION = 1 as const
/**
 * Catalog 2 adds the full-screen composition blocks (ManualLibrary, PageGallery, FactPrompt, FactEditor,
 * QuestionComposer, SourceDetails, ActionLink, CameraGuidance, ManualDirections) and the document-level `manualFacts`.
 */
export const SCREEN_CATALOG_VERSION = 2 as const

export const SCREEN_LIMITS = {
    title: 60,
    subtitle: 80,
    label: 48,
    action: 32,
    chip: 24,
    caption: 80,
    tip: 120,
    text: 160,
    answer: 500,
    instructionWords: 20,
    instructionChars: 140,
    bodyNodes: 14,
    totalNodes: 28,
    children: 6,
    options: 6,
    listItems: 12,
    regions: 4,
    citations: 16,
    sources: 64,
    libraryManuals: 12,
    cue: 40,
    pill: 24,
    prompt: 80,
} as const

/**
 * The most manual facts one step can publish, from the existing per-step manual bounds: 100 safety notes, one selected
 * alternative, one title, one orientation, one connection, 100 visible checks and 100 correction actions. It bounds the
 * mandatory payload by what a manual can contain; it is not a display budget.
 */
export const MANUAL_FACT_LIMIT = 304

export const SCREEN_KINDS = [
    'home',
    'add',
    'pages',
    'reading',
    'quick-check',
    'guide',
    'result',
    'questions',
    'answer',
    'more',
    'completion',
    'error',
    'recovery',
] as const
export const screenKindSchema = z.enum(SCREEN_KINDS)
export type ScreenKind = z.infer<typeof screenKindSchema>

const id = z.string().trim().min(1).max(128)
// A numeric comparison is plain text. Every other opening angle bracket and every code delimiter is rejected.
const MARKUP = /`|<(?!\s*=?\s*[+-]?\d)/u
// No word boundary: `xhttps://` must not slip past the scheme check.
const SCHEME = /:\/\/|www\.|(?:https?|ftp|file|data|javascript|mailto):/iu
const MARKDOWN_LINK = /\]\(/u

function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0
        if (code < 0x20 || code === 0x7f) return true
    }
    return false
}

/** Plain text only: no markup, URL, control character or markdown link. Length is measured in code points. */
export function isPlainScreenText(value: string): boolean {
    return !hasControlCharacter(value) && !MARKUP.test(value) && !SCHEME.test(value) && !MARKDOWN_LINK.test(value)
}

export function wordCount(value: string): number {
    const trimmed = value.trim()
    return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

function text(max: number): z.ZodString {
    return z.string().trim().min(1).max(max).refine(isPlainScreenText, { message: 'Plain text required' })
}

/** Indexes into the document's `sources` (published) or the supplied source table (model proposal). */
const citations = z
    .array(
        z
            .number()
            .int()
            .min(0)
            .max(SCREEN_LIMITS.sources - 1),
    )
    .max(SCREEN_LIMITS.citations)

export const ICON_NAMES = [
    'alert',
    'arrowRight',
    'camera',
    'check',
    'chevronLeft',
    'chevronRight',
    'close',
    'help',
    'image',
    'info',
    'more',
    'plus',
    'refresh',
    'search',
    'settings',
] as const
export const screenIconSchema = z.enum(ICON_NAMES)
export type ScreenIcon = z.infer<typeof screenIconSchema>

/** Existing coach targets only; the app drops a tip whose target is not on the current screen. */
export const TIP_TARGETS = [
    'home-add',
    'keep-building',
    'header-more',
    'take-page-photo',
    'choose-pages',
    'read-manual',
    'add-page',
    'quick-check-fix',
    'quick-check-skip',
    'quick-check-clearer',
    'quick-check-start',
    'guide-hero',
    'guide-primary',
    'guide-hero-frame',
    'camera-shutter',
] as const

/** Tips that belong to the camera view: the only targets camera guidance may name. */
export const CAMERA_TIP_TARGETS = ['camera-shutter', 'guide-hero-frame'] as const

export const APP_INTENTS = [
    'navigate',
    'capture',
    'check',
    'ask',
    'confirm',
    'retry',
    'open-details',
    'show-tips',
] as const
export const ROUTE_TARGETS = ['home', 'add', 'pages', 'reading', 'quick-check', 'guide', 'done', 'more'] as const
/**
 * Where a navigate intent can go: a route, or `back` (close what is open / return to where the person came from). `back`
 * names no route: the app resolves it from its own stack, a sheet host or the camera, so a screen never has to guess
 * which route it was opened from.
 */
export const NAVIGATE_TARGETS = [...ROUTE_TARGETS, 'back'] as const

/** Finite typed targets per intent. The app maps each pair to an existing controller call and checks preconditions. */
export const INTENT_TARGETS = {
    navigate: NAVIGATE_TARGETS,
    capture: ['take-photo', 'choose-pages', 'add-page', 'retake'],
    check: ['current-step'],
    ask: ['about-step', 'about-part'],
    confirm: ['reading', 'facts', 'step', 'manual', 'camera-permission'],
    retry: ['last-action', 'reading', 'check', 'question', 'screen', 'camera'],
    'open-details': ['step', 'result', 'sources', 'about-check', 'device-settings'],
    'show-tips': ['screen'],
} as const

export const appIntentSchema = z.discriminatedUnion('intent', [
    z.strictObject({ intent: z.literal('navigate'), target: z.enum(INTENT_TARGETS.navigate) }),
    z.strictObject({ intent: z.literal('capture'), target: z.enum(INTENT_TARGETS.capture) }),
    z.strictObject({ intent: z.literal('check'), target: z.enum(INTENT_TARGETS.check) }),
    z.strictObject({ intent: z.literal('ask'), target: z.enum(INTENT_TARGETS.ask) }),
    z.strictObject({ intent: z.literal('confirm'), target: z.enum(INTENT_TARGETS.confirm) }),
    z.strictObject({ intent: z.literal('retry'), target: z.enum(INTENT_TARGETS.retry) }),
    z.strictObject({ intent: z.literal('open-details'), target: z.enum(INTENT_TARGETS['open-details']) }),
    z.strictObject({ intent: z.literal('show-tips'), target: z.enum(INTENT_TARGETS['show-tips']) }),
])
export type AppIntent = z.infer<typeof appIntentSchema>

const emphasis = z.enum(['normal', 'strong', 'quiet'])
const quantity = z.number().int().min(1).max(999)

export const screenHeaderSchema = z.strictObject({
    type: z.literal('ScreenHeader'),
    title: text(SCREEN_LIMITS.title),
    subtitle: text(SCREEN_LIMITS.subtitle).nullable(),
    trailing: appIntentSchema.nullable(),
})

const instructionText = text(SCREEN_LIMITS.instructionChars).refine(
    (value) => wordCount(value) <= SCREEN_LIMITS.instructionWords,
    { message: 'Up-front instruction must be 20 words or fewer' },
)

const regionBox = z
    .strictObject({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().gt(0).max(1),
        height: z.number().gt(0).max(1),
    })
    .refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1, { message: 'Region must lie in the image' })
const heroFields = {
    type: z.literal('HeroFigure'),
    source: z.enum(['page', 'capture', 'part']),
    refId: id,
    caption: text(SCREEN_LIMITS.caption).nullable(),
    fit: z.enum(['cover', 'contain']),
}
/** The model may emphasize an existing figure region by naming its supplied source index; it never writes geometry. */
const heroProposal = z.strictObject({
    ...heroFields,
    sourceRefIndex: z
        .number()
        .int()
        .min(0)
        .max(SCREEN_LIMITS.sources - 1)
        .nullable()
        .optional(),
})
/** Published form: the region is copied by the server from the cited manual source, never from the model. */
const heroFigure = z.strictObject({ ...heroFields, region: regionBox.nullable().optional() })
const instruction = z.strictObject({
    type: z.literal('Instruction'),
    text: instructionText,
    emphasis,
    citations,
})
const partList = z.strictObject({
    type: z.literal('PartList'),
    items: z
        .array(z.strictObject({ partId: id, label: text(60), quantity: quantity.nullable() }))
        .min(1)
        .max(SCREEN_LIMITS.listItems),
    showQuantities: z.boolean(),
})
const quantityChip = z.strictObject({
    type: z.literal('QuantityChip'),
    partId: id,
    label: text(SCREEN_LIMITS.chip),
    quantity,
})
const warning = z.strictObject({
    type: z.literal('Warning'),
    text: text(SCREEN_LIMITS.text),
    tone: z.enum(['caution', 'critical']),
    citations,
})
const stepProgress = z.strictObject({
    type: z.literal('StepProgress'),
    current: z.number().int().min(1).max(200),
    total: z.number().int().min(1).max(200),
    label: text(40).nullable(),
})
const choiceList = z.strictObject({
    type: z.literal('ChoiceList'),
    prompt: text(SCREEN_LIMITS.caption).nullable(),
    options: z
        .array(z.strictObject({ label: text(SCREEN_LIMITS.label), intent: appIntentSchema }))
        .min(2)
        .max(SCREEN_LIMITS.options),
})
const confirmFact = z.strictObject({
    type: z.literal('ConfirmFact'),
    text: text(SCREEN_LIMITS.text),
    confirm: appIntentSchema,
    dismiss: appIntentSchema.nullable(),
    citations,
})
const regionRole = z.enum(['next', 'target'])
/** What the model may ask for: which known part regions to outline. It never supplies geometry. */
const photoProposal = z.strictObject({
    type: z.literal('PhotoWithRegions'),
    captureId: id,
    showObserved: z.boolean(),
    regions: z.array(z.strictObject({ partId: id, role: regionRole })).max(SCREEN_LIMITS.regions),
})
/** Published form: geometry copied by the server from the validated result, never from the model. */
const photoWithRegions = z.strictObject({
    type: z.literal('PhotoWithRegions'),
    captureId: id,
    observed: regionBox.nullable(),
    regions: z.array(z.strictObject({ partId: id, role: regionRole, box: regionBox })).max(SCREEN_LIMITS.regions),
})
const resultBanner = z.strictObject({
    type: z.literal('ResultBanner'),
    verdict: z.enum(['pass', 'refuse', 'cannot_verify']),
    text: text(SCREEN_LIMITS.text),
    citations,
})
const answerCard = z.strictObject({
    type: z.literal('AnswerCard'),
    text: text(SCREEN_LIMITS.answer),
    caveat: text(120).nullable(),
    citations,
})
const tip = z.strictObject({
    type: z.literal('Tip'),
    targetId: z.enum(TIP_TARGETS),
    heading: text(40),
    text: text(SCREEN_LIMITS.tip),
})
const skeleton = z.strictObject({
    type: z.literal('Skeleton'),
    variant: z.enum(['lines', 'card', 'hero']),
    lines: z.number().int().min(1).max(5),
})

const factId = z.string().trim().min(1).max(160)
const libraryManualIds = z.array(id).min(1).max(SCREEN_LIMITS.libraryManuals)
/** Live library entries, chosen by the person's own data; the model only picks density and which to list. */
const manualLibrary = z.strictObject({
    type: z.literal('ManualLibrary'),
    entries: z.union([z.literal('recent'), z.strictObject({ manualIds: libraryManualIds })]),
    layout: z.enum(['cards', 'rows']),
    showProgress: z.boolean(),
    emptyText: text(SCREEN_LIMITS.caption).nullable(),
})
/** The session's pages (live thumbnails and order); add/retake/replace/move/remove stay native intents. */
const pageGallery = z.strictObject({
    type: z.literal('PageGallery'),
    pages: z.literal('session'),
    layout: z.enum(['list', 'grid']),
    showNumbers: z.boolean(),
    action: appIntentSchema.nullable(),
})
/** The one editable review question the app holds. The model words the prompt; facts and drafts stay native. */
const factPrompt = z.strictObject({
    type: z.literal('FactPrompt'),
    questionRef: z.literal('current'),
    prompt: text(SCREEN_LIMITS.prompt),
    detail: text(SCREEN_LIMITS.text).nullable(),
    citations,
})
const factEditor = z.strictObject({
    type: z.literal('FactEditor'),
    questionRef: z.literal('current'),
    kind: z.enum(['orientation', 'checks']),
    label: text(SCREEN_LIMITS.label),
    saveLabel: text(SCREEN_LIMITS.action),
    cancelLabel: text(SCREEN_LIMITS.action),
})
/** Ask composer for the held capture. Draft, part choice and point state stay in the controller. */
const questionComposer = z.strictObject({
    type: z.literal('QuestionComposer'),
    captureRef: z.literal('current'),
    prompt: text(SCREEN_LIMITS.prompt).nullable(),
    partScope: z.enum(['step-parts', 'none']),
    submitLabel: text(SCREEN_LIMITS.action),
})
/** Cited manual pages (indexes into the document `sources`); regions are the manual's own, copied by the server. */
const sourceDetails = z.strictObject({
    type: z.literal('SourceDetails'),
    label: text(40),
    sources: citations.min(1),
    fit: z.enum(['cover', 'contain']),
    initiallyOpen: z.boolean(),
})
/** One quiet contextual link. Never a second primary action. */
const actionLink = z.strictObject({
    type: z.literal('ActionLink'),
    label: text(SCREEN_LIMITS.label),
    icon: screenIconSchema.nullable(),
    intent: appIntentSchema,
    emphasis,
})
/** Camera overlay wording only. Preview, corners, shutter and permission flow stay native. */
const cameraGuidance = z.strictObject({
    type: z.literal('CameraGuidance'),
    cue: text(SCREEN_LIMITS.cue),
    pill: text(SCREEN_LIMITS.pill).nullable(),
    tipTarget: z.enum(CAMERA_TIP_TARGETS).nullable(),
})
/**
 * Complete source-witnessed directions and safety of the step, by reference to document `manualFacts` (never text).
 * The model chooses which facts appear here, in what order and with what emphasis; the server writes the text.
 */
const manualDirections = z.strictObject({
    type: z.literal('ManualDirections'),
    factIds: z.array(factId).min(1).max(MANUAL_FACT_LIMIT),
    emphasis,
})

/** Heavy blocks stand alone at the top level of the body; groups and disclosures hold text-like leaves only. */
const heavyBlocks = [
    manualLibrary,
    pageGallery,
    factPrompt,
    factEditor,
    questionComposer,
    sourceDetails,
    cameraGuidance,
    manualDirections,
] as const

const sharedLeafBlocks = [
    instruction,
    partList,
    quantityChip,
    warning,
    stepProgress,
    choiceList,
    confirmFact,
    resultBanner,
    answerCard,
    tip,
    skeleton,
    actionLink,
] as const
const leafBlocks = [heroFigure, ...sharedLeafBlocks] as const
const proposalLeafBlocks = [heroProposal, ...sharedLeafBlocks] as const
const leaf = z.discriminatedUnion('type', [...leafBlocks, photoWithRegions])
const proposalLeaf = z.discriminatedUnion('type', [...proposalLeafBlocks, photoProposal])

const groupLayout = z.enum(['stack', 'row'])
const children = SCREEN_LIMITS.children
const group = z.strictObject({
    type: z.literal('Group'),
    layout: groupLayout,
    children: z.array(leaf).min(1).max(children),
})
const details = z.strictObject({
    type: z.literal('DetailsDisclosure'),
    label: text(40),
    initiallyOpen: z.boolean(),
    children: z.array(leaf).min(1).max(children),
})
const proposalGroup = z.strictObject({
    type: z.literal('Group'),
    layout: groupLayout,
    children: z.array(proposalLeaf).min(1).max(children),
})
const proposalDetails = z.strictObject({
    type: z.literal('DetailsDisclosure'),
    label: text(40),
    initiallyOpen: z.boolean(),
    children: z.array(proposalLeaf).min(1).max(children),
})

export const screenNodeSchema = z.discriminatedUnion('type', [
    ...leafBlocks,
    photoWithRegions,
    group,
    details,
    ...heavyBlocks,
])
export type ScreenNode = z.infer<typeof screenNodeSchema>
export type ScreenLeafNode = z.infer<typeof leaf>
const proposalNodeSchema = z.discriminatedUnion('type', [
    ...proposalLeafBlocks,
    photoProposal,
    proposalGroup,
    proposalDetails,
    ...heavyBlocks,
])

export const primaryActionSchema = z.strictObject({
    type: z.literal('PrimaryAction'),
    label: text(SCREEN_LIMITS.action),
    icon: screenIconSchema.nullable(),
    intent: appIntentSchema,
})
export const secondaryActionSchema = z.strictObject({
    type: z.literal('SecondaryAction'),
    label: text(SCREEN_LIMITS.action),
    icon: screenIconSchema.nullable(),
    intent: appIntentSchema,
})
const bar = z.strictObject({ primary: primaryActionSchema, secondary: secondaryActionSchema.nullable() })

type BlockLike = { readonly type: string; readonly children?: readonly unknown[] }

export function countScreenNodes(body: readonly BlockLike[]): number {
    return body.reduce((total, node) => total + 1 + (node.children?.length ?? 0), 0)
}

function boundedBody(body: readonly BlockLike[], ctx: z.RefinementCtx): void {
    if (countScreenNodes(body) > SCREEN_LIMITS.totalNodes) {
        ctx.addIssue({ code: 'custom', message: 'Too many blocks on one screen' })
    }
}

/** What the model returns. No identity, provenance, timing or geometry: the server assigns all of it. */
export const screenProposalSchema = z
    .strictObject({
        header: screenHeaderSchema,
        body: z.array(proposalNodeSchema).max(SCREEN_LIMITS.bodyNodes),
        bar,
    })
    .superRefine((proposal, ctx) => boundedBody(proposal.body, ctx))
export type ScreenProposal = z.infer<typeof screenProposalSchema>
/** Provider-facing schema is the same shape without refinements (JSON Schema carries the structural limits). */
export const providerScreenProposalSchema = z.strictObject({
    header: screenHeaderSchema,
    body: z.array(proposalNodeSchema).max(SCREEN_LIMITS.bodyNodes),
    bar,
})

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
/** Identity of the exact manual revision, step, capture and result a screen was composed for. */
export const screenBoundSchema = z.strictObject({
    manualId: id.nullable(),
    revision: z.number().int().positive().nullable(),
    stepId: id.nullable(),
    captureId: id.nullable(),
    /** SHA-256 of the canonical grounding context. A different manual value, result or capture changes it. */
    contextKey: sha256,
})
export type ScreenBound = z.infer<typeof screenBoundSchema>

/** Closed failure classes a screen is composed around. Never a message, stack or provider text. */
export const SCREEN_FAILURES = [
    'unconfigured',
    'unauthorized',
    'invalid_input',
    'timeout',
    'provider_error',
    'invalid_output',
] as const
export type ScreenFailure = (typeof SCREEN_FAILURES)[number]

export const SCREEN_SOURCES = ['generated', 'fallback', 'shell'] as const
export const screenSourceSchema = z.enum(SCREEN_SOURCES)
export type ScreenSource = z.infer<typeof screenSourceSchema>
export const FALLBACK_REASONS = [
    'disabled',
    'fixture',
    'unconfigured',
    'timeout',
    'provider_error',
    'invalid_output',
    'repair_failed',
    'unsupported_content',
    'stale',
    'busy',
] as const
const nullableMs = z.number().min(0).nullable()
const nullableCount = z.number().int().min(0).nullable()

/**
 * Canonical component paths of a document: `header`, `body.<i>`, `body.<i>.children.<j>`, `bar.primary` and
 * `bar.secondary`. Origins and any per-component accounting are keyed by these strings.
 */
export const COMPONENT_PATH = /^(?:header|bar\.(?:primary|secondary)|body\.\d{1,2}(?:\.children\.\d)?|facts\.\d{1,3})$/u

export function screenComponentPaths(document: {
    body: readonly { readonly type: string; readonly children?: readonly unknown[] }[]
    bar: { secondary: unknown }
    manualFacts?: readonly unknown[] | undefined
}): string[] {
    return [
        'header',
        ...document.body.flatMap((node, index) => [
            `body.${index}`,
            ...(node.children ?? []).map((_child, child) => `body.${index}.children.${child}`),
        ]),
        'bar.primary',
        ...(document.bar.secondary === null ? [] : ['bar.secondary']),
        ...(document.manualFacts ?? []).map((_fact, index) => `facts.${index}`),
    ]
}

/** Server-observed facts only. A value the server did not observe is null, never estimated. */
export const screenMetadataSchema = z.strictObject({
    /**
     * Composition source of the document as a whole: `generated` when at least one component is model-composed,
     * `fallback` when every component is deterministic server composition, `shell` for an empty (native) body.
     * A generated document can still contain deterministic components; `origins` says which.
     */
    source: screenSourceSchema,
    /**
     * Server-owned origin of each component (see `screenComponentPaths`). Only a component the model chose and the
     * server accepted unchanged is `generated`; anything the server wrote, replaced or forced is `fallback`.
     * Absent only on documents from servers that predate it: then fall back to `source` for the whole screen.
     */
    origins: z.record(z.string().regex(COMPONENT_PATH), screenSourceSchema).optional(),
    /**
     * `live`: composed by a runtime with a configured provider (a fallback after a real failure is still `live`; it
     * proves no provider call by itself).
     * `synthetic-fixture`: a fixture/test runtime; never evidence of model output. A `generated` document with this
     * evidence is an honest synthetic example (its model, effort, timing and usage are all null).
     */
    evidence: z.enum(['live', 'synthetic-fixture']),
    stage: z.enum(['screen', 'step-page']),
    model: z.enum(['muse-spark-1.3', 'muse-wonder-1.0']).nullable(),
    effort: aiEffortSchema.nullable(),
    fallbackReason: z.enum(FALLBACK_REASONS).nullable(),
    repaired: z.boolean(),
    /** True when this exact document was served from the server cache; timing then describes the original run. */
    cacheHit: z.boolean(),
    catalogVersion: z.literal(SCREEN_CATALOG_VERSION),
    promptVersion: z.number().int().positive(),
    generatedAt: z.iso.datetime(),
    timing: z.strictObject({
        timeToProviderMs: nullableMs,
        providerMs: nullableMs,
        parseValidateMs: nullableMs,
        totalMs: nullableMs,
        /** Split of `providerMs`; absent from servers that predate it, null when the call did not observe it. */
        paceWaitMs: nullableMs.optional(),
        networkMs: nullableMs.optional(),
        bodyMs: nullableMs.optional(),
    }),
    /** Totals are null when any attempt of this document did not report the value (never a partial sum). */
    usage: z.strictObject({
        inputTokens: nullableCount,
        cachedTokens: nullableCount,
        outputTokens: nullableCount,
        /** A subset of outputTokens. */
        reasoningTokens: nullableCount,
    }),
    /**
     * Model-proposed content the server removed (whole blocks and part-list items). Component replacements and
     * forced content are counted separately in `grounding`.
     */
    droppedFacts: z.number().int().min(0),
    /** Manual safety Warning blocks the server inserted because the composition omitted or collapsed them. */
    forcedSafety: z.number().int().min(0),
    grounding: z
        .strictObject({
            droppedBlocks: z.number().int().min(0),
            droppedItems: z.number().int().min(0),
            /** Header/bar/label components the server replaced with deterministic copy. */
            replacedComponents: z.number().int().min(0),
            /** Verdict/answer/figure-detail blocks the server wrote from the actual validated result. */
            forcedRequired: z.number().int().min(0),
        })
        .optional(),
})
export type ScreenMetadata = z.infer<typeof screenMetadataSchema>

const documentSource = z.strictObject({ pageId: id, region: regionBox.nullable() })
export type ScreenDocumentSource = z.infer<typeof documentSource>

export const MANUAL_FACT_KINDS = [
    'safety',
    'title',
    'alternative',
    'orientation',
    'connection',
    'check',
    'correction',
] as const
/**
 * Why a fact is in the payload. `safety-note`: the manual states it as safety (always required). `unclassified-step`:
 * the step has no explicit safety classification, so this known direction is conservatively required. `direction`:
 * an ordinary known direction of a classified step, available to ManualDirections but not required.
 */
export const MANUAL_FACT_BASES = ['safety-note', 'unclassified-step', 'direction'] as const

/**
 * A complete, source-witnessed manual fact: the manual's own words, untouched (not clipped, not stripped of operators
 * or punctuation, not subject to the model-text plain rule: it is manual data rendered as native text), with the
 * actual pages and figure regions that support it.
 */
export const manualFactSchema = z.strictObject({
    factId,
    kind: z.enum(MANUAL_FACT_KINDS),
    basis: z.enum(MANUAL_FACT_BASES),
    text: z.string().min(1).max(1_100),
    sourceRefs: z.array(documentSource).min(1).max(100),
})
export type ManualFact = z.infer<typeof manualFactSchema>
/** True for a fact every screen of the step must show. */
export const isRequiredManualFact = (fact: Pick<ManualFact, 'basis'>): boolean => fact.basis !== 'direction'

/**
 * Published form. `body`: a ManualDirections block of this document shows it (visibly, not collapsed). `remainder`:
 * no such block does, so the app shows it in the mandatory section after the body. Server-owned.
 */
export const publishedManualFactSchema = manualFactSchema.extend({ placement: z.enum(['body', 'remainder']) })
export type PublishedManualFact = z.infer<typeof publishedManualFactSchema>

const sectionName = z.enum(['settings', 'how-it-works', 'about-this-check', 'compare', 'tips'])
const uiTitle = z.string().trim().min(1).max(200)
/**
 * The app's own state a composition may bind to (live data the model never writes). Presence flags and ids only: no
 * raw drafts, free text from the person, photos, one-use tickets or tokens. Everything is optional, and a screen kind
 * uses only the part it needs (see `screenContextJson`).
 */
export const screenUiStateSchema = z.strictObject({
    /** Home: the person's manuals, most recent first. */
    library: z
        .strictObject({
            entries: z
                .array(
                    z.strictObject({
                        manualId: id,
                        title: uiTitle,
                        updatedAt: z.iso.datetime(),
                        stopStepId: id.nullable(),
                        completed: z.number().int().min(0).max(200),
                        total: z.number().int().min(0).max(200),
                        firstPageId: id.nullable(),
                    }),
                )
                .max(100),
            soleManualId: id.nullable(),
        })
        .nullable()
        .optional(),
    /** Add / Pages: the captured pages in order. */
    pages: z
        .strictObject({
            items: z
                .array(
                    z.strictObject({
                        pageId: id,
                        width: z.number().int().positive().max(24_000_000),
                        height: z.number().int().positive().max(24_000_000),
                    }),
                )
                .max(20),
            maxPages: z.number().int().min(1).max(20),
            canRead: z.boolean(),
            languageOptions: z.array(z.string().trim().min(1).max(16)).max(40),
        })
        .nullable()
        .optional(),
    /** Quick check: the one editable question the app holds and whether confirmation is possible. */
    review: z
        .strictObject({
            currentQuestion: z
                .strictObject({
                    questionId: id,
                    kind: z.enum(['orientation', 'checks']),
                    stepId: id,
                    stepOrder: z.number().int().positive().max(200),
                    reason: z.string().trim().min(1).max(500).nullable(),
                    parts: z.array(z.strictObject({ partId: id, label: uiTitle })).max(SCREEN_LIMITS.listItems),
                })
                .nullable(),
            blockers: z.number().int().min(0).max(200),
            canConfirm: z.boolean(),
        })
        .nullable()
        .optional(),
    /** Guide / result / questions / answer: the held capture and what a question is aimed at (presence of a draft only). */
    capture: z
        .strictObject({
            captureId: id,
            reusable: z.boolean(),
            target: z
                .discriminatedUnion('kind', [
                    z.strictObject({ kind: z.literal('part'), partId: id }),
                    z.strictObject({ kind: z.literal('point') }),
                ])
                .nullable(),
            questionDraftPresent: z.boolean(),
        })
        .nullable()
        .optional(),
    /** More: which native sections exist. Values stay native. */
    sections: z.array(sectionName).max(8).nullable().optional(),
})
export type ScreenUiState = z.infer<typeof screenUiStateSchema>

type CitedBlock = {
    readonly type: string
    readonly citations?: readonly number[]
    readonly sources?: readonly number[]
    readonly children?: readonly unknown[]
}

/** Facts are unique; directions reference only published facts, each at most once; placement says where it shows. */
function validateManualFacts(
    document: { body: readonly ScreenNode[]; manualFacts?: readonly PublishedManualFact[] | undefined },
    ctx: z.RefinementCtx,
): void {
    const facts = document.manualFacts ?? []
    const known = new Set(facts.map((fact) => fact.factId))
    if (known.size !== facts.length) ctx.addIssue({ code: 'custom', message: 'Duplicate manual fact identity' })
    const placed = new Set<string>()
    for (const block of document.body) {
        if (block.type !== 'ManualDirections') continue
        for (const reference of block.factIds) {
            if (!known.has(reference)) ctx.addIssue({ code: 'custom', message: 'Directions name an unpublished fact' })
            else if (placed.has(reference)) ctx.addIssue({ code: 'custom', message: 'A fact is placed only once' })
            placed.add(reference)
        }
    }
    for (const fact of facts) {
        if ((fact.placement === 'body') !== placed.has(fact.factId)) {
            ctx.addIssue({ code: 'custom', message: 'Fact placement must match the directions that show it' })
        }
    }
}

export const screenDocumentV1Schema = z
    .strictObject({
        version: z.literal(SCREEN_DOCUMENT_VERSION),
        kind: screenKindSchema,
        screenId: sha256,
        bound: screenBoundSchema,
        metadata: screenMetadataSchema,
        header: screenHeaderSchema,
        body: z.array(screenNodeSchema).max(SCREEN_LIMITS.bodyNodes),
        bar,
        /** The actual manual sources (page + figure region) that block `citations` index. Server-owned. */
        sources: z.array(documentSource).max(SCREEN_LIMITS.sources).optional(),
        /**
         * Mandatory and referenced manual facts of the step, complete and outside the node bound. Required facts are
         * present even when the body is empty (a shell): the app always shows them, never only the optional body.
         */
        manualFacts: z.array(publishedManualFactSchema).max(MANUAL_FACT_LIMIT).optional(),
    })
    .superRefine((document, ctx) => {
        boundedBody(document.body, ctx)
        const { metadata } = document
        if (metadata.source === 'generated') {
            if (metadata.evidence === 'live' && metadata.model === null) {
                ctx.addIssue({ code: 'custom', message: 'Live generated content names its model' })
            }
            if (
                metadata.evidence === 'synthetic-fixture' &&
                (metadata.model !== null ||
                    metadata.effort !== null ||
                    Object.values(metadata.timing).some((value) => value !== null && value !== undefined) ||
                    Object.values(metadata.usage).some((value) => value !== null))
            ) {
                ctx.addIssue({ code: 'custom', message: 'A synthetic example claims no model, timing or usage' })
            }
        }
        if (metadata.source !== 'generated' && metadata.fallbackReason === null) {
            ctx.addIssue({ code: 'custom', message: 'Deterministic content names its reason' })
        }
        if (metadata.origins !== undefined) {
            const paths = screenComponentPaths(document)
            const known = new Set(paths)
            const origins = metadata.origins
            if (
                Object.keys(origins).some((path) => !known.has(path)) ||
                paths.some((path) => origins[path] === undefined)
            ) {
                ctx.addIssue({ code: 'custom', message: 'Origins must name every component exactly' })
            }
            const generated = Object.values(origins).some((origin) => origin === 'generated')
            if (generated !== (metadata.source === 'generated')) {
                ctx.addIssue({ code: 'custom', message: 'Document source must match component origins' })
            }
            if (metadata.source === 'shell' && document.body.length > 0) {
                ctx.addIssue({ code: 'custom', message: 'A shell has no body' })
            }
        }
        const limit = document.sources?.length ?? 0
        const visit = (block: CitedBlock): void => {
            if (block.citations?.some((index) => index >= limit)) {
                ctx.addIssue({ code: 'custom', message: 'Citation does not index a document source' })
            }
            if (block.sources?.some((index) => index >= limit)) {
                ctx.addIssue({ code: 'custom', message: 'Source details do not index a document source' })
            }
            for (const child of block.children ?? []) visit(child as CitedBlock)
        }
        for (const block of document.body) visit(block)
        validateManualFacts(document, ctx)
    })

/** Future versions fail to parse and the app keeps its native screen. */
export const screenDocumentSchema = z.discriminatedUnion('version', [screenDocumentV1Schema])
export type ScreenDocument = z.infer<typeof screenDocumentSchema>

const screenUnavailableCodes = z.enum([
    'unconfigured',
    'unauthorized',
    'invalid_input',
    'timeout',
    'provider_error',
    'invalid_output',
    'budget_exhausted',
    'duplicate_request',
])

export const screenStateSchema = z.enum(['queued', 'running', 'ready', 'fallback', 'failed', 'cancelled'])
export type ScreenState = z.infer<typeof screenStateSchema>
export const screenProgressSchema = z.strictObject({
    manualId: id,
    revision: z.number().int().positive(),
    contextKey: sha256,
    mode: z.enum(['full', 'steps', 'off']),
    steps: z.array(z.strictObject({ stepId: id, state: screenStateSchema, screenId: sha256.nullable() })).max(200),
})
export type ScreenProgress = z.infer<typeof screenProgressSchema>

/** `/api/screens` response. Home must work before any manual exists, so identity lives in the document `bound`. */
export const screensResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('ok'),
        requestId: id,
        mode: z.enum(['fixture', 'model']),
        value: z.strictObject({
            document: screenDocumentSchema.nullable(),
            progress: screenProgressSchema.nullable(),
            /** Documents the client asked for in `want`; each carries its own `bound` identity. */
            documents: z.array(screenDocumentSchema).max(8),
        }),
    }),
    z.strictObject({
        status: z.literal('unavailable'),
        requestId: id,
        binding: z.null(),
        code: screenUnavailableCodes,
        retryable: z.boolean(),
    }),
])
export type ScreensResult = z.infer<typeof screensResultSchema>

/**
 * A document applies to the current screen only if every identity field matches, including the exact context key
 * (it changes with any manual value, page identity, result, capture or completion witness). The key is required: a
 * caller that cannot compute it cannot apply a document.
 */
export function screenMatches(bound: ScreenBound, current: ScreenBound): boolean {
    return (
        bound.manualId === current.manualId &&
        bound.revision === current.revision &&
        bound.stepId === current.stepId &&
        bound.captureId === current.captureId &&
        bound.contextKey === current.contextKey
    )
}
