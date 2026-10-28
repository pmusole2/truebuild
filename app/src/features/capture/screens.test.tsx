import { useSyncExternalStore, type ReactElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { createDemoManual, type ManualSession } from '@truebuild/contracts'
import { ModelApiClient } from '../../api/model-client'
import { CaptureController } from './controller'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from './library'
import {
    AnswerPanel,
    CheckPanel,
    LibraryScreen,
    noticeTone,
    OverviewScreen,
    PagesScreen,
    SettingsScreen,
    WorkflowNotice,
} from './screens'
import { PRIVACY_COPY } from './privacy-copy'

function setup(entry?: LibraryEntry): { controller: CaptureController; storage: LibraryStorage; kv: KeyValueStorage } {
    const data = new Map<string, string>()
    let sequence = 0
    const kv: KeyValueStorage = {
        getItem: async (key): Promise<string | null> => data.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            data.set(key, value)
        },
        removeItem: async (key): Promise<void> => {
            data.delete(key)
        },
        getAllKeys: async (): Promise<string[]> => [...data.keys()],
    }
    const storage = new LibraryStorage(kv, async (): Promise<string> => '0'.repeat(64))
    const controller = new CaptureController({
        storage,
        client: new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: '' }),
        normalize: async (): Promise<never> => {
            throw new Error('No camera in this screen test')
        },
        digest: async (): Promise<string> => '0'.repeat(64),
        // Unique per call: each accepted visible check needs its own generated identity.
        id: (): string => `ui-${++sequence}`,
    })
    if (entry !== undefined) {
        entry.session.pages[0]!.contentHash = '0'.repeat(64)
    }
    return { controller, storage, kv }
}
function Screens({ controller }: { controller: CaptureController }): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    const entry = controller.current
    return state.route === 'pages' && entry !== undefined ? (
        <PagesScreen state={state} controller={controller} entry={entry} choosePages={(): void => undefined} />
    ) : state.route === 'overview' && entry !== undefined ? (
        // Matches CaptureWorkflow: a new manual or revision remounts the screen and resets its local drafts.
        <OverviewScreen
            key={`${entry.session.manualId}:${entry.session.revision}`}
            state={state}
            controller={controller}
            entry={entry}
        />
    ) : (
        <LibraryScreen state={state} controller={controller} />
    )
}
// Reanimated's native runtime is not loaded under Jest; the ui stand-in records the animation intent instead.
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const controllers: CaptureController[] = []
afterEach(() => {
    for (const controller of controllers.splice(0)) {
        controller.dispose()
    }
})

it('shows an empty real library and creates a page editor without seeding a demo', async () => {
    const { controller } = setup()
    controllers.push(controller)
    await controller.restore()
    await render(<Screens controller={controller} />)
    expect(screen.getByText('No manuals yet.')).toBeTruthy()
    expect(screen.getByText('Scan or choose your own manual pages to start.')).toBeTruthy()
    expect(screen.queryByText('Use sample manual')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
    expect(await screen.findByText('Manual pages')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan a page' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose pages from photos' })).toBeTruthy()
    expect(controller.current?.session.pages).toEqual([])
})

it('requires an explicit fact-review checkbox before confirmation and displays unknown critical facts', async () => {
    const session = createDemoManual()
    session.reviewStatus = 'unreviewed'
    session.rawExtraction = { parts: session.parts, steps: session.reviewedSteps, unknowns: [] }
    for (const step of session.reviewedSteps) {
        if (step.correction !== null) {
            step.correction.reviewed = false
        }
    }
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await controller.open(session.manualId)
    await render(<Screens controller={controller} />)
    const confirm = screen.getByRole('button', { name: 'Confirm reviewed facts' })
    expect(confirm.props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled).toBe(false)
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm reviewed facts' }))
    expect(await screen.findByText('Facts confirmed by you.')).toBeTruthy()
    await act(async () => {
        await controller.editPage(0, 'remove')
    })
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
})

