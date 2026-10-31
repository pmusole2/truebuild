/**
 * The direct v2 FALLBACK BUILDER: the last resort, used only when no authored document is valid for a context.
 *
 * Architecture, in one place:
 * - An authored document (a model response accepted by the server gate, or a recorded model response published by
 *   `assembleDocumentV2`) is always preferred. It carries `source: 'generated'` and its own provenance.
 * - When none is valid (generation off, no provider, a timeout, a rejected and repaired answer, a stale revision),
 *   this module builds the COMPLETE document of the same catalog directly from the validated material: every ready node
 *   and every required state variant, every mandatory fact, citation and action. It is v2 end to end: it constructs
 *   `ScreenNodeV2` values and never converts, wraps or adapts a version 1 screen.
 * - Its output is always `source: 'fallback'` and every origin is `fallback`. A deterministic template can never be
 *   relabelled generated, here or by carrying one of its variants (see `rebindGeneratedStatesV2`).
 * - It owns no identity, provenance or tables: `assembleDocumentV2` (document-v2-assemble.ts) adds those for every
 *   producer, and `verifyDocumentAgainstInputsV2` (document-v2-verify.ts) lets a request-bound client check any of them.
 */
import {
    DOCUMENT_V2_LIMITS,
    VARIANT_STATES,
    OVERVIEW_PARTS_VISIBLE_V2,
    OVERVIEW_TITLE_KEY_V2,
    isOverviewFactV2,
    noticeShownInV2,
    requiredStatesV2,
    variantRequirementsV2,
    sourceResolverV2,
    type BarV2,
    type DocumentMetadataV2,
    type FactV2,
    type FallbackReasonV2,
    type HeaderActionV2,
    type HeaderV2,
    type LabelTextRefV2,
    type OverlayV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
    type TextRefV2,
    type VariantState,
} from './document-v2'
import {
    BUSY_COPY_V2,
    CAMERA_ACCESS_COPY_V2,
    CAMERA_TIPS_V2,
    COMPLETION_FIGURE_COPY_V2,
    COMPLETION_MANUAL_COPY_V2,
    CONFIRM_LABELS_V2,
    COACH_COPY_V2,
    EMPTY_COPY_V2,
    FAILURE_COPY_V2,
    NO_FIGURE_COPY_V2,
    NO_OVERVIEW_FIGURE_COPY_V2,
    NO_STEP_FIGURE_COPY_V2,
    STATE_COPY_V2,
} from './document-v2-copy'
import {
    coachTargetsForV2,
    intentAllowedV2,
    READING_KEEP_V2,
    READING_STOP_V2,
    documentMaterialV2,
    type DocumentMaterialV2,
} from './document-v2-material'
import { cameraAccessV2, moreScopedV2, resultOfKindV2, type ScreenContextInputsV2 } from './document-v2-context'
import { assembleDocumentV2, type AssembleDeps, type DocumentFacts } from './document-v2-assemble'
import type { AppIntent, ScreenIcon } from './screen'

type Node = ScreenNodeV2
type Tone = 'neutral' | 'info' | 'success' | 'caution' | 'critical'
type Space = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'

// ---------------------------------------------------------------------------------------------------------------------
// Small constructors. Everything below builds the same v2 catalog the model authors with, one node at a time.
// ---------------------------------------------------------------------------------------------------------------------

const lit = (text: string): LabelTextRefV2 => ({ kind: 'literal', text })
const factRef = (factId: string): LabelTextRefV2 => ({ kind: 'fact', factId })
const bound = (key: Extract<LabelTextRefV2, { kind: 'bound' }>['key']): LabelTextRefV2 => ({ kind: 'bound', key })
const intent = <I extends AppIntent['intent']>(
    name: I,
    target: Extract<AppIntent, { intent: I }>['target'],
): AppIntent => ({ intent: name, target }) as AppIntent

function text(
    content: TextRefV2,
    options: Partial<{
        role: 'display' | 'title' | 'heading' | 'body' | 'label' | 'caption'
        emphasis: 'quiet' | 'normal' | 'strong'
        tone: Tone
    }> = {},
): Node {
    return {
        type: 'Text',
        content,
        role: options.role ?? 'body',
        emphasis: options.emphasis ?? 'normal',
        tone: options.tone ?? 'neutral',
        align: 'start',
    }
}
const stack = (children: Node[], gap: Space = 'md'): Node => ({ type: 'Stack', gap, align: 'stretch', children })
const card = (children: Node[], tone: Tone = 'neutral'): Node => ({
    type: 'Card',
    surface: tone === 'neutral' ? 'raised' : 'tinted',
    tone,
    padding: 'md',
    children,
})
const section = (title: string | null, children: Node[], collapsed = false): Node => ({
    type: 'Section',
    title: title === null ? null : lit(title),
    collapsible: collapsed,
    initiallyOpen: !collapsed,
    children,
})
const scroll = (children: Node[]): Node => ({ type: 'Scroll', axis: 'vertical', children })
const chips = (indexes: readonly number[]): Node[] => {
    const nodes: Node[] = []
    const per = DOCUMENT_V2_LIMITS.citationIndexes
    for (let at = 0; at < indexes.length; at += per) {
        nodes.push({ type: 'Citation', sources: indexes.slice(at, at + per), label: null, display: 'chip' })
    }
    return nodes
}

/** Children one packed container holds; well under the schema bound so a container never overflows. */
const PACK = 48

/**
 * Lossless, order-preserving packing: whole entries (a fact and its citations stay together) fill a container until the
 * next would pass `PACK` children, then a new container starts. Nothing is clipped, dropped or reordered.
 */
