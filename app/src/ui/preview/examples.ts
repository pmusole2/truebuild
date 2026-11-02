// Static examples for the component preview only. They are synthetic labels and placeholder geometry: none of them is
// a manual, a photo, a model answer or a check result, and no preview control sends anything.
import type { NormalizedBox } from '@truebuild/contracts'
import type { StepListItem } from '../progress'
import type { Verdict } from '../status'

export const PREVIEW_BANNER =
    'Component preview. Static examples for review only: nothing here is a result or sends data.'

export const VERDICT_EXAMPLES: readonly {
    readonly verdict: Verdict
    readonly reason: string
    readonly missing?: readonly string[]
    readonly provenance?: string
}[] = [
    {
        verdict: 'pass',
        reason: 'The groove faces the divider, as the cited manual page shows.',
        provenance: 'Example result. Nothing was analysed.',
    },
    {
        verdict: 'refuse',
        reason: 'The side panel is reversed: the groove faces outward.',
    },
    {
        verdict: 'cannot_verify',
        reason: 'The side panel is not visible in this photo.',
        missing: ['inward-facing groove'],
    },
]

export const STEP_EXAMPLES: readonly StepListItem[] = [
    { id: 'upright', title: 'Stand the side panel upright', state: 'done' },
    { id: 'seat', title: 'Seat the divider in the groove', state: 'current' },
    { id: 'pins', title: 'Fit the shelf pins', state: 'upcoming' },
    { id: 'back', title: 'Attach the back panel', state: 'blocked' },
]

export const INSTRUCTION_EXAMPLE: readonly string[] = [
    'Stand the side panel upright.',
    'Keep the panel free before seating the divider.',
]

export const PART_EXAMPLES = [
    { id: 'side-panel', label: 'Side panel' },
    { id: 'divider', label: 'Divider shelf' },
] as const

// Placeholder region on a synthetic frame. It is not a detection.
export const SAMPLE_REGION: { readonly id: string; readonly label: string; readonly box: NormalizedBox } = {
    id: 'example-region',
    label: 'Example region',
    box: { x: 0.12, y: 0.22, width: 0.36, height: 0.4 },
}

// Mocked part guidance for the comparison example. Placeholder geometry only: no model located anything here.
export const PART_GUIDANCE_EXAMPLE = {
    nextPartRegion: { partId: 'divider', region: { x: 0.08, y: 0.55, width: 0.32, height: 0.3 } },
    targetRegion: { partId: 'divider', region: { x: 0.55, y: 0.2, width: 0.34, height: 0.3 } },
} as const

export const PART_GUIDANCE_NAMES: ReadonlyMap<string, string> = new Map([['divider', 'Divider shelf']])
