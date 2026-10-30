import { cameraAccessV2, resultOfKindV2, type CameraAccessV2 } from './document-v2-context'
import {
    nodeTextRefsV2,
    type BusyActivityV2,
    variantsOfV2,
    visitVariantNodesV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type TextRefV2,
    type VariantState,
} from './document-v2'
import { coachTargetsForV2, type DocumentMaterialV2 } from './document-v2-material'

/** Coach content is authored only for usable controls on this kind, never in a running/recovery state. */
export function coachIssuesV2(document: Parameters<typeof variantsOfV2>[0], material: DocumentMaterialV2): string[] {
    const allowed = new Set(coachTargetsForV2(material))
    const issues: string[] = []
    for (const { name, prefix, variant } of variantsOfV2(document)) {
        visitVariantNodesV2(variant, prefix, ({ node, path }) => {
            if (node.type === 'CoachMark' && (name !== 'ready' || !allowed.has(node.targetId)))
                issues.push(`${path}:coach_unavailable`)
        })
    }
    return issues
}

/**
 * The closed interface-copy registry of the version 2 documents. Every literal a document writes (a TextRef literal
 * anywhere, a text field placeholder, a fact editor label) must be listed here for its screen kind and variant; a
 * factual statement is never interface copy, so prose that is not listed is rejected even when it has no digits. The
 * listed wording is nonfactual (headings, hints, process copy of the screen it belongs to) except claim wording, which
 * is listed only when the held result or a witnessed completion earns it. Facts come only from `{kind:'fact'}` refs.
 */

export type CopyVariant = 'ready' | VariantState

/** Failure wording per closed failure class. Interface copy; never a cause, stack or provider text. */
export const FAILURE_COPY_V2: Readonly<Record<string, string>> = {
    unconfigured: 'Smart help is not set up here yet. You can keep going without it.',
    unauthorized: 'This device could not connect. Check the app settings and try again.',
    invalid_input: 'Something about that request did not look right. Try again.',
    timeout: 'That took too long. Try again in a moment.',
    provider_error: 'Smart help is unavailable right now. Try again in a moment.',
    invalid_output: 'We could not use the answer we got. Try again.',
}

/** Coach-mark copy per existing target (interface wording only). */
export const COACH_COPY_V2: Readonly<Record<string, { heading: string; body: string }>> = {
    'home-add': { heading: 'Add a manual', body: 'Start here to add the manual you are building from.' },
    'keep-building': { heading: 'Keep building', body: 'Pick up your current manual from here.' },
    'header-more': { heading: 'More', body: 'Settings and help are here.' },
    'take-page-photo': { heading: 'Take a page photo', body: 'Photograph one manual page at a time.' },
    'choose-pages': { heading: 'Choose photos', body: 'Pick page photos you already have.' },
    'read-manual': { heading: 'Read the manual', body: 'When every page is added, read the manual.' },
    'add-page': { heading: 'Add a page', body: 'Add another page if one is missing.' },
    'quick-check-fix': { heading: 'Fix a detail', body: 'Change anything that was read wrongly.' },
    'quick-check-skip': { heading: 'Skip', body: 'Skip a detail you do not need to check.' },
    'quick-check-clearer': { heading: 'Clearer photo', body: 'A clearer page photo can improve the reading.' },
    'quick-check-start': { heading: 'Start building', body: 'Start when the details look right.' },
    'guide-hero': { heading: 'The diagram', body: 'Compare the diagram with what you are building.' },
    'guide-primary': { heading: 'Check your work', body: 'Take a photo of your work to check this step.' },
    'guide-hero-frame': { heading: 'Frame the photo', body: 'Keep the whole step in view.' },
    'camera-shutter': { heading: 'Take the photo', body: 'Tap to take the photo.' },
}

export const STATE_COPY_V2: Readonly<Record<VariantState, { heading: string; detail: string }>> = {
    // The generic wait says one calm thing, busy or pending; what the app is actually doing is `BUSY_COPY_V2`.
    busy: { heading: 'Working on it', detail: 'One moment, please.' },
    pending: { heading: 'Working on it', detail: 'One moment, please.' },
    empty: { heading: 'Nothing here yet', detail: 'Add something to get started.' },
    error: { heading: 'Something went wrong', detail: 'Try again in a moment.' },
    recovery: { heading: 'Let us get you back on track', detail: 'Try again, or go back home.' },
    confirming: { heading: 'Stop reading?', detail: 'Reading will stop and you will go back to your pages.' },
}