function pack(entries: readonly Node[][], wrap: (children: Node[]) => Node): Node[] {
    const groups: Node[][] = []
    let current: Node[] = []
    for (const entry of entries) {
        if (current.length > 0 && current.length + entry.length > PACK) {
            groups.push(current)
            current = []
        }
        current.push(...entry)
    }
    if (current.length > 0) groups.push(current)
    return groups.map(wrap)
}

/** Nests a long child list into balanced stacks until no container exceeds `PACK` children (order preserved). */
function nest(nodes: Node[]): Node[] {
    let level = nodes
    while (level.length > PACK) {
        const next: Node[] = []
        for (let at = 0; at < level.length; at += PACK) next.push(stack(level.slice(at, at + PACK), 'sm'))
        level = next
    }
    return level
}
const primary = (label: string, to: AppIntent, icon: ScreenIcon | null = null): BarV2['primary'] => ({
    type: 'PrimaryAction',
    label,
    icon,
    intent: to,
})
const secondary = (label: string, to: AppIntent, icon: ScreenIcon | null = null): NonNullable<BarV2['secondary']> => ({
    type: 'SecondaryAction',
    label,
    icon,
    intent: to,
})

/** Sheets and overlays the person closes (not a step back through the flow): their back says Close. */
const CLOSE_KINDS: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>(['more', 'judge', 'compare', 'questions'])

// ---------------------------------------------------------------------------------------------------------------------
// Parts of a screen.
// ---------------------------------------------------------------------------------------------------------------------

interface Built {
    title: LabelTextRefV2
    subtitle: LabelTextRefV2 | null
}

function titleOf(material: DocumentMaterialV2): Built {
    const { inputs, decision } = material
    switch (inputs.kind) {
        case 'home':
            return { title: lit('Your manuals'), subtitle: null }
        case 'add':
            return { title: lit('Add a manual'), subtitle: null }
        case 'pages':
            return { title: lit('Your pages'), subtitle: null }
        case 'reading':
            return { title: lit('Reading your manual'), subtitle: null }
        case 'quick-check':
            return {
                title: lit('Quick check'),
                subtitle: inputs.uiState?.review?.currentQuestion ? bound('review-position') : null,
            }
        case 'guide':
            return material.step
                ? { title: bound('step-position'), subtitle: bound('step-title') }
                : { title: lit('This step'), subtitle: null }
        case 'camera':
            return inputs.uiState?.camera?.mode === 'manual-page'
                ? { title: lit('Photograph a page'), subtitle: null }
                : { title: lit('Take a photo'), subtitle: material.step ? bound('step-title') : null }
        case 'result':
            // A check that has not returned says only what the app is doing; the verdict titles are earned by a decision.
            return {
                title: lit(
                    material.pendingCheck
                        ? BUSY_COPY_V2.checking.heading
                        : decision === 'pass'
                          ? 'Looks right'
                          : decision === 'refuse'
                            ? 'Not quite right'
                            : 'Cannot tell yet',
                ),
                subtitle: bound('step-title'),
            }
        case 'questions':
            return { title: lit('Ask about this step'), subtitle: bound('step-title') }
        case 'answer':
            return { title: lit('Answer'), subtitle: bound('step-title') }
        case 'more':
            // A step-scoped More names its step; a global More names nothing (it has no manual to name).
            return { title: lit('More'), subtitle: material.step ? bound('step-title') : null }
        case 'completion':
            return {
                title: lit(material.completion === 'witnessed' ? 'All steps done' : 'Your build'),
                subtitle: null,
            }
        case 'error':
            return { title: lit('Something went wrong'), subtitle: null }
        case 'recovery':
            return { title: lit('Fix this step'), subtitle: bound('step-title') }
        case 'judge':
            return { title: lit('About this check'), subtitle: null }
        case 'compare':
            return { title: lit('Compare manuals'), subtitle: null }
    }
}

/** Screens that keep the header More the app always had (settings, privacy, help and the judge entry live behind it). */
const HEADER_MORE_KINDS: ReadonlySet<ScreenKindV2> = new Set<ScreenKindV2>([
    'home',
    'add',
    'pages',
    'quick-check',
    'guide',
    'result',
    'answer',
    'recovery',
    'completion',
])

function headerOf(material: DocumentMaterialV2, withActions: boolean): HeaderV2 {
    const { inputs } = material
    // Home is the root; every other screen goes back the way the app knows (the stack, a sheet host or the camera).
    const back: HeaderActionV2 | null =
        inputs.kind === 'home'
            ? null
            : CLOSE_KINDS.has(inputs.kind)
              ? { label: 'Close', icon: 'close', intent: intent('navigate', 'back') }
              : { label: 'Back', icon: 'chevronLeft', intent: intent('navigate', 'back') }
    const more: HeaderActionV2[] =
        withActions && HEADER_MORE_KINDS.has(inputs.kind)
            ? [{ label: 'More', icon: 'more', intent: intent('navigate', 'more') }]
            : []
    return { ...titleOf(material), back, actions: more }
}

/**
 * A fact and the citations of its own sources, kept together so the fact stays attributable wherever it is packed.
 */
function factEntry(
    fact: FactV2,
    resolve: (refs: FactV2['sourceRefs']) => number[],
    withCitations: boolean,
    look: { emphasis: 'normal' | 'strong'; tone: Tone },
): Node[] {
    return [text(factRef(fact.factId), look), ...(withCitations ? chips(resolve(fact.sourceRefs)) : [])]
}

