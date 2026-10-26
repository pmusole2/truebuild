import {
    createDemoManual,
    type CheckResult,
    type ManualStep,
    type ParsedManual,
    type QuestionResult,
    type SegmentEvent,
} from '@truebuild/contracts'

import { createHeroResponse } from '@truebuild/contracts/hero'

import {
    DEMO_LABEL,
    type CheckInput,
    type FixtureProvider,
    type ParseInput,
    type QuestionInput,
    type SegmentInput,
    type SegmentResult,
} from './types'

function getStep(stepId: string): ManualStep {
    const step = createDemoManual().reviewedSteps.find((entry) => entry.stepId === stepId)

    if (!step) {
        throw new Error('Unsupported demo step')
    }

    return step
}

/** Deterministic synthetic metadata only: this provider has no network, images, model or environment access. */
export function createFixtureProvider(): FixtureProvider {
    return {
        async parse(_input: ParseInput): Promise<ParsedManual> {
            const demo = createDemoManual()

            return {
                parts: demo.parts,
                steps: demo.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [DEMO_LABEL],
            }
        },

        async check(input: CheckInput): Promise<CheckResult> {
            const step = getStep(input.binding.stepId)

            if (step.stepId === 'step-1') {
                return createHeroResponse(
                    input.scenario === 'wrong' ? 'reversed' : input.scenario === 'unclear' ? 'uncertain' : 'correct',
                )
            }

            if (input.scenario === 'unclear') {
                return {
                    decision: 'cannot_verify',
                    reason: `${DEMO_LABEL}. The chosen scenario has insufficient visible evidence.`,
                    sourceRefs: step.sourceRefs,
                    observedRegion: null,
                    missingEvidence: ['A clear view of the connection is required in this simulated scenario.'],
                }
            }

            return {
                decision: input.scenario === 'correct' ? 'pass' : 'refuse',
                reason: `${DEMO_LABEL}. ${
                    input.scenario === 'correct'
                        ? 'The selected correct scenario matches the demo step.'
                        : 'The selected wrong scenario differs from the demo orientation; use the reviewed correction.'
                }`,
                sourceRefs: step.sourceRefs,
                observedRegion: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
                missingEvidence: [],
            }
        },

        async question(input: QuestionInput): Promise<QuestionResult> {
            const step = getStep(input.binding.stepId)
            const subject = input.target.kind === 'part' ? input.target.partId : 'the selected demo point'

            return {
                answer: `${DEMO_LABEL}. For ${subject}, follow “${step.title}” and compare the cited source diagram.`,
                sourceRefs: step.sourceRefs,
                missingEvidence: [],
            }
        },

        async segment(input: SegmentInput): Promise<SegmentResult> {
            const events: SegmentEvent[] = []

            if (input.stream !== 'empty') {
                events.push({
                    type: 'snapshot',
                    snapshot: {
                        binding: input.binding,
                        streamId: 'demo-stream',
                        frameIndex: 0,
                        capturedAt: '2026-01-01T00:00:00.000Z',
                        records: [
                            {
                                objectId: 'demo-object-1',
                                label: `${DEMO_LABEL}: divider`,
                                box: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
                            },
                        ],
                        complete: input.stream === 'normal',
                    },
                })
            }

            events.push(
                input.stream === 'incomplete' ? { type: 'unavailable', code: 'invalid_output' } : { type: 'completed' },
            )

            return { label: DEMO_LABEL, transport: 'finite-json-precursor', events }
        },
    }
}
