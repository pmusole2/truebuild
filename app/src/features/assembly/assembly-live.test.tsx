import type { ApiResult, CheckResult, ManualSession } from '@truebuild/contracts'
import { createDemoManual } from '@truebuild/contracts'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { modelConnectionStore } from '../connection/connection-store'
import type { CheckRequest } from './check-state'
import { AssemblyScreen } from './assembly-screen'
import type { Observation } from './observation'
import { pickObservationFromLibrary } from './observation'
import type { StoredPageAsset } from '../../storage/manual-store.types'

jest.mock('../manuals/local-store', () => ({
    localStore: { loadPageAsset: jest.fn(async (): Promise<null> => null) },
}))

const ORIGIN = 'http://127.0.0.1:3001'
const TOKEN = 'owner-token-for-live-ui-test'

jest.mock('./observation', () => ({
    pickObservationFromLibrary: jest.fn(),
    observationFromCapture: jest.fn(),
    observationForSegmentation: async (observation: unknown): Promise<unknown> => observation,
}))

// Route every streamed request through the same scripted fetch, so the segments echo is also exercised.
jest.mock('../../api/stream-fetch', () => ({
    streamFetch: (url: string, init: RequestInit): Promise<Response> => globalThis.fetch(url, init),
}))

const demo: ManualSession = createDemoManual()
const step = demo.reviewedSteps.find((candidate) => candidate.stepId === 'step-2')
const observation: Observation = {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/jpeg',
    width: 4,
    height: 3,
    uri: 'file:///tmp/fresh.jpg',
}
const pickMock = pickObservationFromLibrary as jest.MockedFunction<typeof pickObservationFromLibrary>

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Reads the identity the client sent, so every scripted reply echoes exactly that request.
function sentMetadata(init: RequestInit): { requestId: string; binding: unknown } {
    const form = init.body as FormData
    const metadata = JSON.parse(String(form.get('metadata'))) as { requestId: string; binding: unknown }
    return { requestId: metadata.requestId, binding: metadata.binding }
}

const CITED = [{ pageId: 'demo-page-1', region: null }]

