import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { View } from 'react-native'
import {
    createDemoManual,
    screenDocumentV2Schema,
    type AppIntent,
    type ScreenDocumentV2,
    type ScreenKindV2,
} from '@truebuild/contracts'
import { FeedbackProvider } from '../../ui/feedback'
import { ThemeProvider } from '../../theme/theme'
import type { ResolvedIntent } from '../screens/intents'
import { DocumentRoot } from './document-renderer'
import { sharedFallbackDocument } from './fallback-v2'
import type { FrameBindings } from './types'
import { hostsOutsideDocuments, type OwnershipTree } from './ownership-audit'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const session = createDemoManual()
const stepId = session.reviewedSteps[0]!.stepId

function bindings(): FrameBindings {
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
        resolveText: (ref) =>
            ref.kind === 'literal' ? ref.text : ref.kind === 'bound' && ref.key === 'manual-title' ? session.title : '',
    }
}

function wrap(node: ReactElement): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>{node}</FeedbackProvider>
        </ThemeProvider>
    )
}

const KINDS: readonly ScreenKindV2[] = [
    'home',
    'add',
    'pages',
    'reading',
    'quick-check',
    'guide',
    'result',
    'questions',
    'answer',
    'more',
    'completion',
    'error',
    'recovery',
    'camera',
    'judge',
    'compare',
]

function documentFor(kind: ScreenKindV2): ScreenDocumentV2 {
    const stepBound = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind)
    return sharedFallbackDocument({
        kind,
        session,
        stepId: stepBound ? stepId : null,
        captureId: kind === 'result' || kind === 'answer' ? 'fixture-held-photo' : null,
        result:
            kind === 'result'
                ? {
                      kind: 'check',
                      value: {
                          decision: 'pass',
                          reason: 'Synthetic result for ownership inspection.',
                          sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                          observedRegion: null,
                          missingEvidence: [],
                      },
                  }
                : kind === 'answer'
                  ? {
                        kind: 'question',
                        question: 'Synthetic ownership question',
                        value: {
                            answer: 'Synthetic answer for ownership inspection.',
                            sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                            missingEvidence: [],
                        },
                    }
                  : null,
        failure: kind === 'error' ? 'provider_error' : null,
        ...(kind === 'completion' ? { completedStepIds: session.reviewedSteps.map((step) => step.stepId) } : {}),
        ...(kind === 'camera'
            ? { uiState: { camera: { mode: 'build-photo' as const, permission: 'granted' as const } } }
            : {}),
    })
}

/**
 * Standalone validated catalog-root coverage. Production route/Modal ownership is separately proved by the actual
 * RootLayout positive and injected-stray regressions in navigation.test.tsx; this suite never substitutes for those.
 */
describe('standalone validated catalog ownership (not production route proof)', () => {
    it.each(KINDS)('%s: no host element outside a document marker', async (kind) => {
        const document = screenDocumentV2Schema.parse(documentFor(kind))
        await render(wrap(<DocumentRoot document={document} bindings={bindings()} />))
        expect(screen.getByTestId('document-screen')).toBeTruthy()
        expect(screen.getByTestId('bottom-bar')).toBeTruthy()
        expect(
            hostsOutsideDocuments(screen.container as unknown as OwnershipTree, new Set([document.screenId])),
        ).toEqual([])
    })

    it('detects an unmarked native host beside the document (the traversal can fail)', async () => {
        const document = screenDocumentV2Schema.parse(documentFor('guide'))
        await render(
            wrap(
                <>
                    <DocumentRoot document={document} bindings={bindings()} />
                    <View testID="native-leftover" />
                    <View nativeID="truebuild-document-root:forged" testID="forged-owner" />
                </>,
            ),
        )
        const failures = hostsOutsideDocuments(
            screen.container as unknown as OwnershipTree,
            new Set([document.screenId]),
        )
        expect(failures).toContain('View#native-leftover')
        expect(failures).toContain('View#forged-owner')
    })
})

describe('segment-joined ownership markers (regression)', () => {
    it('recognises an ownership segment joined with a render-origin segment; forged ids still fail', async () => {
        const document = screenDocumentV2Schema.parse(documentFor('home'))
        await render(
            wrap(
                <View nativeID={`truebuild-document-root:${document.screenId}|truebuild-render-origin:generated`}>
                    <View testID="inside-joined" />
                </View>,
            ),
        )
        const tree = screen.container as unknown as OwnershipTree
        expect(hostsOutsideDocuments(tree, new Set([document.screenId]))).not.toContain('View#inside-joined')
        const forged = hostsOutsideDocuments(
            {
                type: 'View',
                props: { nativeID: 'truebuild-document-root:forged|truebuild-render-origin:generated' },
                children: [{ type: 'View', props: { testID: 'x' }, children: [] }],
            } as OwnershipTree,
            new Set([document.screenId]),
        )
        expect(forged).toContain('View#x')
    })
})
