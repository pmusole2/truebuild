import { useSyncExternalStore, type ReactElement } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { createDemoManual, type ManualSession } from '@truebuild/contracts'
import { PARSE_SPLIT_MESSAGE } from '@truebuild/contracts/model'
import { ModelApiClient } from '../../api/model-client'
import { MEDIA_MESSAGES } from '../../media/media-errors'
import { CaptureController } from './controller'
import { LibraryStorage, type KeyValueStorage, type LibraryEntry } from './library'
import {
    AnswerPanel,
    CheckPanel,
    GuideScreen,
    LibraryScreen,
    OverviewScreen,
    PagesScreen,
    PlainNotice,
    SettingsScreen,
} from './screens'
import { isProblemNotice, plainNotice } from './plain-copy'
import { PRIVACY_COPY } from './privacy-copy'
import { StepDetails } from './step-details'
import { ReviewCounts } from './review-counts'

const hidden = { includeHiddenElements: true } as const

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
        client: new ModelApiClient({
            baseUrl: 'https://screens.invalid',
            secret: '',
            fetch: async (): Promise<never> => {
                throw new Error('No model requests belong to screen tests.')
            },
        }),
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
        // Matches the Quick check route: a new manual remounts the screen; an accepted revision keeps the question count.
        <OverviewScreen key={entry.session.manualId} state={state} controller={controller} entry={entry} />
    ) : state.route === 'guide' && entry !== undefined ? (
        <GuideScreen state={state} controller={controller} entry={entry} />
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

const QUESTION = 'What the picture shows'
const CHECKS = 'What you should see, one per line'

it.each([
    [MEDIA_MESSAGES.permission, 'Photos are blocked. Allow Photos in Settings or take a photo.'],
    [MEDIA_MESSAGES.unsupported, 'Use a JPEG, PNG or WebP photo.'],
    [MEDIA_MESSAGES.unreadable, 'This photo will not open. Save it again as JPEG, PNG or WebP.'],
    [MEDIA_MESSAGES.oversize, 'This photo is too large. Choose a smaller photo.'],
    [MEDIA_MESSAGES.pixels, 'This photo is too large. Choose a smaller photo.'],
    [MEDIA_MESSAGES.generic, 'We could not use that photo. Nothing was sent.'],
])('keeps an actionable plain recovery for photo import failure: %s', (message, recovery) => {
    expect(plainNotice(message)).toBe(recovery)
    expect(isProblemNotice(message)).toBe(true)
})
const openMore = async (): Promise<void> => {
    await fireEvent.press(screen.getByRole('button', { name: 'More' }))
}
// The default Quick check card holds only the picture, one question and Let me fix it. The editor is in More.
const openFix = async (): Promise<void> => {
    await fireEvent.press(screen.getByRole('button', { name: 'Let me fix it' }))
}

/** Unreviewed demo manual with every correction still awaiting review. */
function unreviewedDemo(): ManualSession {
    const session = createDemoManual()
    session.reviewStatus = 'unreviewed'
    for (const step of session.reviewedSteps) {
        if (step.correction !== null) {
            step.correction.reviewed = false
        }
    }
    session.rawExtraction = { parts: session.parts, steps: structuredClone(session.reviewedSteps), unknowns: [] }
    return session
}

/**
 * Step 1 (one part) has an unknown orientation; step 2 (two parts) has no visible checks. Raw extraction keeps the
 * original readings so tests can prove that drafts and failed accepts never touch it.
 */
function partlyResolvedManual(): ManualSession {
    const session = unreviewedDemo()
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

function entryFor(session: ManualSession): LibraryEntry {
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

it('shows an empty real library and creates a page editor without seeding a demo', async () => {
    const { controller } = setup()
    controllers.push(controller)
    await controller.restore()
    await render(<Screens controller={controller} />)
    expect(screen.getByText('Build furniture with step-by-step help.')).toBeTruthy()
    expect(screen.queryByText('Use sample manual')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
    expect(await screen.findByText('Take a photo of each page of your paper manual.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose pages from photos' })).toBeTruthy()
    expect(controller.current?.session.pages).toEqual([])
})

it('asks nothing when no fact is missing, and confirms only on the explicit Start building tap', async () => {
    const session = unreviewedDemo()
    const { controller } = await renderManual(session)
    expect(screen.getByText('Thanks. Your steps are ready.')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    // Reaching the end of the questions confirms nothing: the manual stays unconfirmed until the tap.
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
    await fireEvent.press(screen.getByRole('button', { name: 'Start building' }))
    await waitFor(() => expect(controller.current?.session.reviewStatus).toBe('reviewed'))
    expect(controller.getSnapshot().route).toBe('guide')
})

it('asks one honest question at a time: orientation first, then visible checks, from the cited step', async () => {
    const session = partlyResolvedManual()
    const { controller } = await renderManual(session)
    const orientationCited = session.reviewedSteps[0]!.sourceRefs
    const checksCited = session.reviewedSteps[1]!.sourceRefs
    expect(screen.getByText('Question 1 of 2', hidden)).toBeTruthy()
    expect(screen.getByText('Which way should it face?')).toBeTruthy()
    expect(screen.getByText('The manual says: Arrow is not visible.')).toBeTruthy()
    // No guessed answer is offered: there is nothing to say Yes to. The default card has no form, picker or text box.
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull()
    expect(screen.queryByText('Part: Side panel')).toBeNull()
    expect(screen.queryByLabelText(QUESTION)).toBeNull()
    expect(screen.queryByLabelText(CHECKS)).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    await openFix()
    expect(screen.getByText('Part: Side panel')).toBeTruthy()
    expect(screen.queryByLabelText(CHECKS)).toBeNull()

    await fireEvent.changeText(screen.getByLabelText(QUESTION), '  Groove faces inward toward the divider.  ')
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.current?.session.revision).toBe(2))
    expect(controller.current?.session.reviewedSteps[0]?.orientation).toEqual({
        state: 'known',
        value: { partId: 'side-panel', description: 'Groove faces inward toward the divider.' },
        sourceRefs: orientationCited,
    })
    // The next question is the missing visible checks; confirmation is still closed, and the count carries on:
    // accepting a revision does not turn question 2 of 2 into question 1 of 1.
    expect(await screen.findByText('What should you see?')).toBeTruthy()
    expect(screen.getByText('Question 2 of 2', hidden)).toBeTruthy()
    expect(screen.queryByText('Question 1 of 1', hidden)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start building' })).toBeNull()

    await openFix()
    await fireEvent.changeText(screen.getByLabelText(CHECKS), 'The groove is visible.\n\n  Divider edge is seated.  \n')
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.current?.session.revision).toBe(3))
    const checks = controller.current?.session.reviewedSteps[1]?.visibleChecks ?? []
    expect(checks.map((check) => check.description)).toEqual([
        { state: 'known', value: 'The groove is visible.', sourceRefs: checksCited },
        { state: 'known', value: 'Divider edge is seated.', sourceRefs: checksCited },
    ])
    expect(new Set(checks.map((check) => check.checkId)).size).toBe(2)

    // Every fact is resolved, but the whole manual is confirmed only by the explicit tap.
    expect(await screen.findByText('Thanks. Your steps are ready.')).toBeTruthy()
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
    await fireEvent.press(screen.getByRole('button', { name: 'Start building' }))
    await waitFor(() => expect(controller.current?.session.reviewStatus).toBe('reviewed'))
})

it('keeps typed drafts out of the facts', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    const before = structuredClone(controller.current?.session)
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(QUESTION), 'Groove faces inward.')
    expect(controller.current?.session).toEqual(before)
    expect(screen.queryByRole('button', { name: 'Start building' })).toBeNull()
})

