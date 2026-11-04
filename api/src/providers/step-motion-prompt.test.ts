import { expect, it } from 'vitest'
import { stepMotionResultSchema } from '@truebuild/contracts'
import { stepMotionOverlapIssues } from '../server/step-motion-geometry'
import { STEP_MOTION_INSTRUCTIONS, STEP_MOTION_EXAMPLE } from './step-motion-prompt'

it('keeps motion instructions generic, manual-first, finished-pose and fail-closed', () => {
    expect(STEP_MOTION_INSTRUCTIONS).not.toMatch(/treadmill|drone|shelf|furniture|fitness|handrail|propeller|brand/iu)
    expect(STEP_MOTION_INSTRUCTIONS).toContain('The manual first:')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('must never override the manual text or drawing')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('finished pose must match the manual drawing')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Before answering, check that it does')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('right-handed')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('local +Z from 0 to depth')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('radians in intrinsic XYZ order')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('previousScene')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Fasteners and knobs finish seated')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('A part that swings into place ends with its end seated in its bracket.')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Do not pull a seated fastener out to avoid overlap')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Preserve the original parts and their scale')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Return {scene:null}')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('text and figure do not make the motion clear')
    expect(STEP_MOTION_INSTRUCTIONS).toContain(
        'Extrude bevel is nonnegative and at most 0.25 of the smallest of depth and the two outline spans',
    )
})

it('embeds a schema-valid screw example with no deep overlap', () => {
    const scene = stepMotionResultSchema.parse(STEP_MOTION_EXAMPLE).scene!
    expect(STEP_MOTION_INSTRUCTIONS).toContain(JSON.stringify(STEP_MOTION_EXAMPLE))
    expect(stepMotionOverlapIssues(scene)).toEqual([])
})
