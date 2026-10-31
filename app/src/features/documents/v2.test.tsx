import { createHash } from 'node:crypto'
import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { buildFallbackDocumentV2, createDemoManual, type AppIntent } from '@truebuild/contracts'
import { FeedbackProvider } from '../../ui/feedback'
import { ThemeProvider } from '../../theme/theme'
import type { ResolvedIntent } from '../screens/intents'
import { DocumentRenderer } from './document-renderer'
import type { FrameBindings } from './types'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const session = createDemoManual()
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

function bindings(overrides: Partial<FrameBindings> = {}): FrameBindings {
    return {
        resolve: (_intent: AppIntent): ResolvedIntent => ({ enabled: true, reason: null, run: () => undefined }),
        live: null,
        session,
        pageUris: {},
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
        judge: null,
        ...overrides,
    }
}

function wrap(node: ReactElement): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>{node}</FeedbackProvider>
        </ThemeProvider>
    )
}

/** The renderer consumes the real exported v2 contracts: The deterministic composer is the document source. */
describe('ScreenDocumentV2 through the native renderer', () => {
    it('renders a composed fallback guide document with header, body and one primary bar', async () => {
        const document = buildFallbackDocumentV2(
            {
                kind: 'guide',
                session,
                stepId: session.reviewedSteps[0]!.stepId,
                captureId: null,
                result: null,
                failure: null,
            },
            {
                sha256Hex,
                now: () => new Date('2026-01-01T00:00:00.000Z'),
                reason: 'disabled',
                evidence: 'local-deterministic',
            },
        )
        expect(document.kind).toBe('guide')
        expect(document.metadata.source).toBe('fallback')
        await render(wrap(<DocumentRenderer document={document} bindings={bindings()} />))
        expect(screen.getByTestId('document-screen')).toBeTruthy()
        expect(screen.getByTestId('bottom-bar')).toBeTruthy()
        expect(screen.getByText(document.bar.primary.label)).toBeTruthy()
    })

    it('keeps camera as its own v2 document kind, never Guide wording', async () => {
        const document = buildFallbackDocumentV2(
            {
                kind: 'camera',
                session,
                stepId: session.reviewedSteps[0]!.stepId,
                captureId: null,
                result: null,
                failure: null,
                uiState: { camera: { mode: 'build-photo', permission: 'granted' } },
            },
            {
                sha256Hex,
                now: () => new Date('2026-01-01T00:00:00.000Z'),
                reason: 'disabled',
                evidence: 'local-deterministic',
            },
        )
        expect(document.kind).toBe('camera')
        await render(wrap(<DocumentRenderer document={document} bindings={bindings()} />))
        expect(screen.getByTestId('document-screen')).toBeTruthy()
    })
})
