import type { CheckResult, Layout, QuestionResult } from '@truebuild/contracts'
import { HERO_DIAGRAM_PNG_BASE64, HERO_DIAGRAM_SVG } from '@truebuild/contracts/hero'
import { decodeBase64, sampleManual } from '../../demo/sample-manual'
import type { WorkflowState } from '../../features/capture/controller'
import type { LibraryEntry } from '../../features/capture/library'
import type { CameraPresentation } from '../../features/capture/camera-stage'
import { PORTRAIT_DIAGRAM_SVG } from './synthetic-portrait-art'
import { PORTRAIT_PHOTO_PNG_BASE64 } from './synthetic-portrait-photo-png'
import { STOOL_DIAGRAM_SVG } from './synthetic-stool-art'
import { STOOL_PHOTO_PNG_BASE64 } from './synthetic-stool-photo-png'
import { syntheticPortraitManual, syntheticStoolManual } from './synthetic-stool-manual'

export const WORKFLOW_PREVIEW_BANNER =
    'Synthetic visual preview · local fixtures only · no camera, storage or model requests'

export const WORKFLOW_PREVIEW_CASES = [
    { id: 'home-empty', label: 'Home · empty', group: 'Home' },
    { id: 'home-populated', label: 'Home · saved manuals', group: 'Home' },
    { id: 'home-loading', label: 'Home · loading', group: 'Home' },
    { id: 'home-error', label: 'Home · error', group: 'Home' },
    { id: 'home-unavailable', label: 'Home · build unavailable', group: 'Home' },
    { id: 'settings', label: 'Settings · privacy and permissions', group: 'Settings' },
    { id: 'pages-empty', label: 'Pages · empty', group: 'Pages' },
    { id: 'pages-populated', label: 'Pages · added', group: 'Pages' },
    { id: 'pages-reading', label: 'Pages · reading', group: 'Pages' },
    { id: 'review-unresolved', label: 'Review · unresolved', group: 'Review' },
    { id: 'review-ready', label: 'Review · ready', group: 'Review' },
    { id: 'review-reviewed', label: 'Review · confirmed', group: 'Review' },
    { id: 'guide-empty', label: 'Guide · no photo', group: 'Guide' },
    { id: 'done-finished', label: 'Done · finished', group: 'Done' },
    { id: 'guide-photo', label: 'Guide · frozen photo', group: 'Guide' },
    { id: 'guide-pass', label: 'Guide · pass', group: 'Guide' },
    { id: 'guide-refuse', label: 'Guide · refuse', group: 'Guide' },
    { id: 'guide-cannot-verify', label: 'Guide · cannot verify', group: 'Guide' },
    { id: 'guide-answer', label: 'Guide · answer', group: 'Guide' },
    { id: 'guide-pending', label: 'Guide · pending', group: 'Guide' },
    { id: 'guide-error', label: 'Guide · error', group: 'Guide' },
    { id: 'guide-instructions', label: 'Guide · instructions', group: 'Guide' },
    { id: 'guide-pass-guided', label: 'Guide · pass, next part and target', group: 'Guide' },
    { id: 'guide-pass-next-only', label: 'Guide · pass, next part only', group: 'Guide' },
    { id: 'guide-refuse-guided', label: 'Guide · refuse, next part and target', group: 'Guide' },
    { id: 'guide-answer-guided', label: 'Guide · answer, next part and target', group: 'Guide' },
    { id: 'guide-pass-layout', label: 'Guide · pass, model layout', group: 'Guide' },
    { id: 'guide-stool-guided', label: 'Guide · second manual, paired', group: 'Guide' },
    { id: 'guide-stool-mismatched', label: 'Guide · second manual, unpaired', group: 'Guide' },
    { id: 'guide-portrait-guided', label: 'Guide · portrait photo and page, paired', group: 'Guide' },
    { id: 'camera-loading', label: 'Camera · checking access', group: 'Camera' },
    { id: 'camera-permission', label: 'Camera · permission', group: 'Camera' },
    { id: 'camera-denied', label: 'Camera · denied', group: 'Camera' },
    { id: 'camera-permission-error', label: 'Camera · permission error', group: 'Camera' },
    { id: 'camera-error', label: 'Camera · unavailable', group: 'Camera' },
    { id: 'camera-page', label: 'Camera · scan manual', group: 'Camera' },
    { id: 'camera-check', label: 'Camera · check step', group: 'Camera' },
    { id: 'camera-question', label: 'Camera · ask about step', group: 'Camera' },
    { id: 'camera-preparing', label: 'Camera · preparing photo', group: 'Camera' },
] as const