it('requires an explicit part choice when several parts could carry the orientation cue', async () => {
    const session = partlyResolvedManual()
    session.reviewedSteps[0]!.orientation = {
        state: 'known',
        value: { partId: 'side-panel', description: 'Upright.' },
        sourceRefs: session.reviewedSteps[0]!.sourceRefs,
    }
    session.reviewedSteps[1]!.orientation = { state: 'unknown', reason: 'Divider direction is hidden.' }
    const { controller } = await renderManual(session)
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(QUESTION), 'Divider sits square to the panel.')
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Choose the part first.')).toBeTruthy()
    expect(controller.current?.session.revision).toBe(1)
    await fireEvent.press(screen.getByRole('radio', { name: 'Divider shelf' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.current?.session.revision).toBe(2))
    expect(controller.current?.session.reviewedSteps[1]?.orientation).toMatchObject({
        state: 'known',
        value: { partId: 'divider', description: 'Divider sits square to the panel.' },
    })
})

it.each([
    ['orientation', QUESTION, '   ', 'Write a few words first.'],
    ['visible checks', CHECKS, ' \n  \n', 'Write at least one thing, one per line.'],
])('rejects blank %s inline without saving anything', async (kind, label, draft, message) => {
    const session = partlyResolvedManual()
    if (kind === 'visible checks') {
        session.reviewedSteps[0]!.orientation = {
            state: 'known',
            value: { partId: 'side-panel', description: 'Upright.' },
            sourceRefs: session.reviewedSteps[0]!.sourceRefs,
        }
    }
    const { controller } = await renderManual(session)
    const before = structuredClone(controller.current?.session)
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(label), draft)
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(message)).toBeTruthy()
    expect(controller.current?.session).toEqual(before)
    expect(screen.getByLabelText(label).props.value).toBe(draft)
})