/** Facts of the step the screen states, grouped: safety first, then the remaining required directions, then optional. */
function factNodes(material: DocumentMaterialV2, withCitations: boolean): Node[] {
    const resolve = sourceResolverV2(material.sources)
    const entries = (facts: FactV2[], safety: boolean): Node[][] =>
        facts.map((fact) =>
            factEntry(fact, resolve, withCitations, {
                emphasis: safety || fact.kind === 'safety' ? 'strong' : 'normal',
                tone: fact.kind === 'safety' ? 'caution' : 'neutral',
            }),
        )
    const manual = material.facts.filter((fact) => fact.basis !== 'result')
    const isSafety = (fact: FactV2): boolean => fact.kind === 'safety' || fact.basis === 'safety-note'
    const requiredIds = new Set(material.requirements.facts)
    const safety = manual.filter(isSafety)
    const required = manual.filter((fact) => !isSafety(fact) && requiredIds.has(fact.factId))
    const optional = manual.filter((fact) => !isSafety(fact) && !requiredIds.has(fact.factId))
    return [
        ...(safety.length > 0
            ? [section('Safety', nest(pack(entries(safety, true), (children) => card(children, 'caution'))))]
            : []),
        ...(required.length > 0
            ? [section('Directions', nest(pack(entries(required, false), (children) => card(children))))]
            : []),
        ...(optional.length > 0
            ? [section('More detail', nest(pack(entries(optional, false), (children) => card(children))), true)]
            : []),
    ]
}

const verdictCard = (kind: 'check' | 'question', variant: 'banner' | 'card'): Node => ({
    type: 'VerdictCard',
    result: kind,
    variant,
    showReason: true,
    showRegions: true,
})

function resultNodes(material: DocumentMaterialV2, variant: 'banner' | 'card'): Node[] {
    const { result } = material.inputs
    if (result === null) return []
    // A More that holds a check also holds the answer given about its photo: each is its own card.
    return [
        verdictCard(result.kind, variant),
        ...(result.kind === 'check' && resultOfKindV2(material.inputs, 'question') !== null
            ? [verdictCard('question', variant)]
            : []),
    ]
}

function partNodes(material: DocumentMaterialV2): Node[] {
    return material.partIds.length === 0
        ? []
        : [
              {
                  type: 'Grid',
                  columns: 2,
                  gap: 'sm',
                  children: material.partIds.map<Node>((partId) => ({
                      type: 'PieceTile',
                      partId,
                      showQuantity: true,
                      size: 'md',
                  })),
              },
          ]
}

const overviewTile = (partId: string): Node => ({ type: 'PieceTile', partId, showQuantity: false, size: 'sm' })
/** Lossless: tiles fill grids of at most `PACK` children, in order, so all of a manual's (at most 256) parts are listed. */
const overviewGrids = (partIds: readonly string[]): Node[] =>
    nest(
        pack(
            partIds.map((partId) => [overviewTile(partId)]),
            (children) => ({ type: 'Grid', columns: 3, gap: 'sm', children }),
        ),
    )

/**
 * What the quick check of a fully known manual states so the person has something to confirm: the manual's own title,
 * the picture of its first cited step (or the honest absence), each step's title by fact reference with the pages it
 * cites, and the known parts (no count: a part's quantity belongs to a step). Nothing here is a literal about the manual.
 */
function overviewNodes(material: DocumentMaterialV2): Node[] {
    if (!material.overview) return []
    const resolve = sourceResolverV2(material.sources)
    const steps = material.facts.filter(isOverviewFactV2)
    const shown = material.partIds.slice(0, OVERVIEW_PARTS_VISIBLE_V2)
    const rest = material.partIds.slice(OVERVIEW_PARTS_VISIBLE_V2)
    return [
        text(bound(OVERVIEW_TITLE_KEY_V2), { role: 'title', emphasis: 'strong' }),
        ...(material.requirements.figure === null
            ? [text(lit(NO_OVERVIEW_FIGURE_COPY_V2), { tone: 'info' })]
            : heroImage(material)),
        section(
            'Steps',
            nest(
                pack(
                    steps.map((fact) => factEntry(fact, resolve, true, { emphasis: 'normal', tone: 'neutral' })),
                    (children) => card(children),
                ),
            ),
        ),
        ...(shown.length > 0 ? [section('Parts', overviewGrids(shown))] : []),
        ...(rest.length > 0 ? [section('More detail', overviewGrids(rest), true)] : []),
    ]
}

const heroImage = (material: DocumentMaterialV2): Node[] =>
    material.diagram[0] === undefined
        ? []
        : [
              {
                  type: 'Image',
                  source: { kind: 'source', index: material.diagram[0] },
                  fit: 'contain',
                  ratio: 'hero',
                  caption: null,
              },
          ]
const capturedImage = (material: DocumentMaterialV2): Node[] =>
    material.inputs.captureId === null
        ? []
        : [{ type: 'Image', source: { kind: 'capture' }, fit: 'cover', ratio: 'wide', caption: null }]

/**
 * The finished build's picture: the manual's own cited figure or page (`requirements.figure`, see `completionFigureV2`),
 * captioned for what it is, and the opener of that same source. Nothing when the manual has no picture.
 */
function completionFigure(material: DocumentMaterialV2): { picture: Node[]; source: Node[] } {
    const index = material.requirements.figure
    const source = index === null ? undefined : material.sources[index]
    if (index === null || source === undefined) return { picture: [], source: [] }
    const caption = source.region === null ? COMPLETION_FIGURE_COPY_V2.page : COMPLETION_FIGURE_COPY_V2.figure
    return {
        picture: [
            {
                type: 'Image',
                source: { kind: 'source', index },
                fit: 'contain',
                ratio: 'square',
                caption: lit(caption),
            },
        ],
        source: chips([index]),
    }
}

/**
 * The finished build's count: the app's own `completion-summary` text, never rewritten. Only a witnessed completion
 * groups it with one small success check (the earned-state gate refuses that check anywhere else); every other build
 * keeps the plain count.
 */
