import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { WorkflowContext, type WorkflowValue } from '../capture/workflow-context'
import type { CheckStages } from '../capture/controller'
import { StagesPanel } from './attribution'
import { JudgeProvider } from './judge-context'
import { createJudgeStore } from './judge-store'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
const mockProof = { label: null as string | null }
jest.mock('./proof-mode', () => ({ proofEvidenceLabel: (): string | null => mockProof.label }))

const stages = {
    captureId: 'c1',
    overlay: { status: 'landed', elapsedMs: 410, model: 'muse-wonder-1.0', effort: 'max' },
    segments: { status: 'landed', elapsedMs: 880, modelElapsedMs: 5000, model: 'sam-3.1' },
    masks: [],
    verdictMs: 240,
} as unknown as CheckStages

async function panel(): Promise<void> {
    const store = createJudgeStore({ getItem: async () => null, setItem: async () => undefined })
    store.setShowBuilt(true)
    const workflow = { state: { primary: { model: 'muse-spark-1.3', deviceMs: 240 } } } as unknown as WorkflowValue
    const node: ReactElement = (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <WorkflowContext.Provider value={workflow}>
                    <JudgeProvider store={store}>
                        <StagesPanel
                            check={{ model: 'muse-wonder-1.0', decision: 'pass' }}
                            stages={stages}
                            resultSlot={undefined}
                        />
                    </JudgeProvider>
                </WorkflowContext.Provider>
            </FeedbackProvider>
        </ThemeProvider>
    )
    await render(node)
}

describe('the judge layer in a native proof run', () => {
    it('keeps naming the measured model and server time in an ordinary run', async () => {
        mockProof.label = null
        await panel()
        expect(screen.queryByText(/^Evidence:/u)).toBeNull()
        expect(screen.getByText('1. Verdict: muse-spark-1.3, 240 ms (measured on this phone)')).toBeTruthy()
        expect(screen.getByText(/server 5000 ms/u)).toBeTruthy()
        expect(screen.getByText(/Precise mask:.*model sam-3.1/u)).toBeTruthy()
        expect(screen.getByText(/Extra regions:.*model muse-wonder-1.0, effort max/u)).toBeTruthy()
    })

    it('says the IO was simulated, names no model, and labels every wait as the phone waiting, never the provider', async () => {
        mockProof.label = 'Simulated fixture · no model call'
        await panel()
        expect(screen.getByText('Evidence: Simulated fixture · no model call')).toBeTruthy()
        expect(
            screen.getByText('1. Verdict: Not recorded, 240 ms (phone wait on simulated IO, not provider time)'),
        ).toBeTruthy()
        expect(screen.queryByText(/muse-/u)).toBeNull()
        const mask = screen.getByText(/^\d\. Precise mask: /u)
        expect(mask.props.children).toContain('phone wait on simulated IO, not provider time')
        expect(mask.props.children).toContain('server Not recorded')
        expect(mask.props.children).not.toContain('5000')
        expect(screen.getByText(/^\d\. Extra regions: Landed after 410 ms \(phone wait on simulated IO/u)).toBeTruthy()
    })
})
