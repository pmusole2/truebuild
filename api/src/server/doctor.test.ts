import { describe, expect, it, vi } from 'vitest'
import { doctor } from '../../scripts/doctor'

describe('explicit read-only Meta doctor', () => {
    it('refuses a missing key without network and always labels pricing as assumptions', async () => {
        const transport = vi.fn<typeof fetch>()
        const output: string[] = []
        expect(await doctor({}, transport, (line) => output.push(line))).toBe(2)
        expect(transport).not.toHaveBeenCalled()
        expect(output.join(' ')).toContain('pricing_assumptions')
        expect(output.join(' ')).toContain('local_key_required')
    })
    it.each([true, false])(
        'makes exactly one fixed GET and validates both configured IDs, samPresent=%s',
        async (samPresent) => {
            const transport = vi.fn<typeof fetch>(async (url, init) => {
                expect(url).toBe('https://api.meta.ai/v1/models')
                expect(init?.method).toBe('GET')
                expect(init?.redirect).toBe('error')
                return Response.json({
                    object: 'list',
                    data: [
                        { id: 'muse-spark-1.3' },
                        { id: 'muse-wonder-1.0' },
                        ...(samPresent ? [{ id: 'sam-3.1' }] : []),
                    ],
                })
            })
            const output: string[] = []
            expect(
                await doctor(
                    {
                        MODEL_API_KEY: '<synthetic>',
                        MODEL_PARSE: 'muse-wonder-1.0',
                        MODEL_SECOND_OPINION: 'muse-wonder-1.0',
                    },
                    transport,
                    (line) => output.push(line),
                ),
            ).toBe(samPresent ? 0 : 2)
            expect(transport).toHaveBeenCalledTimes(1)
            expect(output.join(' ')).not.toContain('<synthetic>')
        },
    )
    it.each([400, 404, 503])('sanitizes status %i and never repeats the model-list call', async (status) => {
        const transport = vi.fn<typeof fetch>(async () => new Response('sensitive upstream message', { status }))
        const output: string[] = []
        expect(await doctor({ MODEL_API_KEY: '<synthetic>' }, transport, (line) => output.push(line))).toBe(2)
        expect(transport).toHaveBeenCalledTimes(1)
        expect(output.join(' ')).not.toContain('sensitive')
    })
})

it.each(['MODEL_SPARK', 'MODEL_PARSE', 'MODEL_SECOND_OPINION'])(
    'refuses Contributor in %s before its model-list request',
    async (field) => {
        const transport = vi.fn<typeof fetch>()
        expect(
            await doctor({ MODEL_API_KEY: '<synthetic>', [field]: 'muse-spark-1.3-contributor' }, transport, () => {}),
        ).toBe(2)
        expect(transport).not.toHaveBeenCalled()
    },
)
it('checks optional second-opinion availability without claiming inference readiness', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
        Response.json({ data: [{ id: 'muse-spark-1.3' }, { id: 'sam-3.1' }] }),
    )
    const output: string[] = []
    expect(
        await doctor({ MODEL_API_KEY: '<synthetic>', MODEL_SECOND_OPINION: 'muse-wonder-1.0' }, transport, (line) =>
            output.push(line),
        ),
    ).toBe(2)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(output.join(' ')).toContain('required_model_not_listed')
    expect(output.join(' ')).toContain('"inferenceVerified":false')
})