function completionCount(material: DocumentMaterialV2): Node {
    const count = text(bound('completion-summary'))
    return material.completion === 'witnessed'
        ? {
              type: 'Row',
              gap: 'sm',
              align: 'center',
              justify: 'start',
              wrap: false,
              children: [{ type: 'Icon', name: 'check', tone: 'success', size: 'sm' }, count],
          }
        : count
}

/**
 * Lets the person say which part a question is about: offered only when the app actually holds a photo to point at and
 * the step has named parts, bound to the app's own target state. No target is ever preselected or invented here.
 */
const partTargetChoice = (material: DocumentMaterialV2): Node[] =>
    material.inputs.uiState?.capture && material.inputs.captureId !== null && material.partIds.length > 0
        ? [
              {
                  type: 'Choice',
                  prompt: lit('Which part is your question about?'),
                  options: { mode: 'bound', binding: 'part-target' },
              },
          ]
        : []

/** The app's problem notice, stated once where a failure is shown (and never appended by the native layer). */
const noticeNodes = (material: DocumentMaterialV2, name: 'ready' | VariantState): Node[] =>
    material.requirements.notice && noticeShownInV2(material.inputs.kind, name)
        ? [text({ kind: 'bound', key: 'operation-notice' }, { tone: 'caution' })]
        : []

/** The camera as the ready screen places it; the waiting variants repeat it at the same position. */
const cameraView = (material: DocumentMaterialV2): Node => {
    const camera = material.inputs.uiState?.camera
    return {
        type: 'CameraView',
        mode: camera?.mode ?? 'build-photo',
        cue: camera?.mode === 'manual-page' ? 'Fill the frame with the page' : 'Keep the whole step in view',
        pill: null,
        tipTarget: camera?.mode === 'manual-page' ? null : 'guide-hero-frame',
    }
}

/** The two tips under a working camera: one card of two rows, repeated at the same place while the camera waits. */
const cameraTips = (material: DocumentMaterialV2): Node =>
    card(
        CAMERA_TIPS_V2[material.inputs.uiState?.camera?.mode ?? 'build-photo'].map((tip, index): Node => ({
            type: 'Row',
            gap: 'sm',
            align: 'start',
            justify: 'start',
            wrap: false,
            children: [
                { type: 'Icon', name: index === 0 ? 'image' : 'search', tone: 'info', size: 'sm' },
                text(lit(tip)),
            ],
        })),
    )

const labelText = (words: string): Node => text(lit(words), { role: 'label', emphasis: 'strong' })
const boundText = (key: Extract<TextRefV2, { kind: 'bound' }>['key'], quiet = false): Node =>
    text({ kind: 'bound', key }, quiet ? { role: 'caption', tone: 'info' } : {})

/**
 * Settings and help: privacy, what is stored and the reading language, how the app works, then the tips and judge
 * entries. Every sentence about the app is bound text the native binder resolves (the app's own wording), never a
 * literal. Beside a step these are collapsed (still one tap away); a global More keeps them open.
 */
function moreAppSections(material: DocumentMaterialV2, collapsed: boolean): Node[] {
    const ui = material.inputs.uiState
    const sections = ui?.sections ?? []
    const settings: Node[] = [
        ...(ui?.settings
            ? [
                  labelText('Your builds on this device'),
                  boundText('storage-summary'),
                  boundText('storage-note', true),
                  secondary('Open device settings', intent('open-details', 'device-settings'), 'settings'),
              ]
            : []),
        ...((ui?.language?.options.length ?? 0) > 0
            ? [
                  {
                      type: 'Choice',
                      prompt: lit('Reading language'),
                      options: { mode: 'bound', binding: 'language' },
                  } as Node,
              ]
            : []),
    ]
    return [
        section(
            'Privacy',
            [
                boundText('privacy-stay'),
                labelText('What leaves this device'),
                boundText('privacy-read'),
                boundText('privacy-check'),
                boundText('privacy-ask'),
                boundText('privacy-once', true),
                labelText('Camera and photos'),
                boundText('privacy-camera'),
                boundText('privacy-library'),
            ],
            collapsed,
        ),
        ...(sections.includes('settings') && settings.length > 0 ? [section('Settings', settings, collapsed)] : []),
        ...(sections.includes('how-it-works')
            ? [
                  section(
                      'How it works',
                      [boundText('help-scan'), boundText('help-look'), boundText('help-next'), boundText('help-ask')],
                      collapsed,
                  ),
              ]
            : []),
        // Tips have no preference to switch: the person can only see them again (the app resets its coach).
        ...(sections.includes('tips') ? [secondary('Show tips again', intent('show-tips', 'screen'), 'help')] : []),
        ...(sections.includes('about-this-check')
            ? [secondary('About this check', intent('open-details', 'about-check'), 'info')]
            : []),
    ]
}

/** The step's own picture beside the held photo, from the manual's exact source (never an empty frame). */
function moreFigures(material: DocumentMaterialV2): Node[] {
    const diagram = heroImage(material)
    const photo = capturedImage(material)
    if (diagram.length > 0 && photo.length > 0) {
        const [figure] = diagram
        const [held] = photo
        return [
            {
                type: 'Row',
                gap: 'sm',
                align: 'stretch',
                justify: 'start',
                wrap: false,
                children: [
                    { ...(figure as Extract<Node, { type: 'Image' }>), ratio: 'square' },
                    { ...(held as Extract<Node, { type: 'Image' }>), ratio: 'square' },
                ],
            },
        ]
    }
    return [...photo, ...(diagram.length > 0 ? diagram : [text(lit(NO_STEP_FIGURE_COPY_V2), { tone: 'info' })])]
}

/** A result card and the citations of its own sources, kept together. */
function moreResult(material: DocumentMaterialV2, kind: 'check' | 'question'): Node[] {
    const held = resultOfKindV2(material.inputs, kind)
    if (held === null) return []
    const factId = kind === 'check' ? 'result:verdict' : 'result:answer'
    const refs = material.facts.find((fact) => fact.factId === factId)?.sourceRefs ?? []
    return [verdictCard(kind, 'card'), ...chips(sourceResolverV2(material.sources)(refs))]
}