function scriptedBackend(): jest.Mock<Promise<Response>, [string, RequestInit]> {
    return jest.fn<Promise<Response>, [string, RequestInit]>(async (url: string, init: RequestInit) => {
        const { requestId, binding } = sentMetadata(init)
        if (url.endsWith('/api/checks')) {
            const value: CheckResult = {
                decision: 'pass',
                reason: 'Divider sits in the groove.',
                sourceRefs: CITED,
                observedRegion: null,
                missingEvidence: [],
            }
            return jsonResponse(200, { status: 'ok', requestId, mode: 'model', binding, value })
        }
        if (url.endsWith('/api/questions')) {
            return jsonResponse(200, {
                status: 'ok',
                requestId,
                mode: 'model',
                binding,
                value: { answer: 'Groove faces inward, toward the divider.', sourceRefs: CITED, missingEvidence: [] },
            })
        }
        if (url.endsWith('/api/segments')) {
            const snapshot = {
                status: 'ok',
                requestId,
                mode: 'model',
                binding,
                value: {
                    type: 'snapshot',
                    snapshot: {
                        binding,
                        streamId: 'stream-1',
                        frameIndex: 0,
                        capturedAt: '2026-10-26T10:00:00.000Z',
                        records: [
                            { objectId: 'o1', label: 'Side panel', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
                        ],
                        complete: false,
                    },
                },
            }
            const completed = { status: 'ok', requestId, mode: 'model', binding, value: { type: 'completed' } }
            const body = `data: ${JSON.stringify(snapshot)}\n\ndata: ${JSON.stringify(completed)}\n\n`
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        return jsonResponse(404, { status: 'unavailable' })
    })
}

describe('AssemblyScreen live model flow', () => {
    let backend: jest.Mock<Promise<Response>, [string, RequestInit]>
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        modelConnectionStore.clear()
        backend = scriptedBackend()
        globalThis.fetch = backend as unknown as typeof fetch
        pickMock.mockReset()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        modelConnectionStore.clear()
    })

    async function renderLive(
        runCheck = jest.fn<Promise<ApiResult<CheckResult>>, [CheckRequest]>(),
    ): Promise<ReturnType<typeof render>> {
        if (step === undefined) {
            throw new Error('demo step-2 is missing')
        }
        const loadPageAsset = async (assetId: string): Promise<StoredPageAsset | null> => {
            const page = demo.pages.find((candidate) => candidate.assetId === assetId)
            return page === undefined ? null : { assetId, mimeType: page.mimeType, bytes: new Uint8Array([9]) }
        }
        const view = await render(
            <AssemblyScreen
                session={demo}
                step={step}
                runCheck={runCheck}
                onBack={() => undefined}
                loadPageAsset={loadPageAsset}
            />,
        )
        await act(async () => {
            await fireEvent.press(view.getByRole('radio', { name: 'Live model' }))
        })
        return view
    }

    it('sends nothing when live mode has no connection (the existing unconfigured path)', async () => {
        const runCheck = jest.fn<Promise<ApiResult<CheckResult>>, [CheckRequest]>(async (request) => ({
            status: 'unavailable',
            requestId: request.requestId,
            binding: request.binding,
            code: 'unconfigured',
            retryable: false,
        }))
        const view = await renderLive(runCheck)

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Run check' }))
        })

        await waitFor(() => expect(view.getByText(/Live checks are not configured/)).toBeTruthy())
        expect(runCheck.mock.calls[0]?.[0].mode).toBe('model')
        expect(backend).not.toHaveBeenCalled()
    })

    it('runs one live check on a fresh photo, sends the bearer token only in the header, and labels the result', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        pickMock.mockResolvedValue(observation)
        const view = await renderLive()

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Choose fresh photo' }))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Run check' }))
        })

        await waitFor(() => expect(view.getByText('Pass')).toBeTruthy())
        // The mode control and the result tag both read "Live model"; the result tag adds one more match.
        expect(view.getAllByText('Live model').length).toBeGreaterThan(1)
        const checks = backend.mock.calls.filter(([url]) => url.endsWith('/api/checks'))
        expect(checks).toHaveLength(1)
        expect(new Headers(checks[0]?.[1].headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(JSON.stringify(checks[0]?.[1].body ?? '')).not.toContain(TOKEN)
    })

    it('answers a grounded question about a chosen part and cites the page', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        pickMock.mockResolvedValue(observation)
        const view = await renderLive()
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Choose fresh photo' }))
        })

        await act(async () => {
            await fireEvent.changeText(view.getByLabelText('Question about this step'), 'Which way does it face?')
        })
        const partButtons = view.getAllByRole('button', { name: /Ask about part/ })
        await act(async () => {
            await fireEvent.press(partButtons[0]!)
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Ask question' }))
        })

        await waitFor(() => expect(view.getByText('Groove faces inward, toward the divider.')).toBeTruthy())
        expect(view.getByText(/page 1/)).toBeTruthy()
        expect(backend.mock.calls.some(([url]) => url.endsWith('/api/questions'))).toBe(true)
    })

    it('clears a visible answer when a fresh photo replaces the capture', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        pickMock.mockResolvedValue(observation)
        const view = await renderLive()
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Choose fresh photo' }))
        })
        await act(async () => {
            await fireEvent.changeText(view.getByLabelText('Question about this step'), 'Which way does it face?')
        })
        await act(async () => {
            await fireEvent.press(view.getAllByRole('button', { name: /Ask about part/ })[0]!)
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Ask question' }))
        })
        await waitFor(() => expect(view.getByText('Groove faces inward, toward the divider.')).toBeTruthy())

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Choose fresh photo' }))
        })

        expect(view.queryByText('Groove faces inward, toward the divider.')).toBeNull()
    })

    it('finds the named part in the frozen photo from one streamed request and shows the region', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        pickMock.mockResolvedValue(observation)
        const view = await renderLive()
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Choose fresh photo' }))
        })

        await act(async () => {
            await fireEvent.changeText(view.getByLabelText('Part to find in the photo'), 'side panel')
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Find part in photo' }))
        })

        await waitFor(() => expect(view.getByText(/Found 1 region in this frozen photo/)).toBeTruthy())
        const segments = backend.mock.calls.filter(([url]) => url.endsWith('/api/segments'))
        expect(segments).toHaveLength(1)
    })
})

