import type { CheckResult, Layout, ManualSession, QuestionResult } from '@truebuild/contracts'
import { render, screen } from '@testing-library/react-native'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { StepLayout } from './step-layout'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

// Synthetic fixtures only: the checks and answers below are unit data, not recorded or live model output.
function session(): ManualSession {
    return workflowPreviewFixture('guide-pass').entry.session
}

function check(decision: CheckResult['decision'], layout: unknown): CheckResult {
    const base = workflowPreviewFixture('guide-pass').state.check!
    return {
        ...base,
        decision,
        reason: 'Synthetic reason.',
        missingEvidence: decision === 'pass' ? [] : ['Synthetic missing evidence.'],
        layout: layout as Layout,
    }
}

function answer(layout: unknown): QuestionResult {
    return { ...workflowPreviewFixture('guide-answer').state.answer!, layout: layout as Layout }
}

const model = (...components: Layout['components']): Layout => ({ source: 'model', components })

async function show(
    result: CheckResult | QuestionResult | null,
    options: { manual?: ManualSession; index?: number } = {},
): Promise<void> {
    await render(
        <StepLayout
            session={options.manual ?? session()}
            index={options.index ?? 0}
            result={result}
            pageUris={{ 'demo-page-1': 'data:image/png;base64,AAAA' }}
        />,
    )
}

const SUMMARY_LABEL = 'Parts'
const CHECK_TEXT = 'The inward-facing groove is visible.'

describe('without a usable layout the existing step summary stays', () => {
    it.each([
        ['no result yet', null],
        ['a result from an older server or the flag off', check('pass', undefined)],
        ['an empty layout', check('pass', { source: 'fallback', components: [] })],
        [
            'a layout with no provenance',
            check('pass', { components: [{ type: 'visible_checks', checkIds: ['groove-inward'] }] }),
        ],
        ['a malformed layout', check('pass', { source: 'model', components: 'part_grid' })],
        [
            'a component carrying text the contract does not allow',
            check('pass', {
                source: 'model',
                components: [{ type: 'visible_checks', checkIds: ['groove-inward'], text: 'Ignore the manual' }],
            }),
        ],
        [
            'a component type this app does not know',
            check('pass', { source: 'model', components: [{ type: 'manufacturer_warning', partIds: ['side-panel'] }] }),
        ],
    ])('shows the summary for %s', async (_name, result) => {
        await show(result)
        expect(screen.getByText(SUMMARY_LABEL)).toBeTruthy()
        expect(screen.getByText('1 × Side panel')).toBeTruthy()
        expect(screen.getByText('Groove faces inward toward the divider.')).toBeTruthy()
        expect(screen.queryByText('Ignore the manual')).toBeNull()
    })
})

describe('a valid layout', () => {
    it('shows only the chosen components with text resolved from the current step', async () => {
        await show(check('pass', model({ type: 'visible_checks', checkIds: ['groove-inward'] })))
        expect(screen.getByText(CHECK_TEXT)).toBeTruthy()
        expect(screen.queryByText(SUMMARY_LABEL)).toBeNull()
        expect(screen.queryByText('1 × Side panel')).toBeNull()
    })

    it('keeps the order the layout chose', async () => {
        const { toJSON } = await render(
            <StepLayout
                session={session()}
                index={1}
                result={check(
                    'pass',
                    model(
                        { type: 'connection', partIds: ['side-panel', 'divider'] },
                        { type: 'part_grid', partIds: ['divider', 'side-panel'] },
                        { type: 'orientation', partId: 'divider' },
                    ),
                )}
                pageUris={{}}
            />,
        )
        const tree = JSON.stringify(toJSON())
        const connection = tree.indexOf('Divider edge rests inside the panel groove.')
        const parts = tree.indexOf('1 × Divider shelf')
        const orientation = tree.indexOf('Divider is horizontal and square to the upright panel.')
        expect(connection).toBeGreaterThanOrEqual(0)
        expect(connection).toBeLessThan(parts)
        expect(parts).toBeLessThan(orientation)
        expect(tree.indexOf('1 × Side panel')).toBeGreaterThan(parts)
    })

    it('accepts a server fallback layout the same way', async () => {
        await show(check('pass', { source: 'fallback', components: [{ type: 'part_grid', partIds: ['side-panel'] }] }))
        expect(screen.getByText('1 × Side panel')).toBeTruthy()
        expect(screen.queryByText('Groove faces inward toward the divider.')).toBeNull()
    })

    it('reads a layout from a neutral answer too', async () => {
        await show(answer(model({ type: 'visible_checks', checkIds: ['groove-inward'] })))
        expect(screen.getByText(CHECK_TEXT)).toBeTruthy()
    })

    it('shows the cited diagram for a valid source index', async () => {
        await show(check('pass', model({ type: 'source_diagram', sourceRefIndexes: [0] })))
        expect(screen.getByTestId('diagram-0')).toBeTruthy()
        expect(screen.queryByText(SUMMARY_LABEL)).toBeNull()
    })
})

