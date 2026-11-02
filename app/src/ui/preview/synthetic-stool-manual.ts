import {
    manualSessionSchema,
    type Fact,
    type ManualSession,
    type ManualStep,
    type SourceRef,
} from '@truebuild/contracts'

// A second, unrelated synthetic manual (parts, orientation and wording differ from the grooved-shelf sample) so the
// region and layout UI is proven against more than one manual. MOCKED fixture data: not a real product, not a recorded
// or live model output, and never physically verified.
export const SYNTHETIC_STOOL_LABEL = 'Camp stool · synthetic MOCKED manual'

const refs: SourceRef[] = [{ pageId: 'stool-page-1', region: null }]

function known<T>(value: T): Fact<T> {
    return { state: 'known', value, sourceRefs: refs.map((ref) => ({ ...ref })) }
}

export function syntheticStoolManual(): ManualSession {
    const steps: ManualStep[] = [
        {
            stepId: 'stool-step-1',
            order: 1,
            title: 'Clip the folding leg into the seat plate',
            parts: [
                { partId: 'folding-leg', quantity: known(1) },
                { partId: 'seat-plate', quantity: known(1) },
            ],
            orientation: known({ partId: 'folding-leg', description: 'The hinge notch faces the seat centre.' }),
            connection: known({
                partIds: ['folding-leg', 'seat-plate'],
                description: 'The leg clip snaps into the plate slot.',
            }),
            visibleChecks: [{ checkId: 'clip-snapped', description: known('The leg clip is fully snapped in.') }],
            sourceRefs: refs,
            correction: {
                reviewed: true,
                actions: [
                    {
                        actionId: 'flip-leg',
                        instruction: 'Flip the leg so the hinge notch faces inward.',
                        sourceRefs: refs,
                    },
                ],
            },
        },
        {
            stepId: 'stool-step-2',
            order: 2,
            title: 'Fasten the cross bolt',
            parts: [
                { partId: 'cross-bolt', quantity: known(2) },
                { partId: 'folding-leg', quantity: known(1) },
            ],
            orientation: known({ partId: 'cross-bolt', description: 'The bolt head sits on the outer face.' }),
            connection: known({
                partIds: ['cross-bolt', 'folding-leg'],
                description: 'The bolt passes through both leg tabs.',
            }),
            visibleChecks: [{ checkId: 'bolt-flush', description: known('The bolt head sits flush with the tab.') }],
            sourceRefs: refs,
            correction: null,
        },
    ]
    const parts = [
        { partId: 'folding-leg', name: known('Folding leg') },
        { partId: 'seat-plate', name: known('Seat plate') },
        { partId: 'cross-bolt', name: known('Cross bolt') },
    ]
    return manualSessionSchema.parse({
        manualId: 'synthetic-stool',
        title: SYNTHETIC_STOOL_LABEL,
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        pages: [
            {
                pageId: 'stool-page-1',
                assetId: 'stool-asset-1',
                width: 600,
                height: 400,
                mimeType: 'image/png',
                contentHash: '0'.repeat(64),
            },
        ],
        parts,
        // Extraction never carries a human-reviewed correction; only the reviewed steps do.
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

export const SYNTHETIC_PORTRAIT_LABEL = 'Camp stool, portrait scan · synthetic MOCKED manual'

/**
 * The stool manual again, but its one page is a portrait scan (400 x 600) instead of the 600 x 400 landscape page, so
 * portrait geometry is exercised with a page record whose size matches the art it points at. MOCKED fixture data.
 */
export function syntheticPortraitManual(): ManualSession {
    const session = syntheticStoolManual()
    session.manualId = 'synthetic-portrait'
    session.title = SYNTHETIC_PORTRAIT_LABEL
    for (const page of session.pages) {
        page.width = 400
        page.height = 600
    }
    return session
}