it('skipping keeps the gate closed and can be taken back', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    await fireEvent.press(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.getByText('What should you see?')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.getByText('One thing still needs a clearer photo before we can check your work.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start building' })).toBeNull()
    expect(controller.current?.session.reviewStatus).toBe('unreviewed')
    await fireEvent.press(screen.getByRole('button', { name: 'Answer skipped questions' }))
    expect(screen.getByText('Which way should it face?')).toBeTruthy()
})

it('Cancel closes the editor, discards the draft and accepts nothing', async () => {
    const { controller } = await renderManual(partlyResolvedManual())
    const before = structuredClone(controller.current?.session)
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(QUESTION), 'Groove faces inward.')
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText(QUESTION)).toBeNull()
    expect(controller.current?.session).toEqual(before)
    expect(screen.getByText('Question 1 of 2', hidden)).toBeTruthy()
    await openFix()
    expect(screen.getByLabelText(QUESTION).props.value).toBe('')
})

it('a rejected accept keeps the draft for correction and shows the controller notice in plain words', async () => {
    const session = partlyResolvedManual()
    session.reviewedSteps[0]!.orientation = {
        state: 'known',
        value: { partId: 'side-panel', description: 'Upright.' },
        sourceRefs: session.reviewedSteps[0]!.sourceRefs,
    }
    const { controller } = await renderManual(session)
    const tooLong = 'x'.repeat(501)
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(CHECKS), tooLong)
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.getSnapshot().notice).not.toBeNull())
    expect(screen.getByText('That does not fit this step. Check the part and keep it under 500 letters.')).toBeTruthy()
    expect(screen.queryByText(controller.getSnapshot().notice ?? '')).toBeNull()
    expect(screen.getByLabelText(CHECKS).props.value).toBe(tooLong)
    expect(controller.current?.session.revision).toBe(1)
})

it('a failed save shows a plain notice, promotes no fact and keeps the draft', async () => {
    const { controller, kv } = await renderManual(partlyResolvedManual())
    const before = structuredClone(controller.current?.session)
    kv.setItem = async (): Promise<never> => {
        throw new Error('Disk full')
    }
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(QUESTION), 'Groove faces inward.')
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(true))
    expect(screen.getByText('We could not save on this device. Your earlier work is safe. Try again.')).toBeTruthy()
    expect(controller.current?.session).toEqual(before)
    expect(screen.getByLabelText(QUESTION).props.value).toBe('Groove faces inward.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
})

it('explains plainly that a step without a cited manual page needs a clearer photo, and asks nothing for it', async () => {
    const session = partlyResolvedManual()
    session.reviewedSteps[0]!.sourceRefs = []
    await renderManual(session)
    expect(screen.getByText('One thing still needs a clearer photo before we can check your work.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add clearer photos' })).toBeTruthy()
    expect(screen.queryByLabelText(QUESTION)).toBeNull()
})