/** The busy variant's authored words per activity (what the app is doing), never a native text override. */
export const BUSY_COPY_V2: Readonly<Record<BusyActivityV2, { heading: string; detail: string }>> = {
    working: { heading: 'Working on it', detail: 'One moment, please.' },
    reading: { heading: 'Reading your manual. This can take a minute.', detail: 'Reading each page.' },
    checking: { heading: 'Checking your photo…', detail: 'This only takes a moment.' },
    'second-opinion': { heading: 'Taking a closer look…', detail: 'A closer look can take a little longer.' },
    asking: { heading: 'Asking…', detail: 'This only takes a moment.' },
    'question-waiting': { heading: 'Still thinking…', detail: 'Thanks for waiting.' },
    saving: { heading: 'Saving…', detail: 'This only takes a moment.' },
}

/**
 * What a camera screen says when the raw camera cannot be shown (listed only with the witness that earns it): the
 * permission can still be asked (`allow`), only the device settings can grant it (`settings`), or the camera failed
 * (`retry`). Process wording of the screen; the privacy sentence itself is app-owned bound text (`privacy-camera`).
 */
export const CAMERA_ACCESS_COPY_V2: Readonly<
    Record<Exclude<CameraAccessV2, 'ready'>, { heading: string; detail: string }>
> = {
    allow: { heading: 'Camera access needed', detail: 'Allow the camera to take a photo.' },
    settings: { heading: 'Camera access is off', detail: 'Open settings to turn the camera on.' },
    retry: { heading: 'The camera did not start', detail: 'Try the camera again.' },
}

/** Said by a quick check whose question step has no usable source picture (listed only then): nothing is invented. */
export const NO_FIGURE_COPY_V2 = 'No picture to show for this detail.'
/** Said by the overview of a quick check when no step cites a page the manual has (listed only then). */
export const NO_OVERVIEW_FIGURE_COPY_V2 = 'No picture to show for this manual.'
/** Said by a step-scoped More whose step has no usable source picture (listed only then). */
export const NO_STEP_FIGURE_COPY_V2 = 'No picture to show for this step.'

/** The two actions of the reading cancellation confirmation (listed only in the `confirming` variant). */
export const CONFIRM_LABELS_V2 = { keep: 'Keep reading', stop: 'Stop reading' } as const
export const EMPTY_COPY_V2: Readonly<Partial<Record<ScreenKindV2, { heading: string; detail: string }>>> = {
    home: { heading: 'No manuals yet', detail: 'Add a manual to start building.' },
    add: { heading: 'No pages yet', detail: 'Take a photo of the first page.' },
    pages: { heading: 'No pages yet', detail: 'Add a page to begin.' },
    questions: { heading: 'No photo yet', detail: 'Take a photo of your work first.' },
    compare: { heading: 'Nothing to compare yet', detail: 'Add two manuals to compare them.' },
}

/** Section and group titles and short hints any screen may use. Labels, never statements about this manual or build. */
const COMMON: readonly string[] = [
    'Safety',
    'Directions',
    'More detail',
    'Details',
    'Manual pages',
    'Safety and directions',
    'Parts',
    'Photo',
]

/** Wording of the screen itself, by kind (headings, hints and process copy that is true of the screen, not of the build). */
const KIND_COPY: Readonly<Record<ScreenKindV2, readonly string[]>> = {
    home: ['Your manuals'],
    add: ['Add a manual', 'Photograph each page of your manual, one at a time.'],
    pages: ['Your pages', 'Add a page to begin.'],
    reading: ['Reading your manual', 'Reading each page. This can take a minute.'],
    'quick-check': ['Quick check', 'Check what we read before you start building.', 'Steps'],
    guide: ['This step'],
    camera: ['Photograph a page', 'Take a photo'],
    result: [],
    questions: [
        'Ask about this step',
        'Ask anything about this step.',
        'Your question',
        'Which part is your question about?',
    ],
    answer: ['Answer'],
    more: [
        'More',
        'Settings and help.',
        'About this step',
        'Your question',
        'Privacy',
        'Settings',
        'How it works',
        'Your builds on this phone',
        'What leaves this phone',
        'Camera and photos',
        'Reading language',
    ],
    completion: ['Your build'],
    error: ['Something went wrong'],
    recovery: ['Fix this step', 'Compare with the diagram, then try again.'],
    judge: ['About this check', 'See how this check was made.', 'Show how Meta AI built this'],
    compare: ['Compare manuals', 'See two manuals side by side.'],
}