function moreBody(material: DocumentMaterialV2): Node[] {
    if (material.step === null) {
        return [text(lit('Settings and help.'), { role: 'heading' }), ...moreAppSections(material, false)]
    }
    const parts = partNodes(material)
    return [
        text(lit('About this step'), { role: 'heading' }),
        ...moreFigures(material),
        ...moreResult(material, 'check'),
        ...(resultOfKindV2(material.inputs, 'question') === null
            ? []
            : [labelText('Your question'), boundText('held-question')]),
        ...moreResult(material, 'question'),
        ...factNodes(material, true),
        ...(parts.length > 0 ? [section('Parts', parts, true)] : []),
        ...moreAppSections(material, true),
    ]
}

function bodyOf(material: DocumentMaterialV2): Node[] {
    const { inputs } = material
    const ui = inputs.uiState
    switch (inputs.kind) {
        case 'home': {
            const entries = ui?.library?.entries.length ?? 0
            return [
                text(lit(entries > 0 ? 'Pick up where you left off.' : 'Add a manual to start building.'), {
                    role: 'heading',
                }),
                ...(entries > 0
                    ? [{ type: 'ManualList', entries: 'recent', layout: 'cards', showProgress: true } as Node]
                    : []),
            ]
        }
        case 'add':
            return [
                text(lit('Photograph each page of your manual, one at a time.'), { role: 'heading' }),
                ...((ui?.pages?.items.length ?? 0) > 0
                    ? [{ type: 'PageList', layout: 'grid', showNumbers: true } as Node]
                    : []),
                boundText('privacy-stay', true),
            ]
        case 'pages':
            return [
                text(ui?.pages ? bound('pages-summary') : lit('Add a page to begin.'), { role: 'heading' }),
                ...noticeNodes(material, 'ready'),
                ...((ui?.pages?.items.length ?? 0) > 0
                    ? [{ type: 'PageList', layout: 'list', showNumbers: true } as Node]
                    : [text(lit('Add a page to begin.'))]),
                boundText('privacy-stay', true),
            ]
        case 'reading':
            return [
                text(lit('Reading each page. This can take a minute.'), { role: 'heading' }),
                { type: 'Progress', binding: 'reading', label: null },
            ]
        case 'quick-check': {
            const question = ui?.review?.currentQuestion
            return [
                ...(question ? [{ type: 'Progress', binding: 'review', label: bound('review-position') } as Node] : []),
                text(lit('Check what we read before you start building.'), { role: 'heading' }),
                ...overviewNodes(material),
                ...(question
                    ? [
                          // The step's own picture from the manual (exact source, no invented figure), or the honest absence.
                          ...(material.requirements.figure === null
                              ? [text(lit(NO_FIGURE_COPY_V2), { tone: 'info' })]
                              : heroImage(material)),
                          ...(question.reason ? [text(bound('review-reason'), { tone: 'info' })] : []),
                          {
                              type: 'FactEditor',
                              kind: question.kind,
                              label: question.kind === 'orientation' ? 'Orientation' : 'What to look for',
                              saveLabel: 'Save',
                              cancelLabel: 'Cancel',
                          } as Node,
                      ]
                    : []),
            ]
        }
        case 'guide':
            return [
                ...heroImage(material),
                ...(material.step === null ? [] : [{ type: 'Progress', binding: 'step', label: null } as Node]),
                ...partNodes(material),
                ...factNodes(material, true),
            ]
        case 'camera': {
            const access = cameraAccessV2(ui?.camera)
            if (access !== 'ready') {
                const copy = CAMERA_ACCESS_COPY_V2[access]
                return [
                    text(lit(copy.heading), { role: 'heading' }),
                    text(lit(copy.detail), { tone: 'info' }),
                    boundText('privacy-camera', true),
                    ...factNodes(material, true),
                ]
            }
            return [cameraView(material), cameraTips(material), ...factNodes(material, true)]
        }
        case 'result':
            if (material.pendingCheck) {
                return [
                    ...capturedImage(material),
                    text(lit(BUSY_COPY_V2.checking.heading), { role: 'heading' }),
                    text(lit(BUSY_COPY_V2.checking.detail), { tone: 'info' }),
                    ...factNodes(material, true),
                ]
            }
            return [...capturedImage(material), ...resultNodes(material, 'banner'), ...factNodes(material, true)]
        case 'questions':
            return [
                text(lit('Ask anything about this step.'), { role: 'heading' }),
                ...capturedImage(material),
                ...partTargetChoice(material),
                ...(ui?.capture
                    ? [
                          {
                              type: 'TextField',
                              binding: 'question',
                              label: lit('Your question'),
                              placeholder: null,
                          } as Node,
                      ]
                    : []),
                ...factNodes(material, true),
            ]
        case 'answer':
            return [...capturedImage(material), ...resultNodes(material, 'card'), ...factNodes(material, true)]
        case 'more':
            return moreBody(material)
        case 'completion': {
            if (inputs.session === null) {
                return [text(bound('completion-summary'), { role: 'heading' })]
            }
            const figure = completionFigure(material)
            return [
                card([
                    text(lit(COMPLETION_MANUAL_COPY_V2.label), { role: 'label', emphasis: 'strong' }),
                    text(bound('manual-title'), { role: 'heading' }),
                    // The manual's own picture, honestly captioned (never a product photo the app does not have), and
                    // the opener of the page it came from, kept together.
                    ...figure.picture,
                    ...figure.source,
                    completionCount(material),
                    // One witnessed build indicator, kept with its manual and count.
                    { type: 'Progress', binding: 'build', label: null },
                ]),
                text(lit(COMPLETION_MANUAL_COPY_V2.hint), { tone: 'info' }),
            ]
        }
        case 'error':
            return [
                { type: 'Icon', name: 'alert', tone: 'caution', size: 'lg' },
                text(lit(FAILURE_COPY_V2[inputs.failure ?? 'provider_error'] ?? FAILURE_COPY_V2.provider_error ?? ''), {
                    role: 'heading',
                }),
                ...noticeNodes(material, 'ready'),
            ]
        case 'recovery':
            return [
                text(lit('Compare with the diagram, then try again.'), { role: 'heading' }),
                ...noticeNodes(material, 'ready'),
                ...heroImage(material),
                ...factNodes(material, true),
            ]
        case 'judge':
            return [
                text(lit('See how this check was made.'), { role: 'heading' }),
                { type: 'JudgePanel', panel: 'about-check' },
                { type: 'JudgePanel', panel: 'built-view' },
                { type: 'Toggle', binding: 'built-view', label: lit('Show how Meta AI built this') },
            ]
        case 'compare':
            return [
                text(lit('See two manuals side by side.'), { role: 'heading' }),
                { type: 'CompareColumns', subject: 'manuals' },
            ]
    }
}