it('a revision change discards unaccepted drafts from the previous revision', async () => {
    const session = partlyResolvedManual()
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
    await openFix()
    await fireEvent.changeText(screen.getByLabelText(QUESTION), 'Groove is visible.')
    await rerender(view(2))
    expect(screen.getByLabelText(QUESTION).props.value).toBe('')
})

it('treats a fact it cannot fill from here (an unclear part name) as needing a clearer photo, listed plainly in More', async () => {
    const session = unreviewedDemo()
    session.parts[0]!.name = { state: 'unknown', reason: 'The part name is not readable.' }
    await renderManual(session)
    expect(screen.getByText('One thing still needs a clearer photo before we can check your work.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start building' })).toBeNull()
    await openMore()
    expect(
        within(screen.getByTestId('more-sheet')).getByText(/A part name is unclear: The part name is not readable\./u),
    ).toBeTruthy()
    expect(JSON.stringify(screen.toJSON())).not.toContain('Part ID')
})

it('lists reading notes and every step plainly in More, without part ids or system words', async () => {
    const session = unreviewedDemo()
    session.rawExtraction = {
        parts: session.parts,
        steps: session.reviewedSteps,
        unknowns: ['Packaging colour could not be read.'],
    }
    await renderManual(session)
    await openMore()
    const more = within(screen.getByTestId('more-sheet'))
    expect(more.getByText('Things we could not read')).toBeTruthy()
    expect(more.getByText('Packaging colour could not be read.')).toBeTruthy()
    expect(more.getByText('1. Stand the side panel upright')).toBeTruthy()
    expect(more.getAllByText(/^Which way it faces: /u).length).toBeGreaterThan(0)
    expect(more.getAllByText(/^1\. Look for: /u).length).toBeGreaterThan(0)
    const tree = JSON.stringify(screen.toJSON())
    for (const banned of ['Unresolved', 'Part ID', 'Quantity basis', 'Confirm reviewed facts', 'cited page']) {
        expect(tree).not.toContain(banned)
    }
})

it('shows server provenance and model notes only behind About this check', async () => {
    const session = unreviewedDemo()
    session.rawExtraction = {
        parts: session.parts,
        steps: session.reviewedSteps,
        unknowns: [],
        model: 'muse-wonder-1.0',
        modelNotes: ['Manual parsed with Wonder.'],
    }
    await renderManual(session)
    expect(screen.queryByText('Model: muse-wonder-1.0', hidden)).toBeNull()
    await openMore()
    expect(screen.queryByText('Model: muse-wonder-1.0')).toBeNull()
    await fireEvent.press(screen.getByTestId('judge-entry'))
    expect(screen.getByText('Model: muse-wonder-1.0')).toBeTruthy()
    expect(screen.getByText('Model note: Manual parsed with Wonder.')).toBeTruthy()
})

it('retains the saved builds during a transient restore failure and offers an explicit nondestructive retry', async () => {
    const session = createDemoManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage, kv } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await render(<Screens controller={controller} />)
    const originalGet = kv.getItem
    kv.getItem = async (): Promise<never> => {
        throw new Error('Temporary IO failure')
    }
    await act(async () => {
        await controller.restore()
    })
    expect(controller.getSnapshot().storageReadOnly).toBe(true)
    expect(screen.getByText(session.title)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    kv.getItem = originalGet
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(controller.getSnapshot().storageReadOnly).toBe(false))
    expect(screen.getByText(session.title)).toBeTruthy()
})

it.each([
    ['Manual reading unavailable (provider_error). Check your connection.', true],
    ['Local library images could not be read. Original data is retained.', true],
    ['Cancelled. No late reply will be shown. Retry is a new request.', false],
    ['Review every fact against the page diagrams before confirming.', false],
])('notice tone reads failures as errors and progress or cancellation as information: %s', (text, problem) => {
    expect(isProblemNotice(text)).toBe(problem)
})