it.each([false, true])(
    'shows critical review requirements without blocking noncritical annotations (unresolved=%s)',
    async (unresolved) => {
        const session = createDemoManual()
        session.reviewStatus = 'unreviewed'
        for (const step of session.reviewedSteps) {
            if (step.correction !== null) {
                step.correction.reviewed = false
            }
        }
        if (unresolved) {
            session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Arrow is not visible.' }
        }
        session.rawExtraction = {
            parts: session.parts,
            steps: session.reviewedSteps,
            unknowns: ['Packaging colour could not be read.'],
        }
        const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
        const { controller, storage } = setup(entry)
        controllers.push(controller)
        await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
        await controller.restore()
        await controller.open(session.manualId)
        await render(<Screens controller={controller} />)
        expect(screen.getByText('Extraction note: Packaging colour could not be read.')).toBeTruthy()
        if (unresolved) {
            expect(screen.getByText('Unresolved critical fact: Step 1 orientation: Arrow is not visible.')).toBeTruthy()
            expect(screen.getByText(/Add or retake clearer pages/)).toBeTruthy()
            expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true)
        } else {
            await fireEvent.press(screen.getByRole('checkbox'))
            expect(
                screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled,
            ).toBe(false)
        }
    },
)

it('retains confirmed facts during a transient restore failure and offers an explicit nondestructive retry', async () => {
    const session = createDemoManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage, kv } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await controller.open(session.manualId)
    await render(<Screens controller={controller} />)
    const originalGet = kv.getItem
    kv.getItem = async (): Promise<never> => {
        throw new Error('Temporary IO failure')
    }
    await act(async () => {
        await controller.restore()
    })
    expect(controller.getSnapshot().storageReadOnly).toBe(true)
    expect(screen.getByText('Facts confirmed by you.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry local library' })).toBeTruthy()
    kv.getItem = originalGet
    await fireEvent.press(screen.getByRole('button', { name: 'Retry local library' }))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(false))
    expect(screen.getByText('Facts confirmed by you.')).toBeTruthy()
})

it.each([
    ['Manual reading unavailable (provider_error). Check your connection.', 'error'],
    ['Local library images could not be read. Original data is retained.', 'error'],
    ['Cancelled. No late reply will be shown. Retry is a new request.', 'info'],
    ['Review every fact against the page diagrams before confirming.', 'info'],
])('notice tone reads failures as errors and progress or cancellation as information: %s', (text, tone) => {
    expect(noticeTone(text)).toBe(tone)
})

it('shows the restoring state while the local library loads, before any manual is listed', async () => {
    const { controller } = setup()
    controllers.push(controller)
    expect(controller.getSnapshot().loading).toBe(true)
    await render(<LibraryScreen state={controller.getSnapshot()} controller={controller} />)
    expect(screen.getByText('Restoring local library…')).toBeTruthy()
    expect(screen.queryByText('No manuals yet.')).toBeNull()
})

