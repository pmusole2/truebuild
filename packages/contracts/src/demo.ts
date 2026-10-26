import { manualSessionSchema, type Fact, type ManualSession, type ManualStep, type SourceRef } from './index'

const refs: SourceRef[] = [{ pageId: 'demo-page-1', region: null }]

function known<T>(value: T): Fact<T> {
    return { state: 'known', value, sourceRefs: refs.map((ref) => ({ ...ref })) }
}

export function createDemoManual(): ManualSession {
    const steps: ManualStep[] = [
        {
            stepId: 'step-1',
            order: 1,
            title: 'Stand the side panel upright',
            parts: [{ partId: 'side-panel', quantity: known(1) }],
            orientation: known({ partId: 'side-panel', description: 'Groove faces inward toward the divider.' }),
            connection: known({
                partIds: ['side-panel'],
                description: 'Keep the panel free before seating the divider.',
            }),
            visibleChecks: [{ checkId: 'groove-inward', description: known('The inward-facing groove is visible.') }],
            sourceRefs: refs,
            correction: {
                reviewed: true,
                actions: [
                    {
                        actionId: 'turn-panel',
                        instruction: 'Turn the panel so the groove faces inward.',
                        sourceRefs: refs,
                    },
                ],
            },
        },
        {
            stepId: 'step-2',
            order: 2,
            title: 'Seat the divider in the groove',
            parts: [
                { partId: 'side-panel', quantity: known(1) },
                { partId: 'divider', quantity: known(1) },
            ],
            orientation: known({
                partId: 'divider',
                description: 'Divider is horizontal and square to the upright panel.',
            }),
            connection: known({
                partIds: ['side-panel', 'divider'],
                description: 'Divider edge rests inside the panel groove.',
            }),
            visibleChecks: [
                { checkId: 'divider-seated', description: known('Divider is fully seated with no visible gap.') },
            ],
            sourceRefs: refs,
            correction: {
                reviewed: true,
                actions: [
                    {
                        actionId: 'reseat-divider',
                        instruction: 'Lift the divider and reseat its edge inside the groove.',
                        sourceRefs: refs,
                    },
                ],
            },
        },
    ]
    const parts = [
        { partId: 'side-panel', name: known('Side panel') },
        { partId: 'divider', name: known('Divider shelf') },
    ]

    // Parsing produces independent data on every call and separates raw extraction from reviewed edits.
    return manualSessionSchema.parse({
        manualId: 'demo-divider',
        title: 'Demo data — simulated results',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        pages: [
            {
                pageId: 'demo-page-1',
                assetId: 'demo-asset-1',
                width: 1200,
                height: 900,
                mimeType: 'image/png',
                contentHash: '0'.repeat(64),
            },
        ],
        parts,
        rawExtraction: {
            parts,
            steps: steps.map((step) => ({
                ...step,
                correction: step.correction === null ? null : { ...step.correction, reviewed: false },
            })),
            unknowns: [],
        },
        reviewedSteps: steps,
        reviewStatus: 'reviewed',
    })
}
