import { act, render, waitFor } from '@testing-library/react-native'
import { createDemoManual, type StepMotionRequest } from '@truebuild/contracts'
import { GuideStepMotion } from './guide-step-motion'
import { motionRequestForStep } from './step-motion-registry'
import { DEMO_MODE, GENERATIVE_UI } from '../../config'
import { ModelApiClient } from '../../api/model-client'
import type * as RegistryModule from './step-motion-registry'

const mockGenerate = jest.fn(async (_request: StepMotionRequest) => ({ scene: null }))
const mockValues = new Map<string, string>()
let mockPermission: 'accepted' | 'declined' | null = null

jest.mock('../../api/model-client', () => ({
    ModelApiClient: jest.fn(() => ({ stepMotion: mockGenerate })),
}))
jest.mock('../consent/consent-runtime', () => ({
    aiConsent: {
        restore: async (): Promise<void> => {},
        getSnapshot: (): { choice: 'accepted' | 'declined' | null } => ({ choice: mockPermission }),
    },
}))
jest.mock('./step-motion-registry', () => {
    const actual = jest.requireActual<typeof RegistryModule>('./step-motion-registry')
    return {
        ...actual,
        // Replace the native storage boundary. The real registry and its dispatch/cache logic run unchanged.
        StepMotionRegistry: jest.fn(
            (_storage, generate, canGenerate) =>
                new actual.StepMotionRegistry(
                    {
                        getItem: async (key: string): Promise<string | null> => mockValues.get(key) ?? null,
                        setItem: async (key: string, value: string): Promise<void> => {
                            mockValues.set(key, value)
                        },
                        removeItem: async (key: string): Promise<void> => {
                            mockValues.delete(key)
                        },
                        getAllKeys: async (): Promise<string[]> => [...mockValues.keys()],
                    },
                    generate,
                    canGenerate,
                ),
        ),
    }
})
jest.mock('./step-motion-hint', () => ({ StepMotionHint: (): null => null }))

it('requests only the displayed step, and revisiting a settled step never requests it again', async () => {
    const session = createDemoManual()
    expect(DEMO_MODE).toBe('model')
    expect(GENERATIVE_UI).not.toBe('off')
    const first = session.rawExtraction!.steps[0]!
    const second = session.rawExtraction!.steps[1]!
    expect(motionRequestForStep(session, first.stepId, 'request')).not.toBeNull()
    const pageUris = Object.fromEntries(session.pages.map((page) => [page.pageId, 'data:image/png;base64,AQID']))
    const ui = (stepId: string, active: boolean): React.JSX.Element => (
        <GuideStepMotion session={session} stepId={stepId} pageUris={pageUris} active={active} readOnly={false} />
    )
    const view = await render(ui(first.stepId, false))
    await act(async () => {})
    expect(mockGenerate).not.toHaveBeenCalled()
    await view.rerender(ui(first.stepId, true))
    expect(ModelApiClient).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockValues.size).toBe(0)
    await view.rerender(ui(first.stepId, false))
    mockPermission = 'declined'
    await view.rerender(ui(first.stepId, true))
    await act(async () => {})
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockValues.size).toBe(0)
    await view.rerender(ui(first.stepId, false))
    mockPermission = 'accepted'
    await view.rerender(ui(first.stepId, true))
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1))
    expect(mockGenerate.mock.calls[0]![0].stepId).toBe(first.stepId)
    await view.rerender(ui(second.stepId, false))
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    await view.rerender(ui(second.stepId, true))
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2))
    expect(mockGenerate.mock.calls[1]![0].stepId).toBe(second.stepId)
    await view.rerender(ui(first.stepId, true))
    await act(async () => {})
    expect(mockGenerate).toHaveBeenCalledTimes(2)
})