function barOf(material: DocumentMaterialV2): BarV2 {
    const { inputs, reviewed, decision } = material
    const ask = secondary('Ask about this step', intent('ask', 'about-step'), 'help')
    const hasEntries = (inputs.uiState?.library?.entries.length ?? 0) > 0
    switch (inputs.kind) {
        case 'home':
            return hasEntries
                ? {
                      primary: primary('Continue building', intent('navigate', 'guide'), 'arrowRight'),
                      secondary: secondary('Add a manual', intent('navigate', 'add'), 'plus'),
                  }
                : { primary: primary('Add a manual', intent('navigate', 'add'), 'plus'), secondary: null }
        case 'add':
            return {
                primary: primary('Take photo', intent('capture', 'take-photo'), 'camera'),
                secondary: secondary('Choose photos', intent('capture', 'choose-pages'), 'image'),
            }
        case 'pages':
            return intentAllowedV2(intent('confirm', 'reading'), material)
                ? {
                      primary: primary('Read manual', intent('confirm', 'reading'), 'arrowRight'),
                      secondary: secondary('Add page', intent('capture', 'add-page'), 'plus'),
                  }
                : { primary: primary('Add page', intent('capture', 'add-page'), 'plus'), secondary: null }
        case 'reading':
            return { primary: primary('Back to pages', intent('navigate', 'pages'), 'chevronLeft'), secondary: null }
        case 'quick-check':
            // The whole manual is confirmed only when the app holds the witness for it. Otherwise (a question still to
            // answer, a clearer photo needed, nothing read yet) the way forward is the pages, as on the native screen.
            return {
                primary: intentAllowedV2(intent('confirm', 'facts'), material)
                    ? primary('Looks right', intent('confirm', 'facts'), 'check')
                    : primary('Back to pages', intent('navigate', 'pages'), 'chevronLeft'),
                secondary: secondary('Read again', intent('retry', 'reading'), 'refresh'),
            }
        case 'guide':
            return reviewed
                ? { primary: primary('Take photo', intent('capture', 'take-photo'), 'camera'), secondary: ask }
                : { primary: primary('Quick check', intent('navigate', 'quick-check'), 'check'), secondary: null }
        case 'camera': {
            const way = cameraAccessV2(inputs.uiState?.camera)
            const lead: BarV2['primary'] =
                way === 'allow'
                    ? primary('Allow camera', intent('confirm', 'camera-permission'), 'camera')
                    : way === 'settings'
                      ? primary('Open settings', intent('open-details', 'device-settings'), 'settings')
                      : way === 'retry'
                        ? primary('Try camera again', intent('retry', 'camera'), 'refresh')
                        : primary('Take photo', intent('capture', 'take-photo'), 'camera')
            return inputs.uiState?.camera?.mode === 'manual-page'
                ? { primary: lead, secondary: secondary('Back', intent('navigate', 'add'), 'chevronLeft') }
                : {
                      primary: lead,
                      secondary: secondary('Back to the guide', intent('navigate', 'guide'), 'chevronLeft'),
                  }
        }
        case 'result':
            // Nothing to confirm, retake or ask about until the check returns: the way out is back to the guide.
            if (material.pendingCheck) {
                return {
                    primary: primary('Back to the guide', intent('navigate', 'guide'), 'chevronLeft'),
                    secondary: null,
                }
            }
            return decision === 'pass'
                ? { primary: primary('Next step', intent('confirm', 'step'), 'arrowRight'), secondary: ask }
                : { primary: primary('Retake photo', intent('capture', 'retake'), 'camera'), secondary: ask }
        case 'questions':
            return {
                primary: primary('Ask', intent('ask', 'about-step'), 'help'),
                secondary: secondary('Take photo', intent('capture', 'take-photo'), 'camera'),
            }
        case 'answer':
            return {
                primary: primary('Back to the guide', intent('navigate', 'guide'), 'chevronLeft'),
                secondary: secondary('Ask another', intent('ask', 'about-step'), 'help'),
            }
        case 'more':
        case 'judge':
        case 'compare':
            // A sheet-like screen closes; Home (an explicit navigate/home) is a different thing and stays Home elsewhere.
            // A More beside a reviewed step can ask about it (the optional secondary, only with the witnesses).
            return {
                primary: primary('Close', intent('navigate', 'back'), 'close'),
                secondary:
                    inputs.kind === 'more' && intentAllowedV2(intent('ask', 'about-step'), material) ? ask : null,
            }
        case 'completion':
            return { primary: primary('Home', intent('navigate', 'home'), 'check'), secondary: null }
        case 'error':
            return {
                primary: primary('Try again', intent('retry', 'last-action'), 'refresh'),
                secondary: secondary('Home', intent('navigate', 'home'), 'chevronLeft'),
            }
        case 'recovery':
            return reviewed
                ? { primary: primary('Try again', intent('retry', 'last-action'), 'refresh'), secondary: ask }
                : { primary: primary('Quick check', intent('navigate', 'quick-check'), 'check'), secondary: null }
    }
}