/** Fact-editor strings are interface labels too (they are not TextRefs). */
export const FACT_EDITOR_COPY_V2 = {
    label: ['Orientation', 'Which way it faces', 'What to look for', 'Visible check'],
    save: ['Save'],
    cancel: ['Cancel', 'Not now'],
} as const

const normalizeCopy = (value: string): string =>
    value
        .normalize('NFC')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/[.!…]+$/u, '')

/** Wording that makes a claim about the person's work: listed only where the held result or witnessed completion earns it. */
export function claimWordingV2(material: DocumentMaterialV2): string[] {
    const { kind } = material.inputs
    if (kind === 'result') {
        return [
            material.decision === 'pass'
                ? 'Looks right'
                : material.decision === 'refuse'
                  ? 'Not quite right'
                  : 'Cannot tell yet',
        ]
    }
    if (kind === 'completion') return material.completion === 'witnessed' ? ['All steps done'] : []
    return []
}

/** Interface copy that depends on what this exact screen holds (never on the model). */
function contextCopy(material: DocumentMaterialV2, variant: CopyVariant): string[] {
    const { inputs } = material
    // Claim wording makes a claim about the held result: only the revealed (ready) screen may say it.
    const copy: string[] = variant === 'ready' ? [...claimWordingV2(material)] : []
    if (inputs.kind === 'home') {
        copy.push(
            (inputs.uiState?.library?.entries.length ?? 0) > 0
                ? 'Pick up where you left off.'
                : 'Add a manual to start building.',
        )
    }
    if (inputs.kind === 'error') {
        copy.push(FAILURE_COPY_V2[inputs.failure ?? 'provider_error'] ?? FAILURE_COPY_V2.provider_error ?? '')
    }
    if (inputs.kind === 'camera') {
        const access = cameraAccessV2(inputs.uiState?.camera)
        if (access !== 'ready') copy.push(CAMERA_ACCESS_COPY_V2[access].heading, CAMERA_ACCESS_COPY_V2[access].detail)
    }
    if (
        inputs.kind === 'quick-check' &&
        variant === 'ready' &&
        inputs.uiState?.review?.currentQuestion &&
        material.requirements.figure === null
    ) {
        copy.push(NO_FIGURE_COPY_V2)
    }
    if (
        inputs.kind === 'quick-check' &&
        variant === 'ready' &&
        material.overview &&
        material.requirements.figure === null
    ) {
        copy.push(NO_OVERVIEW_FIGURE_COPY_V2)
    }
    // Listed in every variant: a waiting or failing More repeats the same figures block, so it says the same thing.
    if (inputs.kind === 'more' && material.step !== null && material.requirements.figure === null) {
        copy.push(NO_STEP_FIGURE_COPY_V2)
    }
    return copy
}

/** The literals this kind of screen may write in this variant, for this exact context. */
export function allowedLiteralsV2(material: DocumentMaterialV2, variant: CopyVariant): string[] {
    const { kind, failure } = material.inputs
    const list = [...COMMON, ...KIND_COPY[kind], ...contextCopy(material, variant)]
    if (variant !== 'ready') {
        list.push(STATE_COPY_V2[variant].heading, STATE_COPY_V2[variant].detail)
        const busy = material.inputs.uiState?.busy?.activity
        if (variant === 'busy' && busy !== undefined) list.push(BUSY_COPY_V2[busy].heading, BUSY_COPY_V2[busy].detail)
        if (variant === 'empty') {
            const empty = EMPTY_COPY_V2[kind]
            if (empty) list.push(empty.heading, empty.detail)
        }
        if (variant === 'error' || variant === 'recovery') {
            list.push(FAILURE_COPY_V2[failure ?? 'provider_error'] ?? FAILURE_COPY_V2.provider_error ?? '')
        }
    }
    return [...new Set(list.filter((entry) => entry !== ''))]
}

export const UI_COPY_V2 = { common: COMMON, kind: KIND_COPY, state: STATE_COPY_V2, empty: EMPTY_COPY_V2 } as const

type DocumentLike = Parameters<typeof variantsOfV2>[0]

