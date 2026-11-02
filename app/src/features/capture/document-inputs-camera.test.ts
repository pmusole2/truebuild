import { describe, expect, it } from 'vitest'
import { entry, runtime, source } from '../screens/test-support/route-harness'
import { documentInputs } from './document-inputs'

describe('page camera document identity', () => {
    it.each(['page', 'check', 'question'] as const)(
        'excludes a held build photo from a %s camera and binds only an earned build step',
        async (kind) => {
            const { controller } = await runtime([entry()])
            try {
                await controller.restore()
                await controller.open('flow-manual', 'guide')
                controller.camera({ kind: 'check' })
                await controller.shutter(async () => source)
                const held = controller.getSnapshot()
                expect(held.capture).not.toBeNull()
                const inputs = documentInputs('camera', {
                    state: { ...held, cameraIntent: { kind } },
                    entry: controller.current,
                })
                expect(inputs.uiState?.camera?.mode).toBe(kind === 'page' ? 'manual-page' : 'build-photo')
                expect(inputs.stepId).toBe(kind === 'page' ? null : 'step-1')
                expect(inputs.captureId).toBeNull()
                expect(inputs.result).toBeNull()
                expect(inputs.uiState?.capture).toBeUndefined()
                expect(controller.getSnapshot().capture).toBe(held.capture)
            } finally {
                controller.dispose()
            }
        },
    )
    it('does not bind an unconfirmed stale working step to a build camera', async () => {
        const { controller } = await runtime([entry('unreviewed', 'unreviewed')])
        try {
            await controller.restore()
            await controller.open('unreviewed', 'overview')
            const inputs = documentInputs('camera', {
                state: { ...controller.getSnapshot(), cameraIntent: { kind: 'check' } },
                entry: controller.current,
            })
            expect(inputs.stepId).toBeNull()
            expect(inputs.captureId).toBeNull()
        } finally {
            controller.dispose()
        }
    })
})
