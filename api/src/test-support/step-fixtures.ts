import { createHash } from 'node:crypto'

import {
    createDemoManual,
    manualSessionSchema,
    type Fact,
    type ManualSession,
    type ManualStep,
    type SourceRef,
} from '@truebuild/contracts'
import sharp from 'sharp'

import type { CheckStepInput } from '../providers/meta-provider'

// Synthetic, product-neutral unit data. No recorded provider output, photo or real manual content.
export interface StepFixture {
    name: string
    session: ManualSession
    stepId: string
    /** A real part of the current step; the identity a valid region must carry. */
    partId: string
    /** A real part of the manual that does NOT belong to the current step. */
    otherPartId: string
    /** Reviewed correction action ids of the current step. */
    actionId: string
    /** Id of the first visible check of the current step. */
    checkId: string
}

function known<T>(value: T, pageId: string): Fact<T> {
    const refs: SourceRef[] = [{ pageId, region: null }]
    return { state: 'known', value, sourceRefs: refs }
}

function monitorArmManual(): ManualSession {
    const page1: SourceRef[] = [{ pageId: 'arm-page-1', region: null }]
    const page2: SourceRef[] = [{ pageId: 'arm-page-2', region: null }]
    const steps: ManualStep[] = [
        {
            stepId: 'arm-step-1',
            order: 1,
            title: 'Fit the bracket to the console post',
            parts: [
                { partId: 'post-bracket', quantity: known(1, 'arm-page-1') },
                { partId: 'bolt-m6', quantity: known(4, 'arm-page-1') },
            ],
            orientation: known(
                { partId: 'post-bracket', description: 'Slotted face points toward the user.' },
                'arm-page-1',
            ),
            connection: known(
                { partIds: ['post-bracket', 'bolt-m6'], description: 'Four bolts hold the bracket to the post.' },
                'arm-page-1',
            ),
            visibleChecks: [
                {
                    checkId: 'bracket-flush',
                    description: known('The bracket sits flush against the post.', 'arm-page-1'),
                },
            ],
            sourceRefs: page1,
            correction: {
                reviewed: true,
                actions: [
                    {
                        actionId: 'flip-bracket',
                        instruction: 'Turn the bracket so the slotted face points toward the user.',
                        sourceRefs: page1,
                    },
                ],
            },
        },
        {
            stepId: 'arm-step-2',
            order: 2,
            title: 'Slide the monitor arm onto the bracket',
            parts: [
                { partId: 'monitor-arm', quantity: known(1, 'arm-page-2') },
                { partId: 'post-bracket', quantity: known(1, 'arm-page-1') },
            ],
            orientation: known(
                { partId: 'monitor-arm', description: 'Arm extends away from the console.' },
                'arm-page-2',
            ),
            connection: known(
                { partIds: ['monitor-arm', 'post-bracket'], description: 'The arm hooks over the bracket slot.' },
                'arm-page-2',
            ),
            visibleChecks: [
                {
                    checkId: 'arm-hooked',
                    description: known('The arm is hooked fully over the bracket.', 'arm-page-2'),
                },
                { checkId: 'arm-level', description: known('The arm sits level.', 'arm-page-2') },
            ],
            sourceRefs: [...page1, ...page2],
            correction: {
                reviewed: true,
                actions: [
                    {
                        actionId: 'rehook-arm',
                        instruction: 'Lift the arm and hook it over the bracket again.',
                        sourceRefs: page2,
                    },
                ],
            },
        },
    ]
    const parts = [
        { partId: 'post-bracket', name: known('Post bracket', 'arm-page-1') },
        { partId: 'bolt-m6', name: known('M6 bolt', 'arm-page-1') },
        { partId: 'monitor-arm', name: known('Monitor arm', 'arm-page-2') },
    ]
    const page = (pageId: string, assetId: string): ManualSession['pages'][number] => ({
        pageId,
        assetId,
        width: 8,
        height: 4,
        mimeType: 'image/png',
        contentHash: '0'.repeat(64),
    })

    return manualSessionSchema.parse({
        manualId: 'treadmill-monitor-arm',
        title: 'Synthetic monitor arm',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        pages: [page('arm-page-1', 'arm-asset-1'), page('arm-page-2', 'arm-asset-2')],
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

/** Two unrelated manuals: a divider shelf (demo) and a treadmill monitor arm. */
export function stepFixtures(): StepFixture[] {
    return [
        {
            name: 'divider shelf',
            session: createDemoManual(),
            stepId: 'step-1',
            partId: 'side-panel',
            otherPartId: 'divider',
            actionId: 'turn-panel',
            checkId: 'groove-inward',
        },
        {
            name: 'treadmill monitor arm',
            session: monitorArmManual(),
            stepId: 'arm-step-2',
            partId: 'monitor-arm',
            otherPartId: 'bolt-m6',
            actionId: 'rehook-arm',
            checkId: 'arm-hooked',
        },
    ]
}

/** Gives every page distinct real PNG bytes and the matching content hash, then builds a provider check input. */
export async function checkInputFor(fixture: StepFixture, requestId = 'guidance-1'): Promise<CheckStepInput> {
    const session = structuredClone(fixture.session)
    const sourceImages: CheckStepInput['sourceImages'] = []
    for (const [index, page] of session.pages.entries()) {
        const bytes = await sharp({
            create: { width: 8, height: 4, channels: 3, background: { r: index * 40, g: 9, b: 9 } },
        })
            .png()
            .toBuffer()
        page.width = 8
        page.height = 4
        page.mimeType = 'image/png'
        page.contentHash = createHash('sha256').update(bytes).digest('hex')
        sourceImages.push({ page, bytes })
    }
    const observation = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#aaaaaa' } })
        .png()
        .toBuffer()

    return {
        requestId,
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: fixture.stepId,
            captureId: 'capture-1',
        },
        session,
        sourceImages,
        observation: { bytes: observation, mimeType: 'image/png', width: 8, height: 4 },
    }
}