function literalsOf(node: ScreenNodeV2): string[] {
    const refs = nodeTextRefsV2(node).flatMap((ref: TextRefV2) => (ref.kind === 'literal' ? [ref.text] : []))
    return node.type === 'TextField' && node.placeholder !== null ? [...refs, node.placeholder] : refs
}
const inList = (list: readonly string[], text: string): boolean =>
    list.some((entry) => normalizeCopy(entry) === normalizeCopy(text))
const factEditorListed = (node: ScreenNodeV2): boolean =>
    node.type !== 'FactEditor' ||
    (inList(FACT_EDITOR_COPY_V2.label, node.label) &&
        inList(FACT_EDITOR_COPY_V2.save, node.saveLabel) &&
        inList(FACT_EDITOR_COPY_V2.cancel, node.cancelLabel))

/**
 * The persistent header of a busy variant states the activity the app is actually doing, in the activity's own listed
 * heading (`Still thinking…`, `Taking a closer look…`): a native sheet keeps its scroll offset while busy, so the body's
 * heading can be off screen and a header that kept the ready title would misstate the screen. Applies only where the
 * context names the activity (`ui.busy`); machine code `<prefix>header:busy_header_mismatch`.
 */
export function busyHeaderIssuesV2(document: DocumentLike, material: DocumentMaterialV2): string[] {
    const activity = material.inputs.uiState?.busy?.activity
    if (activity === undefined) return []
    const issues: string[] = []
    for (const { name, prefix, variant } of variantsOfV2(document)) {
        const { title } = variant.header
        if (name === 'busy' && !(title.kind === 'literal' && inList([BUSY_COPY_V2[activity].heading], title.text))) {
            issues.push(`${prefix}header:busy_header_mismatch`)
        }
    }
    return issues
}

/**
 * `<path>:literal_not_listed` for every literal that is not interface copy of this screen, in the header, subtitle, body,
 * bar, overlays and every state variant. Pure and portable: the server gate and a request-bound client run the same rule.
 */
export function literalIssuesV2(document: DocumentLike, material: DocumentMaterialV2): string[] {
    const issues = new Set<string>(busyHeaderIssuesV2(document, material))
    for (const { name, prefix, variant } of variantsOfV2(document)) {
        const allowed = allowedLiteralsV2(material, name)
        for (const ref of [variant.header.title, variant.header.subtitle]) {
            if (ref?.kind === 'literal' && !inList(allowed, ref.text)) issues.add(`${prefix}header:literal_not_listed`)
        }
        visitVariantNodesV2(variant, prefix, ({ node, path }) => {
            if (literalsOf(node).some((text) => !inList(allowed, text)) || !factEditorListed(node)) {
                issues.add(`${path}:literal_not_listed`)
            }
        })
    }
    return [...issues]
}

/**
 * The raw camera belongs only where the permission is granted and the camera runs (never in a document composed for a
 * denied, undetermined, absent or failed camera, whatever its variant), and a failed camera's error and recovery
 * variants lead with the camera retry. Machine codes per path.
 */
export function cameraIssuesV2(document: DocumentLike, material: DocumentMaterialV2): string[] {
    const { inputs } = material
    const access = inputs.kind === 'camera' ? cameraAccessV2(inputs.uiState?.camera) : null
    const issues = new Set<string>()
    for (const { name, prefix, variant } of variantsOfV2(document)) {
        visitVariantNodesV2(variant, prefix, ({ node, path }) => {
            if (node.type === 'CameraView' && access !== 'ready') issues.add(`${path}:camera_unavailable`)
        })
        const lead = variant.bar.primary.intent
        if (
            access === 'retry' &&
            (name === 'error' || name === 'recovery') &&
            !(lead.intent === 'retry' && lead.target === 'camera')
        ) {
            issues.add(`${prefix}bar.primary:camera_retry_missing`)
        }
    }
    return [...issues]
}

type BindingNode = Extract<ScreenNodeV2, { type: 'Progress' | 'Meter' | 'Stepper' | 'Toggle' | 'VerdictCard' }>

/**
 * Whether the app has the state a live-bound node reads. A binding the screen cannot resolve is refused, never shown
 * as an empty or invented figure: review progress needs the quick check's current question, step progress a step,
 * reading progress a reading (or a busy reading), pages the page list, and a build figure a manual (or a waiting
 * screen's indeterminate bar).
 */
