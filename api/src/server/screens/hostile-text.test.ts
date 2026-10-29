import { createDemoManual, SCREEN_KINDS, type ManualSession, type ScreenKind } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { aiPolicyFromEnvironment } from '../ai-policy'
import type { ScreenInputs } from './context'
import { createScreenService, type BackgroundWork } from './service'

// Manual text is data read from a photographed page, so it can contain anything. The deterministic composition is the
// path every failure falls back to: it must always publish a valid document and never alter a numeric comparison.
const work: BackgroundWork = {
    run: (_options, fn) => fn(),
    repair: (fn) => fn(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}
const service = createScreenService({
    provider: null,
    policy: aiPolicyFromEnvironment(
        {},
        {
            checkTimeoutMs: 8_000,
            parseModel: 'muse-spark-1.3',
            verdictModel: 'muse-spark-1.3',
            secondOpinionModel: 'muse-wonder-1.0',
        },
    ),
    runtimeMode: 'fixture',
    work,
})

const HOSTILE = [
    'Bolt <M6> https://example.com/x',
    'Use <b>care</b> now',
    'Cable `tie` [here](http://x.y)',
    'Panel\u0007 with a control character',
    'Part A <-> part B',
    'x'.repeat(61),
]

function hostileSession(text: string): ManualSession {
    const value = createDemoManual()
    const refs = [{ pageId: 'demo-page-1', region: null }]
    const known = <T>(item: T): { state: 'known'; value: T; sourceRefs: typeof refs } => ({
        state: 'known',
        value: item,
        sourceRefs: refs,
    })
    value.title = text
    value.parts = value.parts.map((part) => ({ ...part, name: known(text) }))
    for (const step of value.reviewedSteps) {
        step.title = text
        step.orientation = known({ partId: step.parts[0]!.partId, description: text })
        step.safetyNotes = [{ noteId: 'n1', note: known(text) }]
        step.visibleChecks = [{ checkId: 'c1', description: known(text) }]
    }
    return value
}

function inputsFor(kind: ScreenKind, manual: ManualSession): ScreenInputs {
    const needsStep = ['guide', 'result', 'questions', 'answer', 'recovery'].includes(kind)
    return {
        kind,
        session: ['home', 'add', 'pages', 'more', 'error'].includes(kind) ? null : manual,
        stepId: needsStep ? 'step-1' : null,
        captureId: kind === 'result' || kind === 'answer' ? 'capture-1' : null,
        result:
            kind === 'result'
                ? {
                      kind: 'check',
                      value: {
                          decision: 'refuse',
                          reason: 'Keep the load < 5 kg.',
                          sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                          observedRegion: null,
                          missingEvidence: [],
                      },
                  }
                : kind === 'answer'
                  ? {
                        kind: 'question',
                        question: 'Which way?',
                        value: { answer: 'Follow the diagram.', sourceRefs: [], missingEvidence: [] },
                    }
                  : null,
        failure: kind === 'error' ? 'timeout' : null,
    }
}

describe('deterministic composition of hostile manual text', (): void => {
    for (const text of HOSTILE) {
        it.each(SCREEN_KINDS)(`publishes a valid %s screen for ${JSON.stringify(text.slice(0, 24))}`, (kind): void => {
            const document = service.fallback(inputsFor(kind, hostileSession(text)), 'timeout')
            expect(document.kind).toBe(kind)
        })
    }
})

describe('numeric comparisons in deterministic text', (): void => {
    it('keeps a comparison the manual states in a guide title shown as an instruction', (): void => {
        const manual = createDemoManual()
        manual.reviewedSteps[0]!.title = 'Hold the load below 5 kg: keep it < 5 kg and > 2 kg'
        const document = service.fallback(inputsFor('guide', manual), 'timeout')
        const texts = document.body.flatMap((node) => (node.type === 'Instruction' ? [node.text] : []))
        expect(texts.join(' ')).toContain('keep it < 5 kg and > 2 kg')
    })

    it('keeps the manual reason a quick-check question is about, word for word', (): void => {
        const reason = 'Keep the load < 5 kg and > 2 kg.'
        const document = service.fallback(
            {
                ...inputsFor('quick-check', createDemoManual()),
                uiState: {
                    review: {
                        currentQuestion: {
                            questionId: 'q1',
                            kind: 'checks',
                            stepId: 'step-1',
                            stepOrder: 1,
                            reason,
                            parts: [],
                        },
                        blockers: 1,
                        canConfirm: false,
                    },
                },
            },
            'timeout',
        )
        const prompt = document.body.find((node) => node.type === 'FactPrompt')
        expect(prompt).toMatchObject({ detail: reason })
    })

    it('still removes markup, links and control characters', (): void => {
        const document = service.fallback(
            {
                ...inputsFor('home', createDemoManual()),
                session: { ...createDemoManual(), title: 'A <b>tidy</b> shelf http://x.y' },
            },
            'timeout',
        )
        expect(document.header.title).toBe('A btidy/b shelf')
    })
})