it('settings explain storage, what leaves the phone and camera access, with counts from the real library', async () => {
    const session = createDemoManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await render(<SettingsScreen state={controller.getSnapshot()} onBack={(): void => undefined} />)
    expect(screen.getByText('1 manual is stored on this device.')).toBeTruthy()
    expect(screen.getByText('What leaves this phone')).toBeTruthy()
    expect(screen.getByText(PRIVACY_COPY.check)).toBeTruthy()
    expect(screen.getByText(PRIVACY_COPY.read)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open device settings' })).toBeTruthy()
})

it('a successful answer after a refused check never shows a Pass verdict, and the check verdict stays refused', async () => {
    const session = createDemoManual()
    const page = session.pages[0]!
    await render(
        <>
            <CheckPanel
                check={{
                    decision: 'refuse',
                    reason: 'The side panel is reversed.',
                    sourceRefs: [{ pageId: page.pageId, region: null }],
                    observedRegion: null,
                    missingEvidence: [],
                }}
                session={session}
                pageUris={{}}
            />
            <AnswerPanel
                answer={{ answer: 'It faces inward.', sourceRefs: [], missingEvidence: [], observedRegion: null }}
                session={session}
                pageUris={{}}
            />
        </>,
    )
    expect(screen.getByText('Refuse', { exact: true })).toBeTruthy()
    expect(screen.getByText('Answer', { exact: true })).toBeTruthy()
    expect(screen.getByText('It faces inward.')).toBeTruthy()
    expect(screen.queryByText('Pass', { exact: true })).toBeNull()
})

it('shows the actual result producer, attempted second model and plain-text failure note beside the retained verdict', async () => {
    const { controller } = setup()
    controllers.push(controller)
    await render(
        <>
            <WorkflowNotice
                state={{ ...controller.getSnapshot(), pending: 'Second opinion pending (muse-wonder-1.0)…' }}
                controller={controller}
            />
            <CheckPanel
                check={{
                    decision: 'cannot_verify',
                    reason: 'Groove is obscured.',
                    sourceRefs: [],
                    observedRegion: null,
                    missingEvidence: ['A clearer angle.'],
                    model: 'muse-spark-1.3',
                    modelNotes: ['Second opinion unavailable. Primary result retained.'],
                    secondOpinion: { status: 'unavailable', model: 'muse-wonder-1.0' },
                }}
                session={createDemoManual()}
                pageUris={{}}
            />
        </>,
    )
    expect(screen.getByText('Model: muse-spark-1.3')).toBeTruthy()
    expect(screen.getByText('Second opinion: muse-wonder-1.0 (unavailable)')).toBeTruthy()
    expect(screen.getByText('Model note: Second opinion unavailable. Primary result retained.')).toBeTruthy()
    expect(screen.getByText('Groove is obscured.')).toBeTruthy()
    expect(screen.getByText('Second opinion pending (muse-wonder-1.0)…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByText('Pass', { exact: true })).toBeNull()
})

it('shows server provenance and model notes in the manual overview and neutral answer surfaces', async () => {
    const session = createDemoManual()
    session.rawExtraction = {
        parts: session.parts,
        steps: session.reviewedSteps,
        unknowns: [],
        model: 'muse-wonder-1.0',
        modelNotes: ['Manual parsed with Wonder.'],
    }
    const { controller } = setup()
    controllers.push(controller)
    await render(
        <>
            <OverviewScreen
                controller={controller}
                state={controller.getSnapshot()}
                entry={{ session, stepIndex: 0, completedStepIds: [], capture: null }}
            />
            <AnswerPanel
                answer={{
                    answer: 'Read the marked edge.',
                    sourceRefs: [],
                    missingEvidence: [],
                    model: 'muse-spark-1.3',
                    modelNotes: ['The photo does not show the groove.'],
                }}
                session={session}
                pageUris={{}}
            />
        </>,
    )
    expect(screen.getByText('Model: muse-wonder-1.0')).toBeTruthy()
    expect(screen.getByText('Model note: Manual parsed with Wonder.')).toBeTruthy()
    expect(screen.getByText('Model: muse-spark-1.3')).toBeTruthy()
    expect(screen.getByText('Model note: The photo does not show the groove.')).toBeTruthy()
    expect(screen.queryByText('Pass', { exact: true })).toBeNull()
})

it('does not invent model provenance for legacy results without model fields', async () => {
    await render(
        <AnswerPanel
            answer={{ answer: 'Legacy answer.', sourceRefs: [], missingEvidence: [] }}
            session={createDemoManual()}
            pageUris={{}}
        />,
    )
    expect(screen.queryByText(/^Model:/)).toBeNull()
    expect(screen.queryByText(/^Model note:/)).toBeNull()
})

const ORIENTATION_LABEL = 'Orientation cue'
const CHECKS_LABEL = 'Visible checks, one per line'

/** Unreviewed demo manual with every correction still awaiting review. */
function unreviewedDemo(): ManualSession {
    const session = createDemoManual()
    session.reviewStatus = 'unreviewed'
    for (const step of session.reviewedSteps) {
        if (step.correction !== null) {
            step.correction.reviewed = false
        }
    }
    return session
}

/**
 * Step 1 (one part) has an unknown orientation; step 2 (two parts) has no visible checks. Raw extraction keeps the
 * original readings so tests can prove that drafts and failed accepts never touch it.
 */
function partlyResolvedManual(): ManualSession {
    const session = unreviewedDemo()
    session.rawExtraction = { parts: session.parts, steps: structuredClone(session.reviewedSteps), unknowns: [] }
    session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Arrow is not visible.' }
    session.reviewedSteps[1]!.visibleChecks = []
    return session
}

async function renderManual(session: ManualSession): Promise<{ controller: CaptureController; kv: KeyValueStorage }> {
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage, kv } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await controller.open(session.manualId)
    await render(<Screens controller={controller} />)
    return { controller, kv }
}

it('offers a fact editor only under steps whose orientation or visible checks are missing', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    expect(screen.getAllByLabelText(ORIENTATION_LABEL)).toHaveLength(1)
    expect(screen.getAllByLabelText(CHECKS_LABEL)).toHaveLength(1)
    // Each step card shows its cited diagram once; the editor adds no diagram block of its own.
    expect(screen.getAllByTestId('diagram-0')).toHaveLength(2)
    expect(controller.current?.session.revision).toBe(1)
})

it('shows no fact editor when every step already has orientation and visible checks', async () => {
    await renderManual(unreviewedDemo())
    expect(screen.queryByLabelText(ORIENTATION_LABEL)).toBeNull()
    expect(screen.queryByLabelText(CHECKS_LABEL)).toBeNull()
})

it('keeps typed drafts out of the facts and keeps global confirmation blocked', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    const before = structuredClone(controller.current?.session)
    await fireEvent.changeText(screen.getByLabelText(ORIENTATION_LABEL), 'Groove faces inward.')
    await fireEvent.changeText(screen.getByLabelText(CHECKS_LABEL), 'Groove is visible.')
    expect(controller.current?.session).toEqual(before)
    expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled).toBe(true)
})

