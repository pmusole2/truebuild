import type { ApiResult, CheckResult, ManualSession } from '@truebuild/contracts'
import { createDemoManual } from '@truebuild/contracts'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { AssemblyScreen } from './assembly-screen'
import type { CheckRequest } from './check-state'

jest.mock('../manuals/local-store', () => ({
    localStore: { loadPageAsset: jest.fn(async (): Promise<null> => null) },
}))

const demo: ManualSession = createDemoManual()
const step = demo.reviewedSteps.find((candidate) => candidate.stepId === 'step-2')

const wrongResult: CheckResult = {
    decision: 'refuse',
    reason: 'Divider is not in the groove.',
    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
    observedRegion: null,
    missingEvidence: [],
}

function fixtureOk(request: CheckRequest): ApiResult<CheckResult> {
    return { status: 'ok', requestId: request.requestId, mode: 'fixture', binding: request.binding, value: wrongResult }
}

describe('AssemblyScreen fixture check', () => {
    it('labels every simulated result and sends exactly one request for a double tap', async () => {
        if (step === undefined) {
            throw new Error('demo step-2 is missing')
        }
        // The request stays open until released, so the second press lands while the first is in flight.
        let release: (result: ApiResult<CheckResult>) => void = () => undefined
        const runCheck = jest.fn<Promise<ApiResult<CheckResult>>, [CheckRequest]>(
            () =>
                new Promise((resolve) => {
                    release = resolve
                }),
        )
        const view = await render(
            <AssemblyScreen session={demo} step={step} runCheck={runCheck} onBack={() => undefined} />,
        )

        const run = view.getByRole('button', { name: 'Run check' })
        await fireEvent.press(run)
        await fireEvent.press(run)
        expect(runCheck).toHaveBeenCalledTimes(1)

        const request = runCheck.mock.calls[0]?.[0]
        if (request === undefined) {
            throw new Error('the check was not sent')
        }
        release(fixtureOk(request))
        await waitFor(() => expect(view.getByText('Refuse (simulated)')).toBeTruthy())
        expect(view.getAllByText('Demo data — simulated results').length).toBeGreaterThan(0)
    })

    it('shows live checks as unconfigured with no fixture verdict', async () => {
        if (step === undefined) {
            throw new Error('demo step-2 is missing')
        }
        const runCheck = jest.fn(async (request: CheckRequest): Promise<ApiResult<CheckResult>> => ({
            status: 'unavailable',
            requestId: request.requestId,
            binding: request.binding,
            code: 'unconfigured',
            retryable: false,
        }))
        const view = await render(
            <AssemblyScreen session={demo} step={step} runCheck={runCheck} onBack={() => undefined} />,
        )

        await fireEvent.press(view.getByRole('radio', { name: 'Live model' }))
        await fireEvent.press(view.getByRole('button', { name: 'Run check' }))

        await waitFor(() => expect(view.getByText(/Live checks are not configured/)).toBeTruthy())
        expect(view.queryByText('Refuse (simulated)')).toBeNull()
        expect(runCheck.mock.calls[0]?.[0].mode).toBe('model')
    })

    it('keeps the run action disabled for an unreviewed session', async () => {
        if (step === undefined) {
            throw new Error('demo step-2 is missing')
        }
        const draft: ManualSession = { ...demo, reviewStatus: 'unreviewed' }
        const runCheck = jest.fn(async (request: CheckRequest): Promise<ApiResult<CheckResult>> => fixtureOk(request))
        const view = await render(
            <AssemblyScreen session={draft} step={step} runCheck={runCheck} onBack={() => undefined} />,
        )

        expect(view.getByRole('button', { name: 'Run check' }).props.accessibilityState?.disabled).toBe(true)
    })

    it('labels unavailable fixture result with FIXTURE_LABEL in Result panel', async () => {
        if (step === undefined) {
            throw new Error('demo step-2 is missing')
        }
        const reviewed: ManualSession = { ...demo, manualId: 'imported-manual', reviewStatus: 'reviewed' }
        const runCheck = jest.fn(async (request: CheckRequest): Promise<ApiResult<CheckResult>> => ({
            status: 'unavailable',
            requestId: request.requestId,
            binding: request.binding,
            code: 'provider_error',
            retryable: true,
        }))
        const view = await render(
            <AssemblyScreen session={reviewed} step={step} runCheck={runCheck} onBack={() => undefined} />,
        )

        await fireEvent.press(view.getByRole('button', { name: 'Run check' }))
        await waitFor(() => expect(view.getByText('Demo data — simulated results')).toBeTruthy())
    })
})
