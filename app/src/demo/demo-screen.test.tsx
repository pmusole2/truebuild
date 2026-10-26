import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { createDemoManual } from '@truebuild/contracts'
import * as ImagePicker from 'expo-image-picker'
import { jpegHeader } from '../media/test-fixtures'
import * as observation from '../features/assembly/observation'
import { DemoScreen, type DemoRuntime } from './demo-screen'

// Mocked native modules only: no camera, library, network or provider is ever reached for real.
jest.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: jest.fn(),
    launchCameraAsync: jest.fn(),
    launchImageLibraryAsync: jest.fn(),
}))
jest.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: {
        manipulate: (): unknown => {
            const chain = {
                resize: (): unknown => chain,
                renderAsync: async (): Promise<unknown> => ({
                    saveAsync: async (): Promise<unknown> => ({
                        uri: 'file:///cache/rendered.jpg',
                        width: 800,
                        height: 600,
                    }),
                }),
            }
            return chain
        },
    },
}))
jest.mock('expo-crypto', () => {
    let counter = 0
    return {
        randomUUID: (): string => `uuid-${(counter += 1)}`,
        digest: async (): Promise<ArrayBuffer> => new ArrayBuffer(32),
        CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    }
})

// Only the segmentation resize is replaced, so one case can force a preparation failure; everything else is real.
jest.mock('../features/assembly/observation', () => {
    const actual: Record<string, unknown> = jest.requireActual('../features/assembly/observation')
    return { ...actual, observationForSegmentation: jest.fn(actual.observationForSegmentation as () => unknown) }
})

const KEY = 'truebuild-fixture-demo'
const BASE = 'http://127.0.0.1:3001'
const DEMO_LABEL = 'Demo data — simulated results'
const CAMERA_DENIED = 'Camera access was not allowed. Allow the camera in Settings, or try again.'

const cameraMock = ImagePicker.launchCameraAsync as unknown as jest.Mock
const permissionMock = ImagePicker.requestCameraPermissionsAsync as unknown as jest.Mock

type Recorded = { url: string; key: string | null; body: unknown }