it('accepts orientation for the sole part, then checks one per line; partial resolution stays blocked until both are accepted and the manual is checked', async () => {
    const session = partlyResolvedManual()
    const { controller } = await renderManual(session)
    const orientationCited = session.reviewedSteps[0]!.sourceRefs
    const checksCited = session.reviewedSteps[1]!.sourceRefs
    expect(screen.getByText('Part: Side panel (side-panel)')).toBeTruthy()

    await fireEvent.changeText(screen.getByLabelText(ORIENTATION_LABEL), '  Groove faces inward toward the divider.  ')
    await fireEvent.press(screen.getByRole('button', { name: 'Accept orientation' }))
    await waitFor(() => expect(controller.current?.session.revision).toBe(2))
    expect(controller.current?.session.reviewedSteps[0]?.orientation).toEqual({
        state: 'known',
        value: { partId: 'side-panel', description: 'Groove faces inward toward the divider.' },
        sourceRefs: orientationCited,
    })
    expect(screen.queryByLabelText(ORIENTATION_LABEL)).toBeNull()
    expect(screen.getByText('Unresolved critical fact: Step 2: visible checks are missing.')).toBeTruthy()
    expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true)

    await fireEvent.changeText(
        screen.getByLabelText(CHECKS_LABEL),
        'The groove is visible.\n\n  Divider edge is seated.  \n',
    )
    await fireEvent.press(screen.getByRole('button', { name: 'Accept visible checks' }))
    await waitFor(() => expect(controller.current?.session.revision).toBe(3))
    const checks = controller.current?.session.reviewedSteps[1]?.visibleChecks ?? []
    expect(checks.map((check) => check.description)).toEqual([
        { state: 'known', value: 'The groove is visible.', sourceRefs: checksCited },
        { state: 'known', value: 'Divider edge is seated.', sourceRefs: checksCited },
    ])
    expect(new Set(checks.map((check) => check.checkId)).size).toBe(2)
    expect(screen.queryByText(/Unresolved critical fact/)).toBeNull()

    // Every fact is resolved, but the whole-manual checkbox must still be ticked explicitly.
    expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(screen.getByRole('checkbox'))
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm reviewed facts' }))
    expect(await screen.findByText('Facts confirmed by you.')).toBeTruthy()
})