/**
 * How every gallery case is classified in an evidence manifest. Each one renders real screens over canned state with an
 * inert controller: it proves how a screen looks and lays out on a device, and nothing about the controller, storage,
 * camera, network or navigation. Those are proven separately, by the production route and controller tests.
 */
export const WORKFLOW_PREVIEW_CLASSIFICATION = 'inert synthetic native fixture, not controller/IO/navigation proof'

export type WorkflowPreviewManifestEntry = {
    readonly id: string
    readonly group: string
    readonly label: string
    readonly classification: typeof WORKFLOW_PREVIEW_CLASSIFICATION
    readonly production: false
}

/** One manifest record per gallery case, each explicitly classified as a synthetic fixture and never as production. */
export function workflowPreviewManifest(): readonly WorkflowPreviewManifestEntry[] {
    return WORKFLOW_PREVIEW_CASES.map(({ id, group, label }) => ({
        id,
        group,
        label,
        classification: WORKFLOW_PREVIEW_CLASSIFICATION,
        production: false,
    }))
}

export type WorkflowPreviewCase = (typeof WORKFLOW_PREVIEW_CASES)[number]['id']
export type WorkflowPreviewGroup = (typeof WORKFLOW_PREVIEW_CASES)[number]['group']

// Both illustrations are inline and original synthetic fixture art. Neither represents a real photographed assembly.
const diagramUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(HERO_DIAGRAM_SVG)}`
const photoUri = `data:image/png;base64,${HERO_DIAGRAM_PNG_BASE64}`
// The second manual brings its own mocked page diagram and photo, so its overlays sit on art that matches its parts.
const stoolDiagramUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STOOL_DIAGRAM_SVG)}`
const stoolPhotoUri = `data:image/png;base64,${STOOL_PHOTO_PNG_BASE64}`
// The portrait case has its own mocked page (400 x 600) and photo (a real 400 x 600 PNG), never the landscape bytes.
const portraitDiagramUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PORTRAIT_DIAGRAM_SVG)}`
const portraitPhotoUri = `data:image/png;base64,${PORTRAIT_PHOTO_PNG_BASE64}`

// Synthetic regions on the preview photo. Mocked geometry for visual review only: no model located anything here.
const OBSERVED_REGION = { x: 0.3, y: 0.2, width: 0.2, height: 0.6 }
const DIVIDER_NEXT_REGION = { x: 0.52, y: 0.58, width: 0.38, height: 0.16 }
const DIVIDER_TARGET_REGION = { x: 0.26, y: 0.2, width: 0.2, height: 0.62 }
const STOOL_NEXT_REGION = { x: 0.08, y: 0.5, width: 0.22, height: 0.36 }
const STOOL_TARGET_REGION = { x: 0.58, y: 0.3, width: 0.3, height: 0.3 }
// Portrait photo: the folding leg lies lower left, the seat-plate slot sits upper right. Mocked geometry.
const PORTRAIT_NEXT_REGION = { x: 0.08, y: 0.56, width: 0.28, height: 0.34 }
const PORTRAIT_TARGET_REGION = { x: 0.46, y: 0.19, width: 0.44, height: 0.29 }
const MODEL_LAYOUT: Layout = {
    source: 'model',
    components: [
        { type: 'orientation', partId: 'side-panel' },
        { type: 'visible_checks', checkIds: ['groove-inward'] },
        { type: 'source_diagram', sourceRefIndexes: [0] },
    ],
}

const STOOL_CASES: readonly WorkflowPreviewCase[] = ['guide-stool-guided', 'guide-stool-mismatched']
// The portrait case reuses the stool parts and step on a portrait page and photo.
const PORTRAIT_CASES: readonly WorkflowPreviewCase[] = ['guide-portrait-guided']
// Hero-manual cases that guide the second step, whose divider is the part that moves into the panel's groove.
const DIVIDER_CASES: readonly WorkflowPreviewCase[] = [
    'guide-pass-guided',
    'guide-pass-next-only',
    'guide-refuse-guided',
    'guide-answer-guided',
]

export function workflowPreviewFixture(id: WorkflowPreviewCase): { state: WorkflowState; entry: LibraryEntry } {
    const portrait = PORTRAIT_CASES.includes(id)
    const stool = STOOL_CASES.includes(id) || portrait
    const session = portrait ? syntheticPortraitManual() : stool ? syntheticStoolManual() : sampleManual()
    if (!stool) {
        session.title = 'Grooved shelf · synthetic manual'
    }
    const stepIndex = DIVIDER_CASES.includes(id) ? 1 : 0
    const entry: LibraryEntry = { session, stepIndex, completedStepIds: [], capture: null }
    const state: WorkflowState = {
        route:
            id.startsWith('home') || id === 'settings'
                ? 'library'
                : id.startsWith('pages')
                  ? 'pages'
                  : id.startsWith('review')
                    ? 'overview'
                    : id.startsWith('camera')
                      ? 'camera'
                      : 'guide',
        entries: [entry],
        selectedId: session.manualId,
        pending: null,
        notice: null,
        loading: false,
        storageReadOnly: false,
        cameraIntent: null,
        capture: null,
        check: null,
        answer: null,
        question: '',
        target: null,
        pageUris: Object.fromEntries(
            session.pages.map((page) => [
                page.pageId,
                portrait ? portraitDiagramUri : stool ? stoolDiagramUri : diagramUri,
            ]),
        ),
    }

    if (id === 'home-empty' || id === 'home-loading' || id === 'home-error') {
        state.entries = []
        state.selectedId = null
        state.loading = id === 'home-loading'
        state.storageReadOnly = id === 'home-error'
        state.notice = id === 'home-error' ? 'Local library unavailable. Synthetic error for visual review.' : null
    }

    if (id === 'pages-empty') {
        session.pages = []
        session.parts = []
        session.reviewedSteps = []
        session.rawExtraction = null
        session.reviewStatus = 'unreviewed'
        delete session.extractionSourcePageIds
        state.pageUris = {}
    }
    if (id === 'pages-reading') {
        state.pending = 'Reading manual pages…'
    }
    if (id === 'review-ready' || id === 'review-unresolved') {
        session.reviewStatus = 'unreviewed'
        for (const step of session.reviewedSteps) {
            if (step.correction !== null) {
                step.correction.reviewed = false
            }
        }
    }
    if (id === 'review-unresolved') {
        const step = session.reviewedSteps[0]
        if (step !== undefined) {
            step.orientation = { state: 'unknown', reason: 'The inward groove is obscured in this synthetic page.' }
        }
    }

    if (id === 'done-finished') {
        entry.completedStepIds = session.reviewedSteps.map((step) => step.stepId)
    }
    if (state.route === 'guide' && id !== 'guide-empty' && id !== 'done-finished') {
        state.capture = {
            binding: {
                kind: 'capture',
                manualId: session.manualId,
                revision: session.revision,
                stepId: session.reviewedSteps[stepIndex]!.stepId,
                captureId: 'synthetic-visual-preview',
            },
            observation: {
                uri: portrait ? portraitPhotoUri : stool ? stoolPhotoUri : photoUri,
                bytes: decodeBase64(
                    portrait ? PORTRAIT_PHOTO_PNG_BASE64 : stool ? STOOL_PHOTO_PNG_BASE64 : HERO_DIAGRAM_PNG_BASE64,
                ),
                mimeType: 'image/png',
                // The bytes' own size: portrait for the portrait case, landscape for every other case.
                width: portrait ? 400 : 600,
                height: portrait ? 600 : 400,
            },
            capturedAt: 0,
            reusable: false,
        }
    }

    const sourceRefs = [{ pageId: session.pages[0]?.pageId ?? 'demo-page-1', region: null }]
    const baseCheck: CheckResult = {
        decision: 'pass',
        reason: 'Synthetic result: the groove faces inward as shown in the manual.',
        sourceRefs,
        observedRegion: null,
        missingEvidence: [],
    }
    if (id === 'guide-pass') {
        state.check = baseCheck
    }
    if (id === 'guide-pass-guided') {
        state.check = {
            ...baseCheck,
            reason: 'Synthetic result: the divider is lined up with the groove. Slide it in along the arrow.',
            nextPartRegion: { partId: 'divider', region: DIVIDER_NEXT_REGION },
            targetRegion: { partId: 'divider', region: DIVIDER_TARGET_REGION },
        }
    }
    if (id === 'guide-pass-next-only') {
        state.check = {
            ...baseCheck,
            reason: 'Synthetic result: the divider is the next part. No destination was located in this photo.',
            nextPartRegion: { partId: 'divider', region: DIVIDER_NEXT_REGION },
        }
    }
    if (id === 'guide-refuse-guided') {
        state.check = {
            ...baseCheck,
            decision: 'refuse',
            reason: 'Synthetic refusal: turn the panel so the groove faces inward, then slide the divider in.',
            observedRegion: OBSERVED_REGION,
            nextPartRegion: { partId: 'divider', region: DIVIDER_NEXT_REGION },
            targetRegion: { partId: 'divider', region: DIVIDER_TARGET_REGION },
        }
    }
    if (id === 'guide-pass-layout') {
        state.check = { ...baseCheck, layout: MODEL_LAYOUT }
    }
    if (id === 'guide-stool-guided' || id === 'guide-stool-mismatched') {
        state.check = {
            ...baseCheck,
            reason: 'Synthetic result: the folding leg is the next part for the seat plate.',
            sourceRefs: [{ pageId: 'stool-page-1', region: null }],
            nextPartRegion: { partId: 'folding-leg', region: STOOL_NEXT_REGION },
            targetRegion: {
                partId: id === 'guide-stool-guided' ? 'folding-leg' : 'seat-plate',
                region: STOOL_TARGET_REGION,
            },
        }
    }
    if (portrait) {
        state.check = {
            ...baseCheck,
            reason: 'Synthetic result: the folding leg is the next part for the seat plate, in a portrait photo.',
            sourceRefs: [{ pageId: 'stool-page-1', region: null }],
            nextPartRegion: { partId: 'folding-leg', region: PORTRAIT_NEXT_REGION },
            targetRegion: { partId: 'folding-leg', region: PORTRAIT_TARGET_REGION },
        }
    }
    if (id === 'guide-refuse') {
        state.check = {
            ...baseCheck,
            decision: 'refuse',
            reason: 'Synthetic refusal: turn the panel so the groove faces inward before continuing.',
            observedRegion: { x: 0.3, y: 0.2, width: 0.2, height: 0.6 },
        }
    }
    if (id === 'guide-cannot-verify') {
        state.check = {
            ...baseCheck,
            decision: 'cannot_verify',
            reason: 'Synthetic uncertainty: the groove direction is not visible from this angle.',
            missingEvidence: ['A clear view of the inward face and groove.'],
        }
    }
    if (id === 'guide-answer') {
        const answer: QuestionResult = {
            answer: 'Synthetic answer: the groove should face inward toward the divider, as shown on page 1.',
            sourceRefs,
            missingEvidence: [],
        }
        state.answer = answer
        state.question = 'Which way should this groove face?'
        state.target = { kind: 'part', partId: 'side-panel' }
    }
    if (id === 'guide-answer-guided') {
        state.answer = {
            answer: 'Synthetic answer: the divider goes into the marked groove, edge first.',
            sourceRefs,
            missingEvidence: [],
            nextPartRegion: { partId: 'divider', region: DIVIDER_NEXT_REGION },
            targetRegion: { partId: 'divider', region: DIVIDER_TARGET_REGION },
        }
        state.question = 'Where does the divider go?'
        state.target = { kind: 'part', partId: 'divider' }
    }
    if (id === 'guide-pending') {
        state.pending = 'Checking the frozen photo…'
    }
    if (id === 'guide-error') {
        state.notice = 'Check unavailable. Synthetic error for visual review; no request was sent.'
    }

    return { state, entry }
}

/** Hardware-free camera branch data. Preview media and shutter are provided by the gallery, never a CameraView. */
export function cameraPreviewPresentation(
    id: WorkflowPreviewCase,
): Exclude<CameraPresentation, { status: 'preview' }> | null {
    if (id === 'camera-loading') return { status: 'checking-access' }
    if (id === 'camera-error') return { status: 'error' }
    if (id === 'camera-permission' || id === 'camera-denied' || id === 'camera-permission-error') {
        return {
            status: 'permission',
            canAskAgain: id === 'camera-permission',
            error: id === 'camera-permission-error',
        }
    }
    return null
}
