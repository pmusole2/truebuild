import { expect, it } from 'vitest'
import { STEP_MOTION_INSTRUCTIONS } from './step-motion-prompt'

it('keeps motion instructions generic, manual-first, finished-pose and fail-closed', () => {
    expect(STEP_MOTION_INSTRUCTIONS).not.toMatch(/treadmill|drone|shelf|furniture|fitness|handrail|propeller|brand/iu)
    expect(STEP_MOTION_INSTRUCTIONS).toContain('The manual first:')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('must never override the manual text or drawing')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('finished pose must match the manual drawing')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Before answering, check that it does')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('Return {scene:null}')
    expect(STEP_MOTION_INSTRUCTIONS).toContain('text and figure do not make the motion clear')
    expect(STEP_MOTION_INSTRUCTIONS).toContain(
        'Extrude bevel is nonnegative and at most 0.25 of the smallest of depth and the two outline spans',
    )
})