it('requires an explicit part choice when several parts could carry the orientation cue', async () => {
    const session = partlyResolvedManual()
    session.reviewedSteps[1]!.orientation = { state: 'unknown', reason: 'Divider direction is hidden.' }
    const { controller } = await renderManual(session)
    // Step 1 (one part) is unknown too, so step 2's editor is the second one on screen.
    await fireEvent.changeText(screen.getAllByLabelText(ORIENTATION_LABEL)[1]!, 'Divider sits square to the panel.')
    await fireEvent.press(screen.getAllByRole('button', { name: 'Accept orientation' })[1]!)
    expect(await screen.findByText('Choose the part this cue applies to.')).toBeTruthy()
    expect(controller.current?.session.revision).toBe(1)
    // The part selector requests horizontal scrolling; this test does not prove actual phone layout.
    expect(screen.getByLabelText('Scroll orientation parts').props.horizontal).toBe(true)

    await fireEvent.press(screen.getByRole('radio', { name: 'Divider shelf (divider)' }))
    await fireEvent.press(screen.getAllByRole('button', { name: 'Accept orientation' })[1]!)
    await waitFor(() => expect(controller.current?.session.revision).toBe(2))
    expect(controller.current?.session.reviewedSteps[1]?.orientation).toMatchObject({
        state: 'known',
        value: { partId: 'divider', description: 'Divider sits square to the panel.' },
    })
})

it.each([
    ['Accept orientation', ORIENTATION_LABEL, '   ', 'Describe the visible cue, or leave orientation unknown.'],
    ['Accept visible checks', CHECKS_LABEL, ' \n  \n', 'Enter at least one visible check, one condition per line.'],
])('rejects blank input for %s inline without saving anything', async (button, label, draft, message) => {
    const { controller } = await renderManual(partlyResolvedManual())
    const before = structuredClone(controller.current?.session)
    await fireEvent.changeText(screen.getByLabelText(label), draft)
    await fireEvent.press(screen.getByRole('button', { name: button }))
    expect(screen.getByText(message)).toBeTruthy()
    expect(controller.current?.session).toEqual(before)
    expect(screen.getByLabelText(label).props.value).toBe(draft)
})

it('Cancel clears unaccepted drafts and leaves facts, revision and raw evidence unchanged', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    const before = structuredClone(controller.current?.session)
    await fireEvent.changeText(screen.getByLabelText(ORIENTATION_LABEL), 'Groove faces inward.')
    await fireEvent.changeText(screen.getByLabelText(CHECKS_LABEL), 'Groove is visible.')
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel orientation draft' }))
    expect(screen.getByLabelText(ORIENTATION_LABEL).props.value).toBe('')
    expect(screen.getByLabelText(CHECKS_LABEL).props.value).toBe('Groove is visible.')
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel checks draft' }))
    expect(screen.getByLabelText(CHECKS_LABEL).props.value).toBe('')
    expect(controller.current?.session).toEqual(before)
})

it('a rejected accept keeps the draft for correction and shows the controller notice', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    const tooLong = 'x'.repeat(501)
    await fireEvent.changeText(screen.getByLabelText(CHECKS_LABEL), tooLong)
    await fireEvent.press(screen.getByRole('button', { name: 'Accept visible checks' }))
    await waitFor(() => expect(controller.getSnapshot().notice).not.toBeNull())
    expect(screen.getByText(controller.getSnapshot().notice ?? '')).toBeTruthy()
    expect(screen.getByLabelText(CHECKS_LABEL).props.value).toBe(tooLong)
    expect(controller.current?.session.revision).toBe(1)
})

it('a failed save shows the notice, promotes no fact and keeps the draft', async () => {
    const session = partlyResolvedManual()
    const { controller, kv } = await renderManual(session)
    const before = structuredClone(controller.current?.session)
    kv.setItem = async (): Promise<never> => {
        throw new Error('Disk full')
    }
    await fireEvent.changeText(screen.getByLabelText(ORIENTATION_LABEL), 'Groove faces inward.')
    await fireEvent.press(screen.getByRole('button', { name: 'Accept orientation' }))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(true))
    expect(
        screen.getByText(
            'Could not save on this device. Original library data is retained. Retry reading the local library before making changes.',
        ),
    ).toBeTruthy()
    expect(controller.current?.session).toEqual(before)
    expect(screen.getByLabelText(ORIENTATION_LABEL).props.value).toBe('Groove faces inward.')
})