// Deferred replies: each request waits until the test releases it, so late completions can be replayed on purpose.
function deferredBackend(): {
    fetch: jest.Mock<Promise<Response>, [string, RequestInit]>
    release: (path: string, respond: (requestId: string, binding: unknown) => Response) => Promise<void>
} {
    const waiting: { path: string; resolve: (response: Response) => void; requestId: string; binding: unknown }[] = []
    const fetch = jest.fn<Promise<Response>, [string, RequestInit]>(
        (url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
                const { requestId, binding } = sentMetadata(init)
                waiting.push({ path: url, resolve, requestId, binding })
            }),
    )
    const release = async (path: string, respond: (requestId: string, binding: unknown) => Response): Promise<void> => {
        const index = waiting.findIndex((entry) => entry.path.endsWith(path))
        const entry = waiting.splice(index, 1)[0]
        if (entry === undefined) {
            throw new Error(`no pending request for ${path}`)
        }
        entry.resolve(respond(entry.requestId, entry.binding))
        await act(async () => {
            await Promise.resolve()
        })
    }
    return { fetch, release }
}

describe('AssemblyScreen lifecycle invalidation', () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        modelConnectionStore.clear()
        pickMock.mockReset()
        pickMock.mockResolvedValue(observation)
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        modelConnectionStore.clear()
    })

    async function openLiveWithPhoto(): Promise<Awaited<ReturnType<typeof render>>> {
        if (step === undefined) {
            throw new Error('demo step-2 is missing')
        }
        const view = await render(
            <AssemblyScreen
                session={demo}
                step={step}
                runCheck={jest.fn()}
                onBack={() => undefined}
                loadPageAsset={async (assetId: string) => {
                    const page = demo.pages.find((candidate) => candidate.assetId === assetId)
                    return page === undefined ? null : { assetId, mimeType: page.mimeType, bytes: new Uint8Array([9]) }
                }}
            />,
        )
        await act(async () => {
            await fireEvent.press(view.getByRole('radio', { name: 'Live model' }))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Choose fresh photo' }))
        })
        return view
    }

    async function askQuestion(view: Awaited<ReturnType<typeof render>>): Promise<void> {
        await act(async () => {
            await fireEvent.changeText(view.getByLabelText('Question about this step'), 'Which way does it face?')
        })
        await act(async () => {
            await fireEvent.press(view.getAllByRole('button', { name: /Ask about part/ })[0]!)
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Ask question' }))
        })
    }

    it('replacing the connection clears the visible answer and the in-flight question', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        globalThis.fetch = scriptedBackend() as unknown as typeof fetch
        const view = await openLiveWithPhoto()
        await askQuestion(view)
        await waitFor(() => expect(view.getByText('Groove faces inward, toward the divider.')).toBeTruthy())

        await act(async () => {
            modelConnectionStore.connect(ORIGIN, 'replacement-token')
        })

        expect(view.queryByText('Groove faces inward, toward the divider.')).toBeNull()
    })

    it('a late answer from a switched-away mode never appears when the user returns', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        const backend = deferredBackend()
        globalThis.fetch = backend.fetch as unknown as typeof fetch
        const view = await openLiveWithPhoto()
        await askQuestion(view)
        expect(backend.fetch).toHaveBeenCalledTimes(1)

        await act(async () => {
            await fireEvent.press(view.getByRole('radio', { name: 'Simulated (fixture)' }))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('radio', { name: 'Live model' }))
        })
        await backend.release('/api/questions', (requestId, binding) =>
            jsonResponse(200, {
                status: 'ok',
                requestId,
                mode: 'model',
                binding,
                value: { answer: 'Late answer.', sourceRefs: CITED, missingEvidence: [] },
            }),
        )

        expect(view.queryByText('Late answer.')).toBeNull()
    })

    it('an unauthorized question reply clears the connection and shows no answer', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        globalThis.fetch = jest.fn(async () => jsonResponse(401, { status: 'unavailable' })) as unknown as typeof fetch
        const view = await openLiveWithPhoto()
        await askQuestion(view)

        await waitFor(() => expect(modelConnectionStore.get()).toBeNull())
        expect(view.queryByText(/Groove faces/)).toBeNull()
    })
})
