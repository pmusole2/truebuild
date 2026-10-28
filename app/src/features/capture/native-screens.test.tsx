import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { cropFor, placeCrop } from './step-picture'
import { DoneScreen } from './done-screen'
import { ReadingScreen } from './reading-screen'
import { editableQuestions, otherBlockers } from './quick-check-model'
import { allStepsMarked, firstSentences, guideSentence, plainPending, progressLine, stopFor } from './plain-copy'
import { heroHeightFor } from './screen-layout'
import type { ScreenNav } from './screen-nav'
import type { WorkflowController } from './workflow-types'

const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 2 }),
}))
beforeEach(() => Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 }))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const nav = (overrides: Partial<ScreenNav> = {}): ScreenNav => ({
    openStop: jest.fn(),
    startBuilding: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
    allBuilds: jest.fn(),
    editPages: jest.fn(),
    leave: jest.fn(),
    back: jest.fn(),
    ...overrides,
})

describe('ReadingScreen', () => {
    const reading = (): ReturnType<typeof workflowPreviewFixture> => {
        const fixture = workflowPreviewFixture('pages-reading')
        return fixture
    }

    it('waits calmly with one quiet Cancel, no fake progress, and asks before stopping', async () => {
        const fixture = reading()
        const cancel = jest.fn()
        const screenNav = nav()
        const controller: WorkflowController = { ...INERT_WORKFLOW_CONTROLLER, cancel }
        await render(
            <ReadingScreen state={fixture.state} entry={fixture.entry} controller={controller} nav={screenNav} />,
        )
        expect(screen.getByText('Reading your manual. This can take a minute.')).toBeTruthy()
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
        expect(screen.queryByRole('progressbar')).toBeNull()
        const bar = within(screen.getByTestId('bottom-bar'))
        expect(bar.getAllByRole('button')).toHaveLength(1)
        await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }))
        expect(cancel).not.toHaveBeenCalled()
        expect(screen.getByText('Stop reading? You can start again.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Keep reading' }))
        expect(screen.getByText('Reading your manual. This can take a minute.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Stop reading' }))
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(screenNav.back).toHaveBeenCalledTimes(1)
    })

    it('offers one Try again with a plain sentence when reading failed, and a way back to the pages', async () => {
        const fixture = reading()
        const parse = jest.fn(async () => undefined)
        const screenNav = nav()
        const controller: WorkflowController = { ...INERT_WORKFLOW_CONTROLLER, parse }
        await render(
            <ReadingScreen
                state={{
                    ...fixture.state,
                    pending: null,
                    notice: 'Manual reading unavailable. Check your connection and retry.',
                }}
                entry={fixture.entry}
                controller={controller}
                nav={screenNav}
            />,
        )
        expect(screen.getByText('We could not read those pages. Check your connection and try again.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
        expect(parse).toHaveBeenCalledWith('en')
        await fireEvent.press(screen.getByRole('button', { name: 'Back to pages' }))
        expect(screenNav.back).toHaveBeenCalledTimes(1)
    })
})

describe('DoneScreen', () => {
    it('is calm and truthful: finished steps, never a claim that they were checked', async () => {
        const fixture = workflowPreviewFixture('done-finished')
        const screenNav = nav()
        await render(
            <DoneScreen
                state={fixture.state}
                entry={fixture.entry}
                controller={INERT_WORKFLOW_CONTROLLER}
                nav={screenNav}
            />,
        )
        expect(screen.getByText('You finished every step. Nice work.')).toBeTruthy()
        expect(screen.queryByText(/checked|verified/iu)).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Back to Home' }))
        expect(screenNav.leave).toHaveBeenCalledTimes(1)
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
    })
})