it('explains that a step without a cited manual page cannot accept facts', async () => {
    const session = partlyResolvedManual()
    session.reviewedSteps[0]!.sourceRefs = []
    await renderManual(session)
    expect(screen.getByText(/no cited manual page/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept orientation' }).props.accessibilityState.disabled).toBe(true)
})

it('a revision change discards unaccepted drafts from the previous revision', async () => {
    const session = partlyResolvedManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller } = setup(entry)
    controllers.push(controller)
    const { rerender } = await render(
        <OverviewScreen state={controller.getSnapshot()} controller={controller} entry={entry} />,
    )
    await fireEvent.changeText(screen.getByLabelText(CHECKS_LABEL), 'Groove is visible.')
    await rerender(
        <OverviewScreen
            state={controller.getSnapshot()}
            controller={controller}
            entry={{ ...entry, session: { ...session, revision: 2 } }}
        />,
    )
    expect(screen.getByLabelText(CHECKS_LABEL).props.value).toBe('')
})

it('a revision change clears a stale whole-manual checkbox', async () => {
    const session = unreviewedDemo()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller } = setup(entry)
    controllers.push(controller)
    const { rerender } = await render(
        <OverviewScreen state={controller.getSnapshot()} controller={controller} entry={entry} />,
    )
    await fireEvent.press(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(true)
    await rerender(
        <OverviewScreen
            state={controller.getSnapshot()}
            controller={controller}
            entry={{ ...entry, session: { ...session, revision: 2 } }}
        />,
    )
    expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false)
})

function entryFor(session: ManualSession): LibraryEntry {
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

it('lists confirmed steps as collapsed cards with chips, and expanding one shows its facts and cited diagram', async () => {
    const { controller } = setup()
    controllers.push(controller)
    await render(
        <OverviewScreen
            state={controller.getSnapshot()}
            controller={controller}
            entry={entryFor(createDemoManual())}
        />,
    )
    expect(screen.getByText('1. Stand the side panel upright')).toBeTruthy()
    expect(screen.getByText('2. Seat the divider in the groove')).toBeTruthy()
    expect(screen.getAllByText('Orientation known')).toHaveLength(2)
    expect(screen.getAllByText('Cited page 1').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^Orientation: /)).toBeNull()
    expect(screen.queryByTestId('diagram-0')).toBeNull()
    // Guiding a step never needs an expansion first.
    expect(screen.getByRole('button', { name: 'Guide step 1' })).toBeTruthy()

    await fireEvent.press(screen.getByRole('button', { name: 'Step 1 details' }))
    expect(screen.getByRole('button', { name: 'Step 1 details' }).props.accessibilityState.expanded).toBe(true)
    expect(screen.getAllByText(/^Orientation: /)).toHaveLength(1)
    expect(screen.getAllByText(/^Visible check: /).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('diagram-0')).toHaveLength(1)
    expect(screen.getByText('Expected diagram · page 1')).toBeTruthy()
    // The card title is shown once; the opened facts do not repeat it.
    expect(screen.getAllByText('1. Stand the side panel upright')).toHaveLength(1)
    expect(screen.queryByLabelText(ORIENTATION_LABEL)).toBeNull()

    await fireEvent.press(screen.getByRole('button', { name: 'Step 1 details' }))
    expect(screen.queryByText(/^Orientation: /)).toBeNull()
    expect(screen.queryByTestId('diagram-0')).toBeNull()
})

it('groups every unresolved critical fact once and keeps each step that needs the editors open and unclosable', async () => {
    const session = partlyResolvedManual()
    session.rawExtraction = {
        parts: session.parts,
        steps: session.reviewedSteps,
        unknowns: ['Packaging colour could not be read.'],
    }
    await renderManual(session)
    expect(screen.getByText('2 facts need you')).toBeTruthy()
    expect(screen.getAllByText(/^Unresolved critical fact: /)).toHaveLength(2)
    expect(screen.getByText('Unresolved critical fact: Step 1 orientation: Arrow is not visible.')).toBeTruthy()
    expect(screen.getByText('Notes from reading')).toBeTruthy()
    expect(screen.getByText('Extraction note: Packaging colour could not be read.')).toBeTruthy()
    expect(screen.getAllByText('Needs your input')).toHaveLength(2)
    expect(screen.getAllByLabelText(ORIENTATION_LABEL)).toHaveLength(1)
    expect(screen.getAllByLabelText(CHECKS_LABEL)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Step 1 details' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Step 2 details' })).toBeNull()
    expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true)
})