it('maps controller notices to plain words and never repeats a recovery that does not exist', () => {
    expect(plainNotice('Cancelled. No late reply will be shown. Retry is a new request.')).toBe(
        'Stopped, so nothing more will be shown.',
    )
    expect(plainNotice('Review and confirm the extracted facts first.')).toBe(
        'Answer the quick questions first, then you can check your work.',
    )
    // The controller refuses an over-long manual and the app does not split it, so the words must not promise a split.
    const split = plainNotice(PARSE_SPLIT_MESSAGE)
    expect(split).toBe('We can read 12 pages at a time. Remove a few pages and try again.')
    expect(split).not.toMatch(/rest|later|split/iu)
    expect(plainNotice('Read up to 8 pages at a time. Split this manual into sections of 8 pages or fewer.')).toBe(
        'We can read 8 pages at a time. Remove a few pages and try again.',
    )
    // Unknown text is never shown raw.
    expect(plainNotice('Cannot verify: something internal about the frozen photo')).not.toMatch(/frozen|verify/iu)
    expect(plainNotice('A string nobody mapped')).toBe('Something went wrong. Please try again.')
})

it('shows controller notices through PlainNotice in plain words, as errors or information', async () => {
    const { controller } = setup()
    controllers.push(controller)
    const view = (notice: string): ReactElement => (
        <PlainNotice state={{ ...controller.getSnapshot(), notice }} controller={controller} />
    )
    const { rerender } = await render(view('Unavailable (provider_error). Check connection/configuration.'))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('We could not reach the checker. Try again.')).toBeTruthy()
    await rerender(view('Cancelled. No late reply will be shown. Retry is a new request.'))
    expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the restoring state while the local library loads, before any manual is listed', async () => {
    const { controller } = setup()
    controllers.push(controller)
    expect(controller.getSnapshot().loading).toBe(true)
    await render(<LibraryScreen state={controller.getSnapshot()} controller={controller} />)
    expect(screen.getByLabelText('Opening your manuals')).toBeTruthy()
    expect(screen.queryByText('Build furniture with step-by-step help.')).toBeNull()
})

it('settings explain storage, what leaves the phone and camera access, with counts from the real library', async () => {
    const session = createDemoManual()
    const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
    const { controller, storage } = setup(entry)
    controllers.push(controller)
    await storage.save([entry], [{ assetId: session.pages[0]!.assetId, bytes: new Uint8Array([1]) }])
    await controller.restore()
    await render(<SettingsScreen state={controller.getSnapshot()} />)
    expect(screen.getByText('1 build is saved on this device.')).toBeTruthy()
    expect(screen.getByText('What leaves this device')).toBeTruthy()
    expect(screen.getByText(PRIVACY_COPY.check)).toBeTruthy()
    expect(screen.getByText(PRIVACY_COPY.read)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open device settings' })).toBeTruthy()
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)
    try {
        await fireEvent.press(screen.getByRole('button', { name: 'Open device settings' }))
        expect(openSettings).toHaveBeenCalledTimes(1)
    } finally {
        openSettings.mockRestore()
    }
})

it('a successful answer after a refused check never shows a "Looks right" verdict, and the check verdict stays refused', async () => {
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
    expect(screen.getByText('Not yet', { exact: true })).toBeTruthy()
    expect(screen.getByText('Answer', { exact: true })).toBeTruthy()
    expect(screen.getByText('It faces inward.')).toBeTruthy()
    expect(screen.queryByText('Looks right', { exact: true })).toBeNull()
})

it('shows the actual result producer, attempted second model and plain-text failure note beside the retained verdict when asked', async () => {
    await render(
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
        />,
    )
    expect(screen.getByText('Model: muse-spark-1.3')).toBeTruthy()
    expect(screen.getByText('Second opinion: muse-wonder-1.0 (unavailable)')).toBeTruthy()
    expect(screen.getByText('Model note: Second opinion unavailable. Primary result retained.')).toBeTruthy()
    expect(screen.getByText('Groove is obscured.')).toBeTruthy()
    expect(screen.getByText('Can’t tell')).toBeTruthy()
    expect(screen.queryByText('Looks right', { exact: true })).toBeNull()
})

