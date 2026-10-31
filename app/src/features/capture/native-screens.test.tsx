import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { Dimensions, Platform, StyleSheet } from 'react-native'
import type { NormalizedBox } from '@truebuild/contracts'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { cropFor, placeCrop, StepPicture } from './step-picture'
import { DoneScreen } from './done-screen'
import { GuideScreen } from './guide-screen'
import { OverviewScreen } from './review-screen'
import { ReadingScreen } from './reading-screen'
import { editableQuestions, otherBlockers } from './quick-check-model'
import {
    allStepsMarked,
    firstSentences,
    guideSentence,
    plainPending,
    plainReason,
    progressLine,
    stopFor,
} from './plain-copy'
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

    it.each([
        ['Manual reading timed out. Try again.', 'Reading took too long. Try again.'],
        ['Manual reading unavailable (provider_error). Try again.', 'We could not read those pages. Try again.'],
    ])('offers Try again and the actual reading failure: %s', async (notice, sentence) => {
        const fixture = reading()
        const parse = jest.fn(async () => undefined)
        const screenNav = nav()
        const controller: WorkflowController = { ...INERT_WORKFLOW_CONTROLLER, parse }
        await render(
            <ReadingScreen
                state={{
                    ...fixture.state,
                    pending: null,
                    notice,
                }}
                entry={fixture.entry}
                controller={controller}
                nav={screenNav}
            />,
        )
        expect(screen.getByText(sentence)).toBeTruthy()
        expect(screen.queryByText(/Check your connection/u)).toBeNull()
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
    const base = { check: null, answer: null, pending: null, capture: null, storageReadOnly: false, notice: null }

    it('keeps the first sentences of text exactly as returned', () => {
        expect(firstSentences('One. Two! Three? Four.', 2)).toBe('One. Two!')
        expect(firstSentences('Only one', 3)).toBe('Only one')
    })

    it.each([
        'Use Fig. 2 on p. 3 for the correct position.',
        'Use the narrow edge, e.g. the face beside the short slot, while you carefully align every remaining pin with its matching opening before moving the top piece.',
    ])('keeps an instruction containing abbreviations whole: %s', (answer) => {
        const state = workflowPreviewFixture('guide-answer').state
        expect(
            guideSentence({
                state: { ...state, answer: { ...state.answer!, answer } },
                step: fixture.entry.session.reviewedSteps[0],
                blocked: false,
            }).text,
        ).toBe(answer)
        expect(firstSentences(`${answer} Another sentence.`, 1)).toBe(answer)
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

    it('keeps a whole answer sentence of 15 words and adds a second only while the surface stays within 25 words', () => {
        const fifteen = 'Turn the panel so the groove faces inward toward the divider, as page one shows.'
        const ask = (text: string): string =>
            guideSentence({
                state: { ...base, answer: { answer: text, sourceRefs: [], missingEvidence: [] } },
                step: undefined,
                blocked: false,
            }).text
        expect(fifteen.split(' ')).toHaveLength(15)
        expect(ask(`${fifteen} Check it twice.`)).toBe(`${fifteen} Check it twice.`)
        expect(ask(`${fifteen} ${fifteen}`)).toBe(fifteen)
        expect(ask('One long sentence with no end')).toBe('One long sentence with no end')
    })

    it('drops only a fixture provenance prefix from a returned reason, never a factual clause', () => {
        expect(plainReason('Synthetic result: the groove faces inward.')).toBe('The groove faces inward.')
        expect(plainReason('Synthetic uncertainty: the groove is hidden.')).toBe('The groove is hidden.')
        expect(plainReason('The synthetic result was clear.')).toBe('The sample result was clear.')
        expect(plainReason('Frozen photo shows the groove.')).toBe('Your photo shows the groove.')
    })

    it('turns a generic failure with a kept photo into one warning sentence, and leaves specific recoveries alone', () => {
        const capture = fixture.state.capture
        const failed = { ...base, capture, notice: 'Check unavailable. Synthetic error.' }
        expect(guideSentence({ state: failed, step: undefined, blocked: false })).toEqual({
            kind: 'error',
            text: 'Something went wrong. Take a new photo to check this step.',
        })
        const specific = { ...base, capture, notice: 'Manual reading timed out' }
        expect(guideSentence({ state: specific, step: undefined, blocked: false }).kind).toBe('reference')
        const readOnly = { ...failed, storageReadOnly: true }
        expect(guideSentence({ state: readOnly, step: undefined, blocked: false }).kind).toBe('reference')
        expect(guideSentence({ state: failed, step: undefined, blocked: true }).kind).toBe('blocked')
    })

    it('never invents a result for a step that has none: the step name, or a plain blocked line', () => {
        const step = fixture.entry.session.reviewedSteps[0]
        expect(guideSentence({ state: base, step, blocked: false })).toEqual({ kind: 'ready', text: step!.title })
        expect(guideSentence({ state: base, step, blocked: true }).kind).toBe('blocked')
    })

    it('maps what is in flight to plain words without model names or request wording', () => {
        expect(plainPending('Reading manual pages…')).toBe('Reading your manual. This can take a minute.')
        expect(plainPending('Second opinion pending (muse-wonder-1.0)…')).toBe('Taking a closer look…')
        expect(plainPending('Still thinking about your question…')).toBe('Still thinking…')
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

const hidden = { includeHiddenElements: true }

describe('step picture and hero', () => {
    it.each([
        ['Guide', GuideScreen, 'guide-empty', 'guide-hero-picture'],
        ['Quick check', OverviewScreen, 'review-unresolved', 'guide-hero'],
        ['Done', DoneScreen, 'done-finished', 'done-hero'],
    ] as const)('keeps every same-page citation visible in %s', async (_name, Component, id, hero) => {
        const fixture = workflowPreviewFixture(id)
        const page = fixture.entry.session.pages[0]!
        const refs = [
            { pageId: page.pageId, region: { x: 0.05, y: 0.2, width: 0.1, height: 0.2 } },
            { pageId: page.pageId, region: { x: 0.85, y: 0.6, width: 0.1, height: 0.2 } },
        ]
        for (const step of fixture.entry.session.reviewedSteps) step.sourceRefs = refs
        await render(<Component state={fixture.state} entry={fixture.entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        await fireEvent(screen.getByTestId(hero), 'layout', {
            nativeEvent: { layout: { width: 300, height: 464 } },
        })
        const picture = StyleSheet.flatten(
            screen.getByLabelText('Picture from your manual', { includeHiddenElements: true }).props.style,
        )
        // The regions span most of this landscape page: protect the second citation rather than filling by cropping it.
        expect(picture.width).toBe(300)
        expect(picture.height).toBeCloseTo((300 * page.height) / page.width, 6)
        expect(picture.left).toBe(0)
    })
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

    it('fills a hero frame with the page, centred on the cited area, but keeps a thumbnail whole', async () => {
        const { entry, state } = workflowPreviewFixture('guide-empty')
        const { session } = entry
        const page = session.pages[0]!
        const imageStyle = (): Record<string, number> =>
            StyleSheet.flatten(screen.getByLabelText('Picture from your manual', hidden).props.style)
        const draw = async (props: { cover?: boolean; region: NormalizedBox | null }): Promise<void> => {
            await render(
                <StepPicture
                    reference={{ pageId: page.pageId, region: props.region }}
                    session={session}
                    pageUris={state.pageUris}
                    height={300}
                    testID="picture"
                    cover={props.cover}
                />,
            )
            await fireEvent(screen.getByTestId('picture'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 300 } },
            })
        }
        const scale = Math.max(300 / page.width, 300 / page.height)
        await draw({ cover: true, region: null })
        expect(imageStyle()).toMatchObject({ width: page.width * scale, height: page.height * scale })
        expect(imageStyle().left).toBeCloseTo((300 - page.width * scale) / 2, 6)
        await screen.unmount()
        // A cited area on the far right moves the crop there instead of cutting it.
        await draw({ cover: true, region: { x: 0.8, y: 0.3, width: 0.15, height: 0.3 } })
        expect(imageStyle().left).toBeCloseTo(300 - page.width * scale, 6)
        await screen.unmount()
        // Without cover (the camera thumbnail) the cited area is zoomed to as before.
        await draw({ region: null })
        expect(imageStyle().width).toBeCloseTo(Math.min(300, (300 * page.width) / page.height), 6)
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

    it.each([1, 3.4])(
        'uses the full Android viewport rather than a window reduced by system bars at scale %s',
        async (fontScale) => {
            mockWindow.height = 800
            mockWindow.fontScale = fontScale
            const platform = jest.replaceProperty(Platform, 'OS', 'android')
            const get = Dimensions.get.bind(Dimensions)
            const dimensions = jest.spyOn(Dimensions, 'get').mockImplementation((name) => ({
                ...get(name),
                ...(name === 'screen' ? { height: 900 } : {}),
            }))
            try {
                const fixture = workflowPreviewFixture('done-finished')
                await render(
                    <DoneScreen
                        state={fixture.state}
                        entry={fixture.entry}
                        controller={INERT_WORKFLOW_CONTROLLER}
                        nav={nav()}
                    />,
                )
                expect(StyleSheet.flatten(screen.getByTestId('done-hero').props.style).height).toBe(495)
            } finally {
                dimensions.mockRestore()
                platform.restore()
            }
        },
    )
})