describe('plain words for the guide', () => {
    const fixture = workflowPreviewFixture('guide-pass')
    const base = { check: null, answer: null, pending: null, capture: null, storageReadOnly: false }

    it('keeps the first sentences of text exactly as returned', () => {
        expect(firstSentences('One. Two! Three? Four.', 2)).toBe('One. Two!')
        expect(firstSentences('Only one', 3)).toBe('Only one')
    })

    it('says the verdict word first and then the first reason sentence, for every decision', () => {
        const step = fixture.entry.session.reviewedSteps[0]
        const check = fixture.state.check!
        const say = (decision: typeof check.decision): string =>
            guideSentence({
                state: { ...base, check: { ...check, decision, reason: 'First. Second.' } },
                step,
                blocked: false,
            }).text
        expect(say('pass')).toBe('Looks right. First.')
        expect(say('refuse')).toBe('Not yet. First.')
        expect(say('cannot_verify')).toBe("We can't tell from this photo. First.")
    })

    it('shows an answer as the existing response text, in at most two sentences, with no verdict', () => {
        const answer = { answer: 'It faces in. Check the groove. Third sentence.', sourceRefs: [], missingEvidence: [] }
        const sentence = guideSentence({ state: { ...base, answer }, step: undefined, blocked: false })
        expect(sentence).toEqual({ kind: 'answer', text: 'It faces in. Check the groove.' })
    })

    it('never invents a result for a step that has none: the step name, or a plain blocked line', () => {
        const step = fixture.entry.session.reviewedSteps[0]
        expect(guideSentence({ state: base, step, blocked: false })).toEqual({ kind: 'ready', text: step!.title })
        expect(guideSentence({ state: base, step, blocked: true }).kind).toBe('blocked')
    })

    it('maps what is in flight to plain words without model names or request wording', () => {
        expect(plainPending('Reading manual pages…')).toBe('Reading your manual. This can take a minute.')
        expect(plainPending('Second opinion pending (muse-wonder-1.0)…')).toBe('Taking a second look…')
        expect(plainPending('Checking frozen photo…')).toBe('Checking your photo…')
        expect(plainPending(null)).toBeNull()
    })

    it('finds the furthest stop for a manual and says it plainly', () => {
        const entry = fixture.entry
        expect(stopFor(entry)).toBe('guide')
        expect(progressLine(entry)).toMatch(/^Step \d+ of \d+$/u)
        const finished = { ...entry, completedStepIds: entry.session.reviewedSteps.map((step) => step.stepId) }
        expect(allStepsMarked(finished)).toBe(true)
        expect(stopFor(finished)).toBe('done')
        expect(stopFor({ ...entry, session: { ...entry.session, reviewStatus: 'unreviewed' } })).toBe('overview')
        expect(
            stopFor({ ...entry, session: { ...entry.session, reviewStatus: 'unreviewed', rawExtraction: null } }),
        ).toBe('pages')
    })
})

describe('Quick check questions', () => {
    it('are exactly the facts acceptStepFacts can fill, in step order, and nothing else', () => {
        const { entry } = workflowPreviewFixture('review-unresolved')
        const questions = editableQuestions(entry.session)
        expect(questions.map((question) => question.kind)).toEqual(['orientation'])
        expect(questions[0]!.reason).toBe('The inward groove is obscured in this synthetic page.')
        expect(otherBlockers(entry.session)).toEqual([])
    })

    it('leaves a missing part name as a clearer-photo blocker, never a question', () => {
        const { entry } = workflowPreviewFixture('review-ready')
        entry.session.parts[0]!.name = { state: 'unknown', reason: 'Unreadable.' }
        expect(editableQuestions(entry.session)).toEqual([])
        expect(otherBlockers(entry.session)).toHaveLength(1)
    })
})

describe('step picture and hero', () => {
    it('crops to the cited region with a margin, or shows the whole page when nothing is cited', () => {
        expect(cropFor(null)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
        const crop = cropFor({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 })
        expect(crop.x).toBeLessThan(0.4)
        expect(crop.x + crop.width).toBeGreaterThan(0.6)
        expect(cropFor({ x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    })

    it('places a crop so it fills the frame as large as it fits, centred', () => {
        const placed = placeCrop(
            { width: 300, height: 200 },
            { width: 600, height: 400 },
            { x: 0, y: 0, width: 1, height: 1 },
        )
        expect(placed).toEqual({ left: 0, top: 0, width: 300, height: 200 })
        const zoomed = placeCrop(
            { width: 300, height: 200 },
            { width: 600, height: 400 },
            { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        )
        expect(zoomed.width).toBeCloseTo(600, 6)
        expect(zoomed.left).toBeCloseTo(-300, 6)
    })

    it('keeps the hero at 55 percent through accessibility text sizes and makes room only for an active editor keyboard', () => {
        expect(heroHeightFor(844, 1, false)).toBe(Math.round(844 * 0.55))
        expect(heroHeightFor(844, 1.5, false)).toBeGreaterThanOrEqual(Math.round(844 * 0.55))
        expect(heroHeightFor(844, 2, false)).toBe(Math.round(844 * 0.55))
        expect(heroHeightFor(844, 3.12, false)).toBe(Math.round(844 * 0.55))
        expect(heroHeightFor(844, 1, true)).toBeLessThan(Math.round(844 * 0.4))
    })

    it('draws the step picture inside a frame of the requested height', async () => {
        const fixture = workflowPreviewFixture('guide-empty')
        await render(
            <DoneScreen
                state={fixture.state}
                entry={fixture.entry}
                controller={INERT_WORKFLOW_CONTROLLER}
                nav={nav()}
            />,
        )
        expect(StyleSheet.flatten(screen.getByTestId('done-hero').props.style)).toMatchObject({
            height: Math.round(844 * 0.55),
        })
    })
})
