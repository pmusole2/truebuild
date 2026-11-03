import {
    APP_INTENTS,
    INTENT_TARGETS,
    SCREEN_KINDS,
    createDemoManual,
    type AppIntent,
    type CheckResult,
} from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import type { ScreenNav } from '../capture/screen-nav'
import type { WorkflowController } from '../capture/workflow-types'
import { resolveIntent, type IntentExtras, type IntentHost } from './intents'

const reviewed = createDemoManual()
const entryOf = (overrides: Partial<LibraryEntry> = {}): LibraryEntry => ({
    session: reviewed,
    stepIndex: 0,
    completedStepIds: [],
    capture: null,
    ...overrides,
})
const baseState: WorkflowState = {
    route: 'guide',
    entries: [],
    selectedId: reviewed.manualId,
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
    pageUris: {},
}

function spies(): { controller: WorkflowController; nav: ScreenNav; extras: Required<IntentExtras> } {
    const controller = {
        acceptStepFacts: vi.fn(),
        ask: vi.fn(),
        camera: vi.fn(),
        canCompose: true,
        cancel: vi.fn(),
        completeStep: vi.fn(),
        confirm: vi.fn(),
        coverageNotice: vi.fn(() => null),
        createManual: vi.fn(),
        editPage: vi.fn(),
        home: vi.fn(),
        navigate: vi.fn(),
        open: vi.fn(),
        parse: vi.fn(),
        questionChanged: vi.fn(),
        rename: vi.fn(),
        setReadingLanguage: vi.fn(),
        restore: vi.fn(),
        step: vi.fn(),
        targetChanged: vi.fn(),
    } as unknown as WorkflowController
    const nav: ScreenNav = {
        openStop: vi.fn(),
        startBuilding: vi.fn(async () => undefined),
        finish: vi.fn(async () => undefined),
        allBuilds: vi.fn(),
        editPages: vi.fn(),
        leave: vi.fn(),
        back: vi.fn(),
    }
    const extras = {
        choosePages: vi.fn(),
        showMore: vi.fn(),
        showTips: vi.fn(),
        refresh: vi.fn(),
        language: 'en',
        contextualMore: false,
    }
    return { controller, nav, extras }
}

function host(
    overrides: Partial<IntentHost> = {},
    state: Partial<WorkflowState> = {},
): ReturnType<typeof spies> & { host: IntentHost } {
    const fakes = spies()
    return {
        ...fakes,
        host: {
            kind: 'guide',
            state: { ...baseState, entries: [entryOf()], ...state },
            entry: entryOf(),
            controller: fakes.controller,
            nav: fakes.nav,
            extras: fakes.extras,
            ...overrides,
        },
    }
}

const passCheck: CheckResult = {
    decision: 'pass',
    reason: 'ok',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: [],
}
const everyIntent: AppIntent[] = APP_INTENTS.flatMap((intent) =>
    INTENT_TARGETS[intent].map((target) => ({ intent, target }) as AppIntent),
)

describe('closed intent allowlist', () => {
    it('covers all eight intents with every finite target', () => {
        expect(APP_INTENTS).toHaveLength(8)
        expect(everyIntent.length).toBe(
            Object.values(INTENT_TARGETS).reduce((total, targets) => total + targets.length, 0),
        )
    })

    it('resolves every intent on every screen kind without throwing, and only ever runs an existing capability', () => {
        for (const kind of SCREEN_KINDS) {
            for (const intent of everyIntent) {
                const { host: h, controller, nav, extras } = host({ kind })
                const resolved = resolveIntent(intent, h)
                expect(typeof resolved.enabled).toBe('boolean')
                expect(resolved.enabled === (resolved.reason === null)).toBe(true)
                resolved.run()
                const touched = [
                    ...Object.values(controller).filter((value) => vi.isMockFunction(value)),
                    ...Object.values(nav),
                    ...Object.values(extras),
                ]
                    // Reading coverage is a question, not an action.
                    .filter((value) => value !== controller.coverageNotice)
                    .filter((value) => vi.isMockFunction(value) && value.mock.calls.length > 0)
                // A disabled intent does nothing at all; an enabled one reaches at most one capability.
                expect(touched.length).toBeLessThanOrEqual(resolved.enabled ? 1 : 0)
            }
        }
    })
})