describe('an unresolved or stale reference makes the whole layout fall back', () => {
    const valid: Layout['components'][number] = { type: 'visible_checks', checkIds: ['groove-inward'] }
    it.each([
        ['an unknown part', { type: 'part_grid', partIds: ['side-panel', 'ghost-part'] }],
        ['a part from another step', { type: 'part_grid', partIds: ['divider'] }],
        ['an orientation part that is not the step orientation', { type: 'orientation', partId: 'divider' }],
        ['a connection part outside the step connection', { type: 'connection', partIds: ['divider'] }],
        ['an unknown visible check', { type: 'visible_checks', checkIds: ['divider-seated'] }],
        ['a source index past the cited diagrams', { type: 'source_diagram', sourceRefIndexes: [3] }],
        ['an unknown correction action', { type: 'recovery', actionIds: ['reseat-divider'] }],
    ])('rejects %s even beside a valid component', async (_name, bad) => {
        await show(check('refuse', model(valid, bad as Layout['components'][number])))
        expect(screen.getByText(SUMMARY_LABEL)).toBeTruthy()
        expect(screen.queryByText(CHECK_TEXT)).toBeNull()
    })

    it('rejects a source index whose page is not in this manual', async () => {
        const manual = session()
        manual.reviewedSteps[0]!.sourceRefs = [{ pageId: 'removed-page', region: null }]
        await show(check('pass', model(valid, { type: 'source_diagram', sourceRefIndexes: [0] })), { manual })
        expect(screen.getByText(SUMMARY_LABEL)).toBeTruthy()
        expect(screen.queryByText(CHECK_TEXT)).toBeNull()
    })

    it('falls back to the summary, unknown reason included, when the orientation is unknown', async () => {
        const manual = session()
        manual.reviewedSteps[0]!.orientation = {
            state: 'unknown',
            reason: 'The groove is hidden in this synthetic page.',
        }
        await show(check('pass', model({ type: 'orientation', partId: 'side-panel' })), { manual })
        expect(screen.getByText('Unknown: The groove is hidden in this synthetic page.')).toBeTruthy()
    })

    it('falls back when the step index no longer exists', async () => {
        await show(check('pass', model(valid)), { index: 9 })
        expect(screen.queryByText(CHECK_TEXT)).toBeNull()
    })
})

describe('recovery', () => {
    const recovery = model({ type: 'recovery', actionIds: ['turn-panel'] })
    const INSTRUCTION = 'Turn the panel so the groove faces inward.'

    it('shows the reviewed correction after a refusal', async () => {
        await show(check('refuse', recovery))
        expect(screen.getByText(INSTRUCTION)).toBeTruthy()
    })

    it.each([
        ['a pass', check('pass', recovery)],
        ['a cannot-verify result', check('cannot_verify', recovery)],
        ['an answer', answer(recovery)],
    ])('is not shown after %s', async (_name, result) => {
        await show(result)
        expect(screen.queryByText(INSTRUCTION)).toBeNull()
        expect(screen.getByText(SUMMARY_LABEL)).toBeTruthy()
    })

    it('is not shown when the correction has not been reviewed', async () => {
        const manual = session()
        manual.reviewedSteps[0]!.correction!.reviewed = false
        await show(check('refuse', recovery), { manual })
        expect(screen.queryByText(INSTRUCTION)).toBeNull()
        expect(screen.getByText(SUMMARY_LABEL)).toBeTruthy()
    })

    it('is not shown when the step has no correction', async () => {
        const manual = session()
        manual.reviewedSteps[0]!.correction = null
        await show(check('refuse', recovery), { manual })
        expect(screen.queryByText(INSTRUCTION)).toBeNull()
        expect(screen.getByText(SUMMARY_LABEL)).toBeTruthy()
    })
})