function overlaysOf(material: DocumentMaterialV2): OverlayV2[] {
    return coachTargetsForV2(material).flatMap((target) => {
        const copy = COACH_COPY_V2[target]
        return copy
            ? [
                  {
                      kind: 'tooltip' as const,
                      anchor: target as NonNullable<OverlayV2['anchor']>,
                      content: {
                          type: 'CoachMark' as const,
                          targetId: target as NonNullable<OverlayV2['anchor']>,
                          heading: copy.heading,
                          body: copy.body,
                          placement: 'auto' as const,
                      },
                  },
              ]
            : []
    })
}

/**
 * The header of a state variant. A screen whose ready title is a claim about the person's work (a verdict, a finished
 * build) never lends that title to a state variant: it shows the calm state heading instead. Other screens keep theirs.
 * A busy variant that names its activity leads with that activity's heading on every screen.
 */
function stateHeader(
    state: VariantState,
    material: DocumentMaterialV2,
    ready: ScreenVariantV2,
): ScreenVariantV2['header'] {
    const { kind, uiState } = material.inputs
    // A busy screen's fixed header names what the app is doing (the body's own heading may be scrolled out of sight).
    const activity = state === 'busy' ? uiState?.busy?.activity : undefined
    if (activity !== undefined) return { ...ready.header, title: lit(BUSY_COPY_V2[activity].heading), actions: [] }
    if (kind !== 'result' && kind !== 'completion') return { ...ready.header, actions: [] }
    const title = kind === 'completion' ? lit('Your build') : lit(STATE_COPY_V2[state].heading)
    return { ...ready.header, title, actions: [] }
}

/** One state variant: same catalog, its own header, body, bar and coach state; mandatory facts stay stated. */
function stateVariant(state: VariantState, material: DocumentMaterialV2, ready: ScreenVariantV2): ScreenVariantV2 {
    const { inputs } = material
    const activity = state === 'busy' ? inputs.uiState?.busy?.activity : undefined
    const copy =
        (activity === undefined ? undefined : BUSY_COPY_V2[activity]) ??
        (state === 'empty' ? EMPTY_COPY_V2[inputs.kind] : undefined) ??
        STATE_COPY_V2[state]
    const waiting = state === 'busy' || state === 'pending'
    const retryAllowed = ['reading', 'quick-check', 'result', 'error', 'recovery'].includes(inputs.kind)
    const home = secondary('Home', intent('navigate', 'home'), 'chevronLeft')
    // A camera that failed leads its error and recovery screens with the way to try it again.
    const cameraRetry = inputs.kind === 'camera' && cameraAccessV2(inputs.uiState?.camera) === 'retry'
    // A waiting screen never offers to act on a result nobody has seen: its (disabled) bar only points back to the guide.
    const heldResult = inputs.kind === 'result' || inputs.kind === 'answer'
    // A camera that runs stays mounted while its document is prepared or a request is in flight (see `cameraSpineV2`);
    // while the document is only pending, guidance never blocks the shutter: the authored Take photo stays usable.
    const cameraRuns = inputs.kind === 'camera' && material.requirements.nodes.includes('CameraView')
    const holdCamera = waiting && cameraRuns
    const waitLabel = inputs.uiState?.busy?.activity === 'saving' ? 'Saving…' : 'Working…'
    const bar: BarV2 = waiting
        ? holdCamera && state === 'pending'
            ? { primary: primary('Take photo', intent('capture', 'take-photo'), 'camera'), secondary: null }
            : {
                  primary: primary(
                      waitLabel,
                      heldResult ? intent('navigate', 'guide') : ready.bar.primary.intent,
                      null,
                  ),
                  secondary: null,
              }
        : state === 'empty'
          ? ready.bar
          : cameraRetry && (state === 'error' || state === 'recovery')
            ? { primary: primary('Try camera again', intent('retry', 'camera'), 'refresh'), secondary: home }
            : inputs.kind === 'more'
              ? { primary: primary('Close', intent('navigate', 'back'), 'close'), secondary: null }
              : retryAllowed
                ? { primary: primary('Try again', intent('retry', 'last-action'), 'refresh'), secondary: home }
                : { primary: primary('Home', intent('navigate', 'home'), 'chevronLeft'), secondary: null }
    const resolve = sourceResolverV2(material.sources)
    const hidden = new Set(variantRequirementsV2(state, material.requirements, material).hiddenFacts)
    const requiredManual = material.facts.filter(
        (fact) => fact.basis !== 'result' && material.requirements.facts.includes(fact.factId),
    )
    const stated: Node[] = [
        ...(hidden.size > 0 ? [] : resultNodes(material, 'card')),
        ...(requiredManual.length > 0
            ? [
                  section(
                      'Safety and directions',
                      nest(
                          pack(
                              requiredManual.map((fact) =>
                                  factEntry(fact, resolve, true, { emphasis: 'strong', tone: 'neutral' }),
                              ),
                              (children) => card(children, 'caution'),
                          ),
                      ),
                  ),
              ]
            : []),
    ]
    return {
        header: stateHeader(state, material, ready),
        body: scroll([
            stack([
                ...(holdCamera ? [cameraView(material), cameraTips(material)] : []),
                // The held photo keeps the SAME spine as in `ready` (ancestors, types and child indexes), so the native
                // image is never remounted between pending, ready and a failure: a step-scoped More repeats its heading and
                // figures block, every other photo-first screen leads with the photo.
                ...(material.requirements.capture
                    ? moreScopedV2(inputs)
                        ? [text(lit('About this step'), { role: 'heading' }), ...moreFigures(material)]
                        : capturedImage(material)
                    : []),
                ...(waiting
                    ? [{ type: 'Progress', binding: activity === 'reading' ? 'reading' : 'build', label: null } as Node]
                    : []),
                text(lit(copy.heading), { role: 'heading' }),
                text(lit(copy.detail), { tone: 'info' }),
                ...noticeNodes(material, state),
                ...stated,
            ]),
        ]),
        bar,
        overlays: [],
    }
}

