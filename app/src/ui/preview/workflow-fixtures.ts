import type { CheckResult, QuestionResult } from '@truebuild/contracts'
import { HERO_DIAGRAM_PNG_BASE64, HERO_DIAGRAM_SVG } from '@truebuild/contracts/hero'
import { decodeBase64, sampleManual } from '../../demo/sample-manual'
import type { WorkflowState } from '../../features/capture/controller'
import type { LibraryEntry } from '../../features/capture/library'

export const WORKFLOW_PREVIEW_BANNER =
    'Synthetic visual preview · local fixtures only · no camera, storage or model requests'

export const WORKFLOW_PREVIEW_CASES = [
    { id: 'home-empty', label: 'Home · empty', group: 'Home' },
    { id: 'home-populated', label: 'Home · saved manuals', group: 'Home' },
    { id: 'home-loading', label: 'Home · loading', group: 'Home' },
    { id: 'home-error', label: 'Home · error', group: 'Home' },
    { id: 'pages-empty', label: 'Pages · empty', group: 'Pages' },
    { id: 'pages-populated', label: 'Pages · added', group: 'Pages' },
    { id: 'pages-reading', label: 'Pages · reading', group: 'Pages' },
    { id: 'review-unresolved', label: 'Review · unresolved', group: 'Review' },
    { id: 'review-ready', label: 'Review · ready', group: 'Review' },
    { id: 'review-reviewed', label: 'Review · confirmed', group: 'Review' },
    { id: 'guide-empty', label: 'Guide · no photo', group: 'Guide' },
    { id: 'guide-photo', label: 'Guide · frozen photo', group: 'Guide' },
    { id: 'guide-pass', label: 'Guide · pass', group: 'Guide' },
    { id: 'guide-refuse', label: 'Guide · refuse', group: 'Guide' },
    { id: 'guide-cannot-verify', label: 'Guide · cannot verify', group: 'Guide' },
    { id: 'guide-answer', label: 'Guide · answer', group: 'Guide' },
    { id: 'guide-pending', label: 'Guide · pending', group: 'Guide' },
    { id: 'guide-error', label: 'Guide · error', group: 'Guide' },
    { id: 'guide-instructions', label: 'Guide · instructions', group: 'Guide' },
] as const

export type WorkflowPreviewCase = (typeof WORKFLOW_PREVIEW_CASES)[number]['id']
export type WorkflowPreviewGroup = (typeof WORKFLOW_PREVIEW_CASES)[number]['group']

// Both illustrations are inline and original synthetic fixture art. Neither represents a real photographed assembly.
const diagramUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(HERO_DIAGRAM_SVG)}`
const photoUri = `data:image/png;base64,${HERO_DIAGRAM_PNG_BASE64}`

export function workflowPreviewFixture(id: WorkflowPreviewCase): { state: WorkflowState; entry: LibraryEntry } {
    const session = sampleManual()
    session.title = 'Grooved shelf · synthetic manual'
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const state: WorkflowState = {
        route: id.startsWith('home')
            ? 'library'
            : id.startsWith('pages')
              ? 'pages'
              : id.startsWith('review')
                ? 'overview'
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
        pageUris: Object.fromEntries(session.pages.map((page) => [page.pageId, diagramUri])),
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

    if (state.route === 'guide' && id !== 'guide-empty') {
        state.capture = {
            binding: {
                kind: 'capture',
                manualId: session.manualId,
                revision: session.revision,
                stepId: session.reviewedSteps[0]!.stepId,
                captureId: 'synthetic-visual-preview',
            },
            observation: {
                uri: photoUri,
                bytes: decodeBase64(HERO_DIAGRAM_PNG_BASE64),
                mimeType: 'image/png',
                width: 600,
                height: 400,
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
    if (id === 'guide-pending') {
        state.pending = 'Checking the frozen photo…'
    }
    if (id === 'guide-error') {
        state.notice = 'Check unavailable. Synthetic error for visual review; no request was sent.'
    }

    return { state, entry }
}