function bindingAvailable(node: BindingNode, material: DocumentMaterialV2, waiting: boolean): boolean {
    const { inputs } = material
    const ui = inputs.uiState
    const hasBuild = inputs.session !== null
    const hasPages = ui?.pages !== undefined && ui.pages !== null
    switch (node.type) {
        case 'Progress':
            switch (node.binding) {
                case 'step':
                    return material.step !== null
                case 'build':
                    return hasBuild || waiting
                case 'reading':
                    return inputs.kind === 'reading' || ui?.busy?.activity === 'reading'
                case 'pages':
                    return hasPages
                case 'review':
                    return inputs.kind === 'quick-check' && Boolean(ui?.review?.currentQuestion)
            }
            return false
        case 'Meter':
            return node.binding === 'pages-read' ? hasPages : node.binding === 'build' ? hasBuild : material.reviewed
        case 'Stepper':
            return node.binding === 'pages' ? hasPages : hasBuild
        case 'VerdictCard':
            return resultOfKindV2(inputs, node.result) !== null
        case 'Toggle':
            // The only persistent flag is the judge's built-view; tips are a replay action, not a toggle.
            return inputs.kind === 'judge'
    }
}

/** `<path>:binding_unavailable` for every Progress, Meter, Stepper or Toggle whose state this screen does not have. */
export function bindingIssuesV2(document: DocumentLike, material: DocumentMaterialV2): string[] {
    const issues = new Set<string>()
    for (const { name, prefix, variant } of variantsOfV2(document)) {
        const waiting = name === 'busy' || name === 'pending'
        visitVariantNodesV2(variant, prefix, ({ node, path }) => {
            if (
                (node.type === 'Progress' ||
                    node.type === 'Meter' ||
                    node.type === 'Stepper' ||
                    node.type === 'Toggle' ||
                    node.type === 'VerdictCard') &&
                !bindingAvailable(node, material, waiting)
            ) {
                issues.add(`${path}:binding_unavailable`)
            }
        })
    }
    return [...issues]
}

/** Whether a checklist item may be `done`: only a witnessed completion or a held pass, never a model flag. */
function earnedDone(label: TextRefV2, material: DocumentMaterialV2): boolean {
    const { kind } = material.inputs
    if (kind === 'completion') {
        return material.completion === 'witnessed' && label.kind === 'bound' && label.key === 'completion-summary'
    }
    if (kind === 'result') {
        return material.decision === 'pass' && label.kind === 'fact' && label.factId === 'result:verdict'
    }
    return false
}
const earnedSuccess = (material: DocumentMaterialV2): boolean => {
    const { kind } = material.inputs
    return (
        ((kind === 'result' || kind === 'more') && material.decision === 'pass') ||
        (kind === 'completion' && material.completion === 'witnessed')
    )
}

/** The tone a node carries, when it has one. */
function toneOf(node: ScreenNodeV2): string | null {
    switch (node.type) {
        case 'Text':
        case 'Icon':
        case 'Badge':
        case 'Meter':
        case 'Card':
            return node.tone
        default:
            return null
    }
}

/** Progress and success the document may only show when something earned it: done checklist items, a success check mark. */
export function earnedStateIssuesV2(document: DocumentLike, material: DocumentMaterialV2): string[] {
    const issues = new Set<string>()
    for (const { name, prefix, variant } of variantsOfV2(document)) {
        visitVariantNodesV2(variant, prefix, ({ node, path }) => {
            if (
                node.type === 'Checklist' &&
                node.items.some(
                    (item) => item.state === 'done' && (name !== 'ready' || !earnedDone(item.label, material)),
                )
            ) {
                issues.add(`${path}:checklist_done_unearned`)
            }
            if (
                node.type === 'Icon' &&
                node.name === 'check' &&
                node.tone === 'success' &&
                (name !== 'ready' || !earnedSuccess(material))
            ) {
                issues.add(`${path}:icon_unearned`)
            }
            // A photo-first screen (a held result with its photo) never looks successful before its verdict is revealed
            // and earned: a success tone is legal only in `ready`, and only for a held pass.
            if (
                material.requirements.capture &&
                toneOf(node) === 'success' &&
                (name !== 'ready' || !earnedSuccess(material))
            ) {
                issues.add(`${path}:tone_unearned`)
            }
            // A live photo is only part of a screen whose context key names it (a held result, a question's capture).
            if (node.type === 'Image' && node.source.kind === 'capture' && material.inputs.captureId === null) {
                issues.add(`${path}:capture_unwitnessed`)
            }
        })
    }
    return [...issues]
}