/**
 * The reading cancellation confirmation: a complete screen of its own that offers exactly Keep (dismiss, the reading
 * continues) and Stop (the app cancels the reading, then goes back to the pages). Nothing else.
 */
function confirmingVariant(): ScreenVariantV2 {
    const copy = STATE_COPY_V2.confirming
    return {
        header: { title: lit(copy.heading), subtitle: null, back: null, actions: [] },
        body: scroll([stack([text(lit(copy.heading), { role: 'heading' }), text(lit(copy.detail), { tone: 'info' })])]),
        bar: {
            primary: primary(CONFIRM_LABELS_V2.keep, READING_KEEP_V2, 'arrowRight'),
            secondary: secondary(CONFIRM_LABELS_V2.stop, READING_STOP_V2, 'close'),
        },
        overlays: [],
    }
}

/** Source indexes a variant shows without opening anything (a collapsed section or an overlay shows none). */
function visiblyCited(node: Node, hidden: boolean, into: Set<number>): void {
    if (!hidden) {
        if (node.type === 'Citation' || node.type === 'ManualPage') node.sources.forEach((index) => into.add(index))
        if (node.type === 'Image' && node.source.kind === 'source') into.add(node.source.index)
    }
    const collapsed = hidden || (node.type === 'Section' && node.collapsible && !node.initiallyOpen)
    if ('children' in node) node.children.forEach((child) => visiblyCited(child, collapsed, into))
}

/**
 * Mandatory citations not yet cited by a fact's own chips (a held result's sources, say) are shown together under the
 * manual pages, so every variant cites every required source. Added by this builder, never by the server.
 */
function withCoverage(
    variant: ScreenVariantV2,
    material: DocumentMaterialV2,
    name: 'ready' | VariantState,
): ScreenVariantV2 {
    const covered = new Set<number>()
    visiblyCited(variant.body, false, covered)
    visiblyCited(variant.bar.primary, false, covered)
    const missing = variantRequirementsV2(name, material.requirements, material).sources.filter(
        (index) => !covered.has(index),
    )
    if (missing.length === 0 || variant.body.type !== 'Scroll') return variant
    return { ...variant, body: scroll([...variant.body.children, section('Manual pages', nest(chips(missing)))]) }
}

/** The complete deterministic proposal for this material: ready variant plus every required state variant. */
export function buildFallbackProposalV2(material: DocumentMaterialV2): ScreenProposalV2 {
    const ready: ScreenVariantV2 = {
        header: headerOf(material, true),
        body: scroll([stack(bodyOf(material))]),
        bar: barOf(material),
        overlays: overlaysOf(material),
    }
    const wanted = new Set(requiredStatesV2(material.inputs.kind, material.requirements))
    const states = Object.fromEntries(
        VARIANT_STATES.map((state) => [
            state,
            !wanted.has(state)
                ? null
                : state === 'confirming'
                  ? confirmingVariant()
                  : withCoverage(stateVariant(state, material, ready), material, state),
        ]),
    ) as ScreenProposalV2['states']
    return { ...withCoverage(ready, material, 'ready'), states }
}

/** The only facts about a failed model call that a fallback document may record: what the call really observed. */
const OBSERVED_KEYS = [
    'model',
    'effort',
    'repaired',
    'rejectedIssues',
    'cacheHit',
    'promptVersion',
    'generatedAt',
    'timing',
    'usage',
] as const satisfies readonly (keyof DocumentFacts)[]

/**
 * What `buildFallbackDocumentV2` is told about a failed model call: observations only. Never an origin, the identity of
 * a recording or carried provenance, so a template cannot be made generated by saying so (only `rebindGeneratedStatesV2`,
 * reading a real generated document, attributes a variant to one).
 */
export type FallbackObservedV2 = Pick<DocumentFacts, (typeof OBSERVED_KEYS)[number]>

/** Keeps the observation fields and nothing else, whatever the caller handed over (types do not stop an untyped one). */
function observationsOf(observed: FallbackObservedV2): FallbackObservedV2 {
    const only: Record<string, unknown> = {}
    for (const key of OBSERVED_KEYS) if (observed[key] !== undefined) only[key] = observed[key]
    return only as FallbackObservedV2
}

/**
 * The complete deterministic document of the same catalog: ready variant and every required state variant, all
 * mandatory witnesses shown. Used by the server whenever a model document is unavailable or rejected, and by the app
 * itself (no network) when generation is off: `reason: 'disabled'`, `evidence: 'local-deterministic'`. It is all
 * fallback whatever `observed` says: only the observation fields of it are read.
 */
export function buildFallbackDocumentV2(
    inputs: ScreenContextInputsV2,
    deps: AssembleDeps & { reason: FallbackReasonV2; evidence: DocumentMetadataV2['evidence'] },
    observed: FallbackObservedV2 = {},
): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    return assembleDocumentV2(
        material,
        buildFallbackProposalV2(material),
        { ...observationsOf(observed), source: 'fallback', evidence: deps.evidence, fallbackReason: deps.reason },
        deps,
    )
}
