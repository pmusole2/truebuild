import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    type StepMotionRequest,
} from '@truebuild/contracts'
import { GuideStepMotion } from './guide-step-motion'
import { motionRequestForStep } from './step-motion-registry'
import { DEMO_MODE, GENERATIVE_UI } from '../../config'
import { ModelApiClient } from '../../api/model-client'
import { DocumentRenderer } from '../documents/document-renderer'
import { sha256Hex } from '../documents/sha256'
import { ThemeProvider } from '../../theme/theme'
import type { FrameBindings } from '../documents/types'
import type * as RegistryModule from './step-motion-registry'

const mockGenerate = jest.fn(async (_request: StepMotionRequest) => ({ scene: null }))
const mockValues = new Map<string, string>()
const mockRequested = jest.fn()
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
        StepMotionRegistry: jest.fn((_storage, generate, canGenerate) => {
            const instance = new actual.StepMotionRegistry(
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
            )
            const load = instance.load.bind(instance)
            instance.load = (...args: Parameters<typeof load>): ReturnType<typeof load> => {
                mockRequested(args[0])
                return load(...args)
            }
            return instance
        }),
    }
})
jest.mock('./step-motion-hint', () => ({
    StepMotionHint: ({ fallback }: { fallback?: React.ReactNode }): React.ReactNode => fallback ?? null,
}))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

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

it('never requests motion from a different bound manual and keeps the manual image hero', async () => {
    mockGenerate.mockClear()
    mockRequested.mockClear()
    mockPermission = 'accepted'
    const session = { ...createDemoManual(), manualId: 'manual-motion-bound' }
    for (const page of session.pages) Object.assign(page, { width: 600, height: 800, mimeType: 'image/png' })
    const material = documentMaterialV2(
        {
            kind: 'guide',
            session,
            stepId: session.reviewedSteps[0]!.stepId,
            captureId: null,
            result: null,
            failure: null,
        },
        false,
    )
    const document = assembleDocumentV2(
        material,
        buildFallbackProposalV2(material),
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
        { sha256Hex, now: () => new Date('2026-02-03T04:05:06.000Z') },
    )
    const pageUri = 'data:image/png;base64,AQID'
    const bindings: FrameBindings = {
        session: { ...session, manualId: 'manual-motion-other' },
        pageUris: Object.fromEntries(session.pages.map((page) => [page.pageId, pageUri])),
        pageImageStatus: 'ready',
        resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
        live: null,
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
    }
    const ui = (current: FrameBindings): React.JSX.Element => (
        <ThemeProvider>
            <DocumentRenderer document={document} bindings={current} />
        </ThemeProvider>
    )
    const view = await render(ui(bindings))
    await act(async () => {})
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockRequested).not.toHaveBeenCalled()
    const hero = within(screen.getByTestId('guide-motion-hero'))
    await fireEvent(hero.getByTestId('guide-hero-picture'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 200 } },
    })
    expect(hero.getByLabelText('Picture from your manual').props.source.uri).toBe(pageUri)
    // Positive control: the same valid step/page reaches the actual registry when its manual binding matches.
    await view.rerender(ui({ ...bindings, session }))
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1))
    expect(mockGenerate.mock.calls[0]![0].stepId).toBe(session.reviewedSteps[0]!.stepId)
    expect(mockRequested).toHaveBeenCalledTimes(1)
})
