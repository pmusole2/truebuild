import treadmill from '../../../api/src/server/documents/fixtures/guide-wire-replay.json'
import furniture from '../../../app/src/features/documents/recorded/recorded-pages.inputs.json'
import drone from './fixtures/recorded-drone-step.json'

/** Existing recorded input sessions; the procedure additions are handwritten test data, never a fresh extraction. */
export const recordedDirectionCases = [
    {
        name: 'treadmill',
        provenance: 'Recorded manual extraction from guide-wire-replay.json; actions are handwritten fixture data.',
        session: treadmill.session,
        stepId: 'step-2-fix-handrail',
        instructions: [
            'Lift the handrail until it stands upright.',
            'Line up its holes with the holes in the base.',
            'Screw in both knobs and tighten them by hand.',
        ],
    },
    {
        name: 'drone',
        provenance:
            'Recorded manual extraction from .local/drone-run/out/session.json; actions are handwritten fixture data.',
        session: drone.session,
        stepId: 'step-1-install-fan-blades',
        instructions: [
            'Line up the blade’s hole with the motor shaft.',
            'Push the blade straight down until it sits flat.',
        ],
    },
    {
        name: 'furniture',
        provenance:
            'Recorded synthetic furniture fixture, not a real manual extraction; source app/src/features/documents/recorded/recorded-pages.inputs.json, evidence synthetic-fixture in recorded-pages.runtime.json. Actions are handwritten fixture data.',
        session: furniture.session,
        stepId: 'step-1',
        instructions: ['Stand the side panel upright.'],
    },
]