describe('guards that hold whatever a document asked for', () => {
    it('marks a step done only for a held pass on the current photo', () => {
        const step: AppIntent = { intent: 'confirm', target: 'step' }
        expect(resolveIntent(step, host().host).enabled).toBe(false)
        const refused = host(
            {},
            { check: { ...passCheck, decision: 'refuse' }, capture: {} as WorkflowState['capture'] },
        )
        expect(resolveIntent(step, refused.host).enabled).toBe(false)
        const noPhoto = host({}, { check: passCheck })
        expect(resolveIntent(step, noPhoto.host).enabled).toBe(false)
        const passed = host({}, { check: passCheck, capture: {} as WorkflowState['capture'] })
        const resolved = resolveIntent(step, passed.host)
        expect(resolved.enabled).toBe(true)
        resolved.run()
        expect(passed.controller.completeStep).toHaveBeenCalledTimes(1)
    })

    it('finishes the build from the last step instead of only advancing', () => {
        const last = entryOf({ stepIndex: reviewed.reviewedSteps.length - 1 })
        const passed = host({ entry: last }, { check: passCheck, capture: {} as WorkflowState['capture'] })
        resolveIntent({ intent: 'confirm', target: 'step' }, passed.host).run()
        expect(passed.nav.finish).toHaveBeenCalledTimes(1)
        expect(passed.controller.completeStep).not.toHaveBeenCalled()
    })

    it.each([
        ['loading', { loading: true }],
        ['read-only', { storageReadOnly: true }],
        ['a request in flight', { pending: 'Checking frozen photo…' }],
    ])('refuses every mutating intent while %s', (_name, state) => {
        const busy = host({}, { ...state, check: passCheck, capture: {} as WorkflowState['capture'] })
        for (const intent of [
            { intent: 'capture', target: 'take-photo' },
            { intent: 'check', target: 'current-step' },
            { intent: 'confirm', target: 'step' },
            { intent: 'retry', target: 'check' },
        ] as AppIntent[]) {
            const resolved = resolveIntent(intent, busy.host)
            expect(resolved.enabled).toBe(false)
            expect(resolved.reason).toMatch(/.+/u)
        }
    })

    it.each([
        [{ loading: true }, 'Opening your manuals'],
        [{ pending: 'Preparing page 1 of 2…' }, 'Getting your photos ready'],
        [{ pending: 'Saving on this device…' }, 'Saving your progress'],
    ])('explains a blocked intent with the current activity', (state, reason) => {
        const busy = host({}, state)
        const resolved = resolveIntent({ intent: 'check', target: 'current-step' }, busy.host)
        expect(resolved.enabled).toBe(false)
        expect(resolved.reason).toBe(reason)
    })

    it('never opens the camera for a check before the manual facts are confirmed', () => {
        const unreviewed = entryOf({ session: { ...reviewed, reviewStatus: 'unreviewed' } })
        const draft = host({ entry: unreviewed })
        expect(resolveIntent({ intent: 'check', target: 'current-step' }, draft.host).enabled).toBe(false)
        expect(resolveIntent({ intent: 'navigate', target: 'guide' }, draft.host).enabled).toBe(false)
    })

    it('does not offer a photo check when the cited pages do not fit', () => {
        const gap = host()
        vi.mocked(gap.controller.coverageNotice).mockReturnValue('Complete manual context is unavailable.')
        expect(resolveIntent({ intent: 'check', target: 'current-step' }, gap.host).enabled).toBe(false)
    })

    it('confirms the manual only when its critical facts are all there', () => {
        const draft = entryOf({ session: { ...reviewed, reviewStatus: 'unreviewed' } })
        const ready = host({ entry: draft, kind: 'quick-check' })
        const resolved = resolveIntent({ intent: 'confirm', target: 'facts' }, ready.host)
        expect(resolved.enabled).toBe(true)
        resolved.run()
        expect(ready.nav.startBuilding).toHaveBeenCalledTimes(1)
        const missing = entryOf({
            session: {
                ...reviewed,
                reviewStatus: 'unreviewed',
                reviewedSteps: reviewed.reviewedSteps.map((step) => ({
                    ...step,
                    orientation: { state: 'unknown', reason: 'unread' },
                })),
            },
        })
        expect(
            resolveIntent({ intent: 'confirm', target: 'facts' }, host({ entry: missing, kind: 'quick-check' }).host)
                .enabled,
        ).toBe(false)
    })

    it('adds a manual only from Home, and never creates one from another screen', () => {
        const fromHome = host({ kind: 'home', entry: undefined }, { selectedId: null })
        const resolved = resolveIntent({ intent: 'navigate', target: 'add' }, fromHome.host)
        expect(resolved.enabled).toBe(true)
        resolved.run()
        expect(fromHome.controller.createManual).toHaveBeenCalledTimes(1)
        const elsewhere = host({ kind: 'guide' })
        expect(resolveIntent({ intent: 'navigate', target: 'add' }, elsewhere.host).enabled).toBe(false)
    })

    it('maps a photo request to the page camera on page screens and the check camera on step screens', () => {
        const pages = host({ kind: 'pages' })
        resolveIntent({ intent: 'capture', target: 'take-photo' }, pages.host).run()
        expect(pages.controller.camera).toHaveBeenCalledWith({ kind: 'page' })
        const step = host({ kind: 'guide' })
        resolveIntent({ intent: 'capture', target: 'take-photo' }, step.host).run()
        expect(step.controller.camera).toHaveBeenCalledWith({ kind: 'check' })
        const ask = host({ kind: 'answer' })
        resolveIntent({ intent: 'capture', target: 'take-photo' }, ask.host).run()
        expect(ask.controller.camera).toHaveBeenCalledWith({ kind: 'question' })
    })

    it('routes ask and details to the More sheet and does not invent a destination', () => {
        const h = host()
        resolveIntent({ intent: 'ask', target: 'about-step' }, h.host).run()
        expect(h.extras.showMore).toHaveBeenCalledWith('ask')
        resolveIntent({ intent: 'open-details', target: 'sources' }, h.host).run()
        expect(h.extras.showMore).toHaveBeenLastCalledWith('details')
        expect(h.controller.navigate).not.toHaveBeenCalled()
    })

    it('opens contextual More questions only for its actual reviewed step and held reusable photo', () => {
        const capture: NonNullable<WorkflowState['capture']> = {
            binding: {
                kind: 'capture',
                manualId: reviewed.manualId,
                revision: reviewed.revision,
                stepId: reviewed.reviewedSteps[0]!.stepId,
                captureId: 'held-more',
            },
            observation: {
                uri: 'file:///synthetic-more.jpg',
                width: 600,
                height: 800,
                bytes: new Uint8Array(),
                mimeType: 'image/jpeg',
            },
            capturedAt: 0,
            reusable: true,
        }
        const ready = host({ kind: 'more' }, { capture, check: { ...passCheck, decision: 'refuse' } })
        const contextualHost = { ...ready.host, extras: { ...ready.extras, contextualMore: true } }
        const ask: AppIntent = { intent: 'ask', target: 'about-step' }
        resolveIntent(ask, contextualHost).run()
        expect(ready.extras.showMore).toHaveBeenCalledWith('ask')
        expect(ready.controller.completeStep).not.toHaveBeenCalled()
        for (const stale of [
            { ...contextualHost, extras: { ...ready.extras, contextualMore: false } },
            { ...contextualHost, state: { ...ready.host.state, capture: null } },
            { ...contextualHost, state: { ...ready.host.state, pending: 'Checking photo…' } },
            ...[
                { reusable: false },
                { binding: { ...capture.binding, manualId: 'another-manual' } },
                { binding: { ...capture.binding, revision: reviewed.revision + 1 } },
                { binding: { ...capture.binding, stepId: 'another-step' } },
            ].map((change) => ({
                ...contextualHost,
                state: { ...ready.host.state, capture: { ...capture, ...change } },
            })),
        ])
            expect(resolveIntent(ask, stale).enabled).toBe(false)
    })

    it('disables an action whose handler the screen does not have, with a reason', () => {
        const bare = host({ extras: {} })
        const resolved = resolveIntent({ intent: 'open-details', target: 'step' }, bare.host)
        expect(resolved).toMatchObject({ enabled: false })
        expect(resolved.reason).toMatch(/.+/u)
    })
})