/** Echoes requestId and binding from the request, as the real wire does. Mode and value come from the handler. */
function fakeBackend(
    handler: (path: string, request: Record<string, unknown>) => { value: unknown; mode?: 'fixture' | 'model' },
): { fetch: jest.Mock; calls: Recorded[] } {
    const calls: Recorded[] = []
    const fetch = jest.fn(async (url: string, init: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname
        let request: Record<string, unknown>
        if (init.body instanceof FormData) {
            request = JSON.parse(String(init.body.get('metadata'))) as Record<string, unknown>
        } else {
            request = JSON.parse(String(init.body)) as Record<string, unknown>
        }
        const headers = init.headers as Record<string, string>
        calls.push({ url, key: headers['x-truebuild-key'] ?? null, body: request })
        const { value, mode } = handler(path, request)
        const envelope = {
            status: 'ok',
            requestId: request.requestId,
            mode: mode ?? (init.body instanceof FormData ? 'model' : 'fixture'),
            binding: request.binding,
            value,
        }
        return new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return { fetch, calls }
}

/** The fixture parse value, re-pointed at the page the request actually sent. */
function parseValueFor(pageId: string): unknown {
    const demo = createDemoManual()
    const raw = JSON.stringify({
        parts: demo.parts,
        steps: demo.reviewedSteps.map((step) => ({
            ...step,
            correction: step.correction === null ? null : { ...step.correction, reviewed: false },
        })),
        unknowns: [DEMO_LABEL],
    })
    return JSON.parse(raw.replaceAll('demo-page-1', pageId))
}

async function renderDemo(runtime: Partial<DemoRuntime> & Pick<DemoRuntime, 'mode' | 'fetch'>): Promise<void> {
    await render(<DemoScreen runtime={{ baseUrl: BASE, secret: KEY, ...runtime }} />)
}

/** Presses a labelled button once it is enabled, and waits for the handler's own promise (RNTL 14 fireEvent). */
const press = async (label: string): Promise<void> => {
    await waitFor(() => {
        const button = screen.getByRole('button', { name: label }) as unknown as {
            props: { accessibilityState?: { disabled?: boolean } }
        }
        expect(button.props.accessibilityState?.disabled).not.toBe(true)
    })
    await fireEvent(screen.getByRole('button', { name: label }), 'press')
}

beforeEach(() => {
    cameraMock.mockReset()
    permissionMock.mockReset()
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (): Promise<Response> => {
        return new Response(jpegHeader(800, 600) as BodyInit, { status: 200 })
    })
})

afterEach(() => {
    jest.restoreAllMocks()
})

describe('fixture mode (simulated photos, sample manual)', () => {
    it('refuses the reversed photo, passes a fresh correct photo, and clears the old verdict on a new photo', async () => {
        const backend = fakeBackend((path, request) => {
            const scenario = request.scenario as string
            if (path === '/api/checks') {
                const decision = scenario === 'wrong' ? 'refuse' : scenario === 'correct' ? 'pass' : 'cannot_verify'
                return {
                    value: {
                        decision,
                        reason: `${DEMO_LABEL}. ${decision}.`,
                        sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                        observedRegion: null,
                        missingEvidence: decision === 'cannot_verify' ? ['A clear view is required.'] : [],
                    },
                }
            }
            throw new Error(`unexpected ${path}`)
        })
        await renderDemo({ mode: 'fixture', fetch: backend.fetch })

        await press('Simulated reversed panel')
        expect(await screen.findByText('Refuse')).toBeTruthy()
        expect(screen.getByText('Cited page: demo-page-1')).toBeTruthy()
        const citedImage = screen.getByLabelText('Cited manual page') as unknown as {
            props: { source: { uri: string } }
        }
        expect(citedImage.props.source.uri).toMatch(/^data:image\/png;base64,/)

        await press('Simulated correct photo')
        expect(await screen.findByText('Pass')).toBeTruthy()
        expect(screen.queryByText('Refuse')).toBeNull()
        expect(backend.calls.every((call) => call.key === KEY)).toBe(true)

        await press('Simulated unclear photo')
        expect(await screen.findByText('Cannot verify')).toBeTruthy()
        expect(screen.queryByText('Pass')).toBeNull()
    })

    it('uses the fixture parse route for "Photograph a manual" and confirms the synthetic plan so checks cite real pages', async () => {
        const backend = fakeBackend((path) => {
            if (path === '/api/manuals/parse') {
                return { value: parseValueFor('demo-page-1') }
            }
            return {
                value: {
                    decision: 'pass',
                    reason: `${DEMO_LABEL}. ok.`,
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    observedRegion: null,
                    missingEvidence: [],
                },
            }
        })
        await renderDemo({ mode: 'fixture', fetch: backend.fetch })

        await press('Photograph a manual')
        expect(await screen.findByText('Simulated parse result')).toBeTruthy()
        expect(screen.getByText('Simulated parse result', { exact: true })).toBeTruthy()
        expect(backend.calls.map((call) => call.url)).toContain(`${BASE}/api/manuals/parse`)

        await press('Confirm expected facts')
        expect(await screen.findByText(/Plan confirmed\./)).toBeTruthy()

        await press('Simulated correct photo')
        expect(await screen.findByText('Pass')).toBeTruthy()
    })

    it('parses, confirms, then shows the actual cited image on a reversed refusal', async () => {
        const backend = fakeBackend((path, request) => {
            if (path === '/api/manuals/parse') {
                return { value: parseValueFor('demo-page-1') }
            }
            return {
                value: {
                    decision: request.scenario === 'wrong' ? 'refuse' : 'pass',
                    reason: `${DEMO_LABEL}. ${request.scenario === 'wrong' ? 'reversed' : 'correct'}.`,
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    observedRegion: null,
                    missingEvidence: [],
                },
            }
        })
        await renderDemo({ mode: 'fixture', fetch: backend.fetch })

        await press('Photograph a manual')
        expect(await screen.findByText('Simulated parse result')).toBeTruthy()
        await press('Confirm expected facts')
        expect(await screen.findByText(/Plan confirmed\./)).toBeTruthy()

        await press('Simulated reversed panel')
        expect(await screen.findByText('Refuse')).toBeTruthy()
        expect(screen.getByLabelText('Cited manual page')).toBeTruthy()
    })

    it('clears a visible pass as soon as a new manual photo is started', async () => {
        const backend = fakeBackend(() => ({
            value: {
                decision: 'pass',
                reason: `${DEMO_LABEL}. ok.`,
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                observedRegion: null,
                missingEvidence: [],
            },
        }))
        await renderDemo({ mode: 'fixture', fetch: backend.fetch })

        await press('Simulated correct photo')
        expect(await screen.findByText('Pass')).toBeTruthy()

        await press('Photograph a manual')
        expect(screen.queryByText('Pass')).toBeNull()
        expect(screen.queryByText('Cited manual page')).toBeNull()
    })

    it('discards a check that completes after the step changed, so no stale PASS appears', async () => {
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const backend = fakeBackend((path) => {
            if (path === '/api/checks') {
                return {
                    value: {
                        decision: 'pass',
                        reason: `${DEMO_LABEL}. ok.`,
                        sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                        observedRegion: null,
                        missingEvidence: [],
                    },
                }
            }
            throw new Error(`unexpected ${path}`)
        })
        const delayed = jest.fn(async (url: string, init: RequestInit): Promise<Response> => {
            await gate
            return backend.fetch(url, init)
        })
        await renderDemo({ mode: 'fixture', fetch: delayed })

        await press('Simulated correct photo')
        await press('2. Seat the divider in the groove')
        release?.()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(screen.queryByText('Pass')).toBeNull()
        expect(screen.queryByText('Refuse')).toBeNull()
    })

    it('clears a stale part-search box when the photo is replaced', async () => {
        const backend = fakeBackend((path, request) => {
            if (path === '/api/segments') {
                return {
                    value: {
                        label: DEMO_LABEL,
                        transport: 'finite-json-precursor',
                        events: [
                            {
                                type: 'snapshot',
                                snapshot: {
                                    binding: request.binding,
                                    streamId: 'demo-stream',
                                    frameIndex: 0,
                                    capturedAt: '2026-01-01T00:00:00.000Z',
                                    records: [
                                        {
                                            objectId: 'o',
                                            label: `${DEMO_LABEL}: divider`,
                                            box: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
                                        },
                                    ],
                                    complete: true,
                                },
                            },
                            { type: 'completed' },
                        ],
                    },
                }
            }
            return {
                value: {
                    decision: 'pass',
                    reason: `${DEMO_LABEL}. ok.`,
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    observedRegion: null,
                    missingEvidence: [],
                },
            }
        })
        await renderDemo({ mode: 'fixture', fetch: backend.fetch })

        await press('Simulated correct photo')
        fireEvent.changeText(screen.getByLabelText('Part to find in the photo'), 'side panel')
        await press('Find part in photo')
        expect(await screen.findByText('Found 1 region in this frozen photo.')).toBeTruthy()

        await press('Simulated reversed panel')
        expect(screen.queryByText('Found 1 region in this frozen photo.')).toBeNull()
        expect(
            screen.getByText(
                'Finds the named part in this one frozen photo. It does not track anything across frames.',
                { exact: false },
            ),
        ).toBeTruthy()
    })
})

describe('model mode (photographed manual and camera)', () => {
    const cameraAsset = { canceled: false, assets: [{ uri: 'file:///cache/camera.jpg', width: 800, height: 600 }] }

    it('parses a photographed manual, confirms the readonly facts, and checks a photo against the confirmed page', async () => {
        permissionMock.mockResolvedValue({ granted: true })
        cameraMock.mockResolvedValue(cameraAsset)
        const backend = fakeBackend((path, request) => {
            if (path === '/api/manuals/parse') {
                const pages = request.pages as { pageId: string }[]
                return { value: parseValueFor(pages[0]?.pageId ?? 'missing') }
            }
            if (path === '/api/checks') {
                const session = request.session as { pages: { pageId: string }[] }
                return {
                    value: {
                        decision: 'pass',
                        reason: 'The photo matches the cited step.',
                        sourceRefs: [{ pageId: session.pages[0]?.pageId, region: null }],
                        observedRegion: null,
                        missingEvidence: [],
                    },
                }
            }
            throw new Error(`unexpected ${path}`)
        })
        await renderDemo({ mode: 'model', fetch: backend.fetch })

        expect(screen.getByText('Use sample manual (synthetic, not physically qualified)')).toBeTruthy()
        await press('Photograph a manual')
        expect(await screen.findByText('Confirm expected facts')).toBeTruthy()
        expect(screen.getByText(/Orientation: Groove faces inward/)).toBeTruthy()
        expect(screen.getAllByText(/Quantity of side-panel: 1/).length).toBeGreaterThan(0)
        expect(backend.calls[0]?.key).toBe(KEY)

        await press('Confirm expected facts')
        expect(await screen.findByText(/Plan confirmed\./)).toBeTruthy()

        await press('Take photo')
        expect(await screen.findByText('Pass')).toBeTruthy()
        expect(cameraMock).toHaveBeenCalledTimes(2)
    })

    it('shows unknown critical facts read-only and keeps confirmation blocked', async () => {
        permissionMock.mockResolvedValue({ granted: true })
        cameraMock.mockResolvedValue(cameraAsset)
        const backend = fakeBackend((path, request) => {
            const pages = request.pages as { pageId: string }[]
            const value = parseValueFor(pages[0]?.pageId ?? 'missing') as { steps: { orientation: unknown }[] }
            value.steps[0]!.orientation = { state: 'unknown', reason: 'Arrow is not visible in the photo.' }
            return path === '/api/manuals/parse' ? { value } : { value: {} }
        })
        await renderDemo({ mode: 'model', fetch: backend.fetch })

        await press('Photograph a manual')
        expect(await screen.findByText(/UNKNOWN — Arrow is not visible in the photo\./)).toBeTruthy()
        const confirm = screen.getByText('Confirm expected facts')
        fireEvent.press(confirm)
        expect(screen.queryByText(/Plan confirmed\./)).toBeNull()
    })

    it('denies the camera without opening the picker or any network call', async () => {
        permissionMock.mockResolvedValue({ granted: false, canAskAgain: true, status: 'denied' })
        const backend = fakeBackend(() => ({ value: {} }))
        await renderDemo({ mode: 'model', fetch: backend.fetch })

        await press('Photograph a manual')
        expect(await screen.findByText(CAMERA_DENIED)).toBeTruthy()
        expect(cameraMock).not.toHaveBeenCalled()
        expect(backend.fetch).not.toHaveBeenCalled()
    })

    it('ends a failed segmentation preparation as unavailable instead of staying pending', async () => {
        permissionMock.mockResolvedValue({ granted: true })
        cameraMock.mockResolvedValue(cameraAsset)
        const preparation = jest.mocked(observation.observationForSegmentation)
        preparation.mockRejectedValueOnce(new Error('resize failed'))
        const backend = fakeBackend((path, request) => {
            if (path === '/api/manuals/parse') {
                const pages = request.pages as { pageId: string }[]
                return { value: parseValueFor(pages[0]?.pageId ?? 'missing') }
            }
            return { value: {} }
        })
        await renderDemo({ mode: 'model', fetch: backend.fetch })

        await press('Photograph a manual')
        await press('Confirm expected facts')
        expect(await screen.findByText(/Plan confirmed\./)).toBeTruthy()
        await press('Take photo')
        fireEvent.changeText(screen.getByLabelText('Part to find in the photo'), 'side panel')
        await press('Find part in photo')

        expect(await screen.findByText(/Use a short noun phrase/)).toBeTruthy()
        expect(screen.queryByText('Finding…')).toBeNull()
        expect(preparation).toHaveBeenCalledTimes(1)
        expect(backend.calls.some((call) => call.url.endsWith('/api/segments'))).toBe(false)
    })
})

describe('late camera return', () => {
    it('discards a photo that arrives after the step changed: no check, no verdict, no preview', async () => {
        permissionMock.mockResolvedValue({ granted: true })
        let deliverCamera: ((value: unknown) => void) | undefined
        cameraMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    deliverCamera = resolve
                }),
        )
        const backend = fakeBackend(() => ({ value: {} }))
        await renderDemo({ mode: 'model', fetch: backend.fetch })

        await press('Use sample manual (synthetic, not physically qualified)')
        // The camera is still open when the user moves on to step 2; its eventual return belongs to step 1.
        const pendingPhoto = fireEvent(screen.getByRole('button', { name: 'Take photo' }), 'press')
        await press('2. Seat the divider in the groove')
        deliverCamera?.({ canceled: false, assets: [{ uri: 'file:///cache/late.jpg', width: 600, height: 400 }] })
        await pendingPhoto
        // Give a late, unguarded publish time to commit, so the negative assertions below are meaningful.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50))
        })

        expect(cameraMock).toHaveBeenCalledTimes(1)
        expect(backend.calls.filter((call) => call.url.endsWith('/api/checks'))).toHaveLength(0)
        expect(screen.queryByText('Pass')).toBeNull()
        expect(screen.queryByText('Cannot verify')).toBeNull()
        expect(screen.queryByText('Your photo, frozen for this capture.')).toBeNull()
        expect(screen.queryByText('Simulated photo: no image was captured or analysed.')).toBeNull()
    })
})

describe('sample manual selection', () => {
    it('resets a visible verdict when the synthetic sample is selected explicitly', async () => {
        const backend = fakeBackend(() => ({
            value: {
                decision: 'pass',
                reason: `${DEMO_LABEL}. ok.`,
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                observedRegion: null,
                missingEvidence: [],
            },
        }))
        await renderDemo({ mode: 'fixture', fetch: backend.fetch })

        await press('Simulated correct photo')
        expect(await screen.findByText('Pass')).toBeTruthy()

        await press('Use sample manual (synthetic, not physically qualified)')
        expect(screen.queryByText('Pass')).toBeNull()
        expect(screen.getByText(/Sample manual — original synthetic fixture/)).toBeTruthy()
    })
})