it('shows neutral answer provenance when asked, and invents none for legacy results', async () => {
    const { rerender } = await render(
        <AnswerPanel
            answer={{
                answer: 'Read the marked edge.',
                sourceRefs: [],
                missingEvidence: [],
                model: 'muse-spark-1.3',
                modelNotes: ['The photo does not show the groove.'],
            }}
            session={createDemoManual()}
            pageUris={{}}
        />,
    )
    expect(screen.getByText('Model: muse-spark-1.3')).toBeTruthy()
    expect(screen.getByText('Model note: The photo does not show the groove.')).toBeTruthy()
    await rerender(
        <AnswerPanel
            answer={{ answer: 'Legacy answer.', sourceRefs: [], missingEvidence: [] }}
            session={createDemoManual()}
            pageUris={{}}
        />,
    )
    expect(screen.queryByText(/^Model:/)).toBeNull()
    expect(screen.queryByText(/^Model note:/)).toBeNull()
})

it('allows review of a cited adjustment without assembly-only questions', async () => {
    const session = createDemoManual()
    session.reviewStatus = 'unreviewed'
    session.rawExtraction = null
    const original = session.reviewedSteps[0]!
    session.reviewedSteps = [
        {
            ...original,
            kind: 'adjust',
            parts: [],
            orientation: { state: 'unknown', reason: 'No orientation specified.' },
            connection: { state: 'unknown', reason: 'No connection specified.' },
            visibleChecks: [],
        },
    ]
    const { controller } = setup()
    controllers.push(controller)
    await render(<OverviewScreen controller={controller} state={controller.getSnapshot()} entry={entryFor(session)} />)
    expect(screen.queryByLabelText(QUESTION)).toBeNull()
    expect(screen.getByRole('button', { name: 'Start building' })).toBeTruthy()
})

