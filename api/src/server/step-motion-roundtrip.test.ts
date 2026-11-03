import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createDemoManual, projectManualSessionExtensions, type ParsedManual } from '@truebuild/contracts'
import { screensV2GenerateRequest } from '@truebuild/contracts/model'
import { createApp } from '../app'
import { createApiHandlers } from './handlers'
import { createRuntimeFromEnvironment } from './model-runtime'
import { createFixtureProvider } from '../providers/fixture'
import { documentInputs } from '../test-support/document-inputs'
import { LibraryStorage, type KeyValueStorage } from '../../../app/src/features/capture/library'
import {
    motionRequestForStep,
    stepMotionCacheKey as deviceCacheKey,
} from '../../../app/src/features/step-motion/step-motion-registry'
import { stepMotionCacheKey as serverCacheKey } from './step-motion'
import { BoundedApiClient, SIMULATED_LABEL } from '../../../app/src/api/client'

const digest = (bytes: Uint8Array): Promise<string> => Promise.resolve(createHash('sha256').update(bytes).digest('hex'))

it('round-trips both step fields through fixture parse, library, shared projection, wire hash and motion request', async () => {
    const key = 'truebuild-fixture-demo'
    const session = createDemoManual()
    const manual: ParsedManual = structuredClone(session.rawExtraction!)
    manual.unknowns = [SIMULATED_LABEL]
    const step = manual.steps[0]!
    step.sourceText = '  Turn the part.\nPress it down.  '
    step.actions = [{ actionId: 'turn', instruction: 'Turn the part.', sourceRefs: step.sourceRefs }]
    const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: key })
    runtime.fixture = createApiHandlers({ ...createFixtureProvider(), parse: async () => manual })
    const api = createApp({ runtime, onDuration: () => {} })
    const client = new BoundedApiClient({
        baseUrl: 'http://localhost',
        mode: 'fixture',
        secret: key,
        fetch: async (url, init): Promise<Response> => api.request(url, init),
    })
    const parsed = await client.parse(
        { kind: 'manual', manualId: session.manualId, revision: session.revision },
        { requestId: 'roundtrip' },
    )
    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') throw new Error('Expected fixture extraction')
    session.rawExtraction = parsed.value
    // The fixture's existing human review remains explicit; raw extraction corrections stay unreviewed.
    session.reviewedSteps = parsed.value.steps.map((item) => ({
        ...structuredClone(item),
        correction: session.reviewedSteps.find((reviewed) => reviewed.stepId === item.stepId)!.correction,
    }))
    const bytes = new Uint8Array([1, 4, 9])
    session.pages[0]!.contentHash = await digest(bytes)
    const data = new Map<string, string>()
    const disk: KeyValueStorage = {
        getItem: async (name) => data.get(name) ?? null,
        setItem: async (name, value) => {
            data.set(name, value)
        },
        removeItem: async (name) => {
            data.delete(name)
        },
        getAllKeys: async () => [...data.keys()],
    }
    await new LibraryStorage(disk, digest).save(
        [{ session, stepIndex: 0, completedStepIds: [], capture: null }],
        [{ assetId: session.pages[0]!.assetId, bytes }],
    )
    const restored = await new LibraryStorage(disk, digest).restore()
    expect(restored.readOnly).toBe(false)
    const saved = restored.entries[0]!.session
    expect(saved.rawExtraction!.steps[0]!.sourceText).toBe(step.sourceText)
    expect(saved.reviewedSteps[0]!.actions).toEqual(step.actions)
    expect(projectManualSessionExtensions(saved)).toEqual(saved)
    expect(projectManualSessionExtensions(saved, [])).not.toEqual(saved)
    const metadata = screensV2GenerateRequest('hash-roundtrip', documentInputs('guide', saved), (text) =>
        createHash('sha256').update(text).digest('hex'),
    )
    const send = async (value: unknown): Promise<Response> => {
        const form = new FormData()
        form.set('metadata', JSON.stringify(value))
        return api.request('/api/screens/v2?waitCopy=2&stepFields=actions,sourceText', {
            method: 'POST',
            headers: { 'x-truebuild-key': key },
            body: form,
        })
    }
    expect((await send(metadata)).status).toBe(200)
    const tampered = structuredClone(metadata)
    tampered.session!.rawExtraction!.steps[0]!.sourceText = 'Changed after hashing.'
    expect((await send(tampered)).status).toBe(400)
    const motion = motionRequestForStep(saved, step.stepId, 'motion-roundtrip')!
    expect(motion.instructionText).toBe(step.sourceText)
    expect(motion.actions).toEqual(step.actions.map((action) => action.instruction))
    expect(motion.sourceRefs).toEqual(step.sourceRefs)
    expect(deviceCacheKey(motion).split('/').at(-1)).toBe(serverCacheKey(motion))
    const lookup = new FormData()
    lookup.set('metadata', JSON.stringify({ ...motion, cacheOnly: true }))
    const accepted = await api.request('/api/step-motion?cacheOnly=1', {
        method: 'POST',
        headers: { 'x-truebuild-key': key },
        body: lookup,
    })
    expect(accepted.status).toBe(404)
    expect(await accepted.json()).toMatchObject({ code: 'cache_miss' })
})