it('marks a step as needing input when one of its required part names is unknown', async () => {
    const session = unreviewedDemo()
    session.parts[0]!.name = { state: 'unknown', reason: 'The part name is not readable.' }
    await renderManual(session)
    expect(screen.getAllByText('Needs your input').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Step 1 details' }).props.accessibilityState.expanded).toBe(true)
    expect(screen.getByRole('checkbox').props.accessibilityState.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState.disabled).toBe(true)
})

it('opens a step with an unknown fact, states its reason once while collapsed, and restarts on a new revision', async () => {
    const session = unreviewedDemo()
    session.reviewedSteps[0]!.connection = { state: 'unknown', reason: 'Connector is not drawn.' }
    const entry = entryFor(session)
    const { controller } = setup(entry)
    controllers.push(controller)
    const view = (revision: number): ReactElement => (
        <OverviewScreen
            state={controller.getSnapshot()}
            controller={controller}
            entry={{ ...entry, session: { ...session, revision } }}
        />
    )
    const { rerender } = await render(view(1))
    // Open by default: the step's full facts carry the reason, and so does the grouped list.
    expect(screen.getAllByText(/Connector is not drawn/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Step 2 details' })?.props.accessibilityState.expanded).toBe(false)
    expect(screen.queryByLabelText(ORIENTATION_LABEL)).toBeNull()

    await fireEvent.press(screen.getByRole('button', { name: 'Step 1 details' }))
    expect(screen.getAllByText(/Connector is not drawn/)).toHaveLength(1)
    expect(screen.getByText('Unresolved critical fact: Step 1 connection: Connector is not drawn.')).toBeTruthy()

    await rerender(view(2))
    expect(screen.getAllByText(/Connector is not drawn/)).toHaveLength(2)
})

describe('PagesScreen', () => {
    function pagesEntry(count: number): LibraryEntry {
        const session = createDemoManual()
        session.pages = Array.from({ length: count }, (_, index) => ({
            ...createDemoManual().pages[0]!,
            pageId: `page-${index + 1}`,
            assetId: `asset-${index + 1}`,
        }))
        session.rawExtraction = null
        return entryFor(session)
    }
    const noop = (): void => undefined

    it('lets a person inspect a thumbnail at full width before reading the manual', async () => {
        const entry = pagesEntry(1)
        const { controller } = setup()
        controllers.push(controller)
        await render(
            <PagesScreen state={controller.getSnapshot()} entry={entry} controller={controller} choosePages={noop} />,
        )
        expect(screen.queryByTestId('bottom-sheet')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'View page 1' }))
        expect(screen.getByTestId('bottom-sheet')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        expect(screen.queryByTestId('bottom-sheet')).toBeNull()
    })

    it('shows the page count and index, and routes each page action with its original label', async () => {
        const { controller } = setup()
        controllers.push(controller)
        const editPage = jest.spyOn(controller, 'editPage').mockResolvedValue(undefined as never)
        const camera = jest.spyOn(controller, 'camera').mockImplementation(noop)
        const parse = jest.spyOn(controller, 'parse').mockResolvedValue(undefined as never)
        const choosePages = jest.fn()
        await render(
            <PagesScreen
                state={controller.getSnapshot()}
                controller={controller}
                entry={pagesEntry(2)}
                choosePages={choosePages}
            />,
        )
        expect(screen.getByText('2 of 20')).toBeTruthy()
        expect(screen.getByText('Page 2')).toBeTruthy()
        expect(screen.getByText('2 of 2')).toBeTruthy()
        expect(screen.getByText(PRIVACY_COPY.stayOnDevice)).toBeTruthy()
        expect(screen.getByText(PRIVACY_COPY.read)).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Move page 1 up' }).props.accessibilityState.disabled).toBe(true)
        expect(screen.getByRole('button', { name: 'Move page 2 down' }).props.accessibilityState.disabled).toBe(true)

        await fireEvent.press(screen.getByRole('button', { name: 'Move page 2 up' }))
        expect(editPage).toHaveBeenLastCalledWith(1, 'up')
        await fireEvent.press(screen.getByRole('button', { name: 'Move page 1 down' }))
        expect(editPage).toHaveBeenLastCalledWith(0, 'down')
        await fireEvent.press(screen.getByRole('button', { name: 'Remove page 2' }))
        expect(editPage).toHaveBeenLastCalledWith(1, 'remove')
        await fireEvent.press(screen.getByRole('button', { name: 'Retake page 1' }))
        expect(camera).toHaveBeenLastCalledWith({ kind: 'page', replaceIndex: 0 })
        await fireEvent.press(screen.getByRole('button', { name: 'Replace page 2 from photos' }))
        expect(choosePages).toHaveBeenLastCalledWith(1)
        await fireEvent.press(screen.getByRole('button', { name: 'Scan a page' }))
        expect(camera).toHaveBeenLastCalledWith({ kind: 'page' })
        await fireEvent.press(screen.getByRole('button', { name: 'Choose pages from photos' }))
        expect(choosePages).toHaveBeenLastCalledWith()
        await fireEvent.press(screen.getByRole('button', { name: 'Read manual' }))
        expect(parse).toHaveBeenCalledTimes(1)
    })

    it('stops adding at 20 pages but keeps replace and reading available', async () => {
        const { controller } = setup()
        controllers.push(controller)
        await render(
            <PagesScreen
                state={controller.getSnapshot()}
                controller={controller}
                entry={pagesEntry(20)}
                choosePages={noop}
            />,
        )
        // The count tag and the last page's own index both read "20 of 20".
        expect(screen.getAllByText('20 of 20')).toHaveLength(2)
        expect(screen.getByRole('button', { name: 'Scan a page' }).props.accessibilityState.disabled).toBe(true)
        expect(screen.getByRole('button', { name: 'Choose pages from photos' }).props.accessibilityState.disabled).toBe(
            true,
        )
        expect(
            screen.getByRole('button', { name: 'Replace page 20 from photos' }).props.accessibilityState.disabled,
        ).toBe(false)
        expect(screen.getByRole('button', { name: 'Read manual' }).props.accessibilityState.disabled).toBe(false)
    })

    it('shows a local empty state with reading unavailable, and no skeleton until a read is pending', async () => {
        const { controller } = setup()
        controllers.push(controller)
        await render(
            <PagesScreen
                state={controller.getSnapshot()}
                controller={controller}
                entry={pagesEntry(0)}
                choosePages={noop}
            />,
        )
        expect(screen.getByText('No pages yet.')).toBeTruthy()
        expect(screen.getByText('0 of 20')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Read manual' }).props.accessibilityState.disabled).toBe(true)
        expect(screen.queryByText(/Reading your pages/)).toBeNull()
        expect(screen.queryByRole('button', { name: 'Review extracted facts' })).toBeNull()
    })

    it('while reading, shows a skeleton, marks Read manual busy and pauses every page change', async () => {
        const { controller } = setup()
        controllers.push(controller)
        const entry = pagesEntry(1)
        entry.session.rawExtraction = { parts: [], steps: [], unknowns: [] }
        await render(
            <PagesScreen
                state={{ ...controller.getSnapshot(), pending: 'Reading manual pages…' }}
                controller={controller}
                entry={entry}
                choosePages={noop}
            />,
        )
        expect(screen.getByText('Reading manual pages…')).toBeTruthy()
        expect(screen.getByText('Reading your pages. Page changes are paused until it finishes.')).toBeTruthy()
        const read = screen.getByRole('button', { name: 'Read manual again' })
        expect(read.props.accessibilityState.busy).toBe(true)
        for (const name of ['Scan a page', 'Choose pages from photos', 'Remove page 1', 'Review extracted facts']) {
            expect(screen.getByRole('button', { name }).props.accessibilityState.disabled).toBe(true)
        }
    })
})