describe('StepDetails in plain words', () => {
    it('shows cited counts and chosen alternatives as manual information in one step', async () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        const sourceRefs = step.sourceRefs
        session.reviewedSteps = [
            {
                ...step,
                parts: [
                    {
                        ...step.parts[0]!,
                        quantity: { state: 'unknown', reason: 'User provides the item.' },
                        quantityBasis: { kind: 'user_supplied', sourceRefs },
                    },
                ],
                alternatives: [
                    { alternativeId: 'wall', title: 'Wall mount', description: 'Attach to the wall.', sourceRefs },
                    { alternativeId: 'floor', title: 'Floor mount', description: 'Rest on the floor.', sourceRefs },
                ],
                selectedAlternativeId: 'wall',
            },
        ]
        await render(<StepDetails session={session} index={0} />)
        expect(screen.getByText('Chosen way: Wall mount. Attach to the wall.')).toBeTruthy()
        expect(screen.getByText('Another way: Floor mount. Rest on the floor.')).toBeTruthy()
        expect(screen.getByText(/This one is supplied by you\./u)).toBeTruthy()
        expect(screen.getByText('Count from page 1.')).toBeTruthy()
        expect(screen.getAllByText('From page 1 of your manual.')).toHaveLength(3)
    })

    it('names the earlier step while retaining the carried number and its citation', async () => {
        const session = createDemoManual()
        session.reviewedSteps[1]!.parts[0]!.quantityBasis = {
            kind: 'carried_over',
            stepId: 'step-1',
            partId: 'side-panel',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        }
        await render(<StepDetails session={session} index={1} />)
        expect(screen.getByText('Side panel: 1 of these. Same count as step 1.')).toBeTruthy()
        expect(screen.getByText('Count from page 1.')).toBeTruthy()
    })
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
    const closeSheet = async (): Promise<void> => {
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
    }

    it('lets a person inspect a thumbnail at full width before reading the manual', async () => {
        const entry = pagesEntry(1)
        const { controller } = setup()
        controllers.push(controller)
        await render(
            <PagesScreen state={controller.getSnapshot()} entry={entry} controller={controller} choosePages={noop} />,
        )
        expect(screen.queryByTestId('more-sheet')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'View page 1' }))
        expect(screen.getByTestId('more-sheet')).toBeTruthy()
        await closeSheet()
        expect(screen.queryByTestId('more-sheet')).toBeNull()
    })

    it('shows the page count, and routes each page action with its original label from the page sheet', async () => {
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
        expect(screen.getByText('Page 2')).toBeTruthy()
        expect(screen.getByText('Page 2 of up to 20')).toBeTruthy()
        // Page tools are not on the default surface.
        expect(screen.queryByRole('button', { name: 'Remove page 2' })).toBeNull()
        const act1 = async (index: number, name: string): Promise<void> => {
            await fireEvent.press(screen.getByRole('button', { name: `View page ${index}` }))
            await fireEvent.press(screen.getByRole('button', { name }))
        }
        await fireEvent.press(screen.getByRole('button', { name: 'View page 1' }))
        expect(screen.getByRole('button', { name: 'Move page 1 up' }).props.accessibilityState.disabled).toBe(true)
        await closeSheet()
        await fireEvent.press(screen.getByRole('button', { name: 'View page 2' }))
        expect(screen.getByRole('button', { name: 'Move page 2 down' }).props.accessibilityState.disabled).toBe(true)
        await fireEvent.press(screen.getByRole('button', { name: 'Move page 2 up' }))
        expect(editPage).toHaveBeenLastCalledWith(1, 'up')
        await act1(1, 'Move page 1 down')
        expect(editPage).toHaveBeenLastCalledWith(0, 'down')
        await act1(2, 'Remove page 2')
        expect(editPage).toHaveBeenLastCalledWith(1, 'remove')
        await act1(1, 'Retake page 1')
        expect(camera).toHaveBeenLastCalledWith({ kind: 'page', replaceIndex: 0 })
        await act1(2, 'Replace page 2 from photos')
        expect(choosePages).toHaveBeenLastCalledWith(1)
        // With pages added, adding another is the quiet secondary and offers the same two ways.
        await fireEvent.press(screen.getByRole('button', { name: 'Add a page' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Take photo' }))
        expect(camera).toHaveBeenLastCalledWith({ kind: 'page' })
        await fireEvent.press(screen.getByRole('button', { name: 'Add a page' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Choose pages from photos' }))
        expect(choosePages).toHaveBeenLastCalledWith()
        await fireEvent.press(screen.getByRole('button', { name: 'Read my manual' }))
        expect(parse).toHaveBeenCalledWith('en')
        expect(parse).toHaveBeenCalledTimes(1)
    })

    it('puts the privacy sentence and the name field in More, and keeps one primary on the surface', async () => {
        const { controller } = setup()
        controllers.push(controller)
        await render(
            <PagesScreen
                state={controller.getSnapshot()}
                controller={controller}
                entry={pagesEntry(1)}
                choosePages={noop}
            />,
        )
        expect(screen.queryByText(PRIVACY_COPY.stayOnDevice)).toBeNull()
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(2)
        await openMore()
        expect(screen.getByText(PRIVACY_COPY.stayOnDevice)).toBeTruthy()
        expect(screen.getByLabelText('Name this build')).toBeTruthy()
        expect(screen.getByRole('radio', { name: 'Spanish' })).toBeTruthy()
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
        expect(screen.getByRole('button', { name: 'Add a page' }).props.accessibilityState.disabled).toBe(true)
        expect(screen.getByRole('button', { name: 'Read my manual' }).props.accessibilityState.disabled).toBe(false)
        await fireEvent.press(screen.getByRole('button', { name: 'View page 20' }))
        expect(
            screen.getByRole('button', { name: 'Replace page 20 from photos' }).props.accessibilityState.disabled,
        ).toBe(false)
    })

    it.each([12, 13])(
        'warns only above the 12-page parse limit (%i pages), without claiming a split',
        async (count) => {
            const { controller } = setup()
            controllers.push(controller)
            await render(
                <PagesScreen
                    state={controller.getSnapshot()}
                    controller={controller}
                    entry={pagesEntry(count)}
                    choosePages={noop}
                />,
            )
            expect(
                screen.queryByText('We can read 12 pages at a time. Remove a few pages to read your manual.') !== null,
            ).toBe(count > 12)
        },
    )

    it('shows the empty page state with Take photo as the one primary and no skeleton until a read is pending', async () => {
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
        expect(screen.getByText('Take a photo of each page of your paper manual.')).toBeTruthy()
        expect(screen.queryByText('You can add up to 20 pages.')).toBeNull()
        expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Read my manual' })).toBeNull()
        expect(screen.queryByTestId('skeleton-block', hidden)).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
        expect(within(screen.getByTestId('more-sheet')).getByText('You can add up to 20 pages.')).toBeTruthy()
    })

    it.each(['Choosing manual pages…', 'Preparing page 1 of 2…', 'Saving manual pages…'])(
        'while importing pages (%s), shows a skeleton and pauses every page change',
        async (pending) => {
            const { controller } = setup()
            controllers.push(controller)
            const cancel = jest.spyOn(controller, 'cancel')
            const entry = pagesEntry(1)
            await render(
                <PagesScreen
                    state={{ ...controller.getSnapshot(), pending }}
                    controller={controller}
                    entry={entry}
                    choosePages={noop}
                />,
            )
            expect(screen.getAllByTestId('skeleton-block', hidden).length).toBeGreaterThan(0)
            expect(screen.queryByRole('button', { name: 'Read my manual' })).toBeNull()
            expect(screen.queryByRole('button', { name: 'Add a page' })).toBeNull()
            expect(screen.getByRole('button', { name: 'Adding photos…' }).props.accessibilityState).toMatchObject({
                disabled: true,
                busy: true,
            })
            await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }))
            expect(cancel).toHaveBeenCalledTimes(1)
        },
    )

    it.each(['Checking frozen photo…', 'Asking about frozen photo…', 'Second opinion pending (sample)…'])(
        'does not present another operation (%s) as a cancellable page import',
        async (pending) => {
            const { controller } = setup()
            controllers.push(controller)
            await render(
                <PagesScreen
                    state={{ ...controller.getSnapshot(), pending }}
                    controller={controller}
                    entry={pagesEntry(1)}
                    choosePages={noop}
                />,
            )
            expect(screen.queryByRole('button', { name: 'Adding photos…' })).toBeNull()
            expect(screen.queryByTestId('cancel-page-import')).toBeNull()
            expect(screen.getByRole('button', { name: 'Read my manual' }).props.accessibilityState.disabled).toBe(true)
        },
    )
})

it('continues with an unstated plural count and lets the user enter an optional count', async () => {
    const session = unreviewedDemo()
    session.reviewedSteps = [session.reviewedSteps[0]!]
    session.parts[0]!.name = { state: 'known', value: 'Batteries', sourceRefs: session.reviewedSteps[0]!.sourceRefs }
    session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'Manual gives no count.' }
    const rawBefore = structuredClone(session.rawExtraction)
    const { controller } = await renderManual(session)
    expect(screen.getByRole('button', { name: 'Start building' })).toBeTruthy()
    await openMore()
    expect(screen.getByText('Batteries: count not stated in the manual.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Count for Batteries (optional)'), '0')
    await fireEvent.press(screen.getByRole('button', { name: 'Save count for Batteries' }))
    expect(screen.getByText('Enter a positive whole number.')).toBeTruthy()
    expect(controller.current?.session.reviewedSteps[0]!.parts[0]!.quantity.state).toBe('unknown')
    await fireEvent.changeText(screen.getByLabelText('Count for Batteries (optional)'), '2')
    await fireEvent.press(screen.getByRole('button', { name: 'Save count for Batteries' }))
    await waitFor(() =>
        expect(controller.current?.session.reviewedSteps[0]!.parts[0]!.quantity).toMatchObject({
            state: 'known',
            value: 2,
        }),
    )
    expect(controller.current?.session.reviewedSteps[0]!.parts[0]!.quantityBasis?.kind).toBe('user_supplied')
    expect(await screen.findByText('Batteries: 2 of these. Count entered by you.')).toBeTruthy()
    expect(controller.current?.session.rawExtraction).toEqual(rawBefore)
})

it('production review counts list keeps unstated counts optional', async () => {
    const session = unreviewedDemo()
    session.reviewedSteps[0]!.parts[0]!.quantity = { state: 'unknown', reason: 'The manual gives no count.' }
    const { controller } = setup()
    controllers.push(controller)
    await render(<ReviewCounts session={session} controller={controller} busy={false} />)
    expect(screen.getByText('Side panel: count not stated in the manual.')).toBeTruthy()
    expect(screen.getByLabelText('Count for Side panel (optional)')).toBeTruthy()
})
