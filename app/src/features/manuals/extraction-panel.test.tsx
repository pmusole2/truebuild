import { manualSessionSchema, type ManualSession, type ParsedManual } from '@truebuild/contracts'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { modelConnectionStore } from '../connection/connection-store'
import type { StoredPageAsset } from '../../storage/manual-store.types'
import { ExtractionPanel } from './extraction-panel'
import type { ExtractionPreview } from './model-extraction'

jest.mock('./local-store', () => ({
    localStore: { loadPageAsset: jest.fn(async (): Promise<null> => null) },
}))

const HASH = 'c'.repeat(64)
const ORIGIN = 'http://127.0.0.1:3001'
const TOKEN = 'owner-token-for-extraction-test'

// Saved (non-demo) manual with two pages and no raw extraction yet.
const session: ManualSession = manualSessionSchema.parse({
    manualId: 'manual-saved-1',
    title: 'Saved shelf',
    updatedAt: '2026-10-26T10:00:00.000Z',
    revision: 3,
    pages: [1, 2].map((index) => ({
        pageId: `page-${index}`,
        assetId: `asset-${index}`,
        width: 800,
        height: 600,
        mimeType: 'image/jpeg',
        contentHash: HASH,
    })),
    parts: [],
    rawExtraction: null,
    reviewedSteps: [],
    reviewStatus: 'unreviewed',
})

const parsed: ParsedManual = {
    parts: [
        {
            partId: 'p1',
            name: { state: 'known', value: 'Side panel', sourceRefs: [{ pageId: 'page-1', region: null }] },
        },
    ],
    steps: [
        {
            stepId: 's1',
            order: 1,
            title: 'Stand the panel upright',
            parts: [
                {
                    partId: 'p1',
                    quantity: { state: 'known', value: 1, sourceRefs: [{ pageId: 'page-1', region: null }] },
                },
            ],
            orientation: { state: 'unknown', reason: 'Not confirmed from the imported manual pages.' },
            connection: { state: 'unknown', reason: 'Not confirmed from the imported manual pages.' },
            visibleChecks: [],
            sourceRefs: [{ pageId: 'page-1', region: null }],
            correction: null,
        },
    ],
    unknowns: [],
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('ExtractionPanel', () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        modelConnectionStore.clear()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        modelConnectionStore.clear()
    })

    it('sends nothing without a connection: extraction stays disabled and no request is made', async () => {
        const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>()
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const view = await render(
            <ExtractionPanel
                session={session}
                loadPageAsset={async () => null}
                onApply={jest.fn()}
                onCopyRawStep={jest.fn()}
            />,
        )

        await act(async () => {
            await fireEvent.press(view.getByLabelText('Select page 1 for extraction'))
        })

        expect(view.getByRole('button', { name: 'Extract selected pages' }).props.accessibilityState).toMatchObject({
            disabled: true,
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('previews one selected page, then applies the preview only on an explicit press', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(async (url: string, init: RequestInit) => {
            const metadata = JSON.parse(String((init.body as FormData).get('metadata'))) as {
                requestId: string
                binding: unknown
            }
            expect(url).toBe(`${ORIGIN}/api/manuals/parse`)
            return jsonResponse(200, {
                status: 'ok',
                requestId: metadata.requestId,
                mode: 'model',
                binding: metadata.binding,
                value: parsed,
            })
        })
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const onApply = jest.fn<void, [ExtractionPreview]>()
        const view = await render(
            <ExtractionPanel
                session={session}
                loadPageAsset={async (assetId) => ({ assetId, mimeType: 'image/jpeg', bytes: new Uint8Array([7]) })}
                onApply={onApply}
                onCopyRawStep={jest.fn()}
            />,
        )

        await act(async () => {
            await fireEvent.press(view.getByLabelText('Select page 1 for extraction'))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Extract selected pages' }))
        })

        await waitFor(() => expect(view.getByText(/1 steps, 1 parts/)).toBeTruthy())
        expect(onApply).not.toHaveBeenCalled()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(new Headers(fetchMock.mock.calls[0]?.[1].headers).get('authorization')).toBe(`Bearer ${TOKEN}`)

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Apply extraction preview' }))
        })

        expect(onApply).toHaveBeenCalledTimes(1)
        const preview = onApply.mock.calls[0]?.[0]
        expect(preview?.binding).toEqual({ kind: 'manual', manualId: session.manualId, revision: session.revision })
        expect(preview?.pageIds).toEqual(['page-1'])
        // Every batch is namespaced so a later append can never collide with it; the name and citation are untouched.
        expect(preview?.extraction.parts[0]?.partId).toMatch(/^b[0-9a-f]{8}-p1$/)
        expect(preview?.extraction.parts[0]?.name).toEqual(parsed.parts[0]?.name)
    })
})

describe('ExtractionPanel custody, copy and cancellation', () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        modelConnectionStore.clear()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        modelConnectionStore.clear()
    })

    function echoingBackend(cited: ParsedManual): jest.Mock<Promise<Response>, [string, RequestInit]> {
        return jest.fn<Promise<Response>, [string, RequestInit]>(async (_url: string, init: RequestInit) => {
            const metadata = JSON.parse(String((init.body as FormData).get('metadata'))) as {
                requestId: string
                binding: unknown
            }
            return jsonResponse(200, {
                status: 'ok',
                requestId: metadata.requestId,
                mode: 'model',
                binding: metadata.binding,
                value: cited,
            })
        })
    }

    const loadAsset = async (assetId: string): Promise<StoredPageAsset> => ({
        assetId,
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([7]),
    })

    it('records a selected page with no cited evidence as an extraction source on apply', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        globalThis.fetch = echoingBackend(parsed) as unknown as typeof fetch
        const onApply = jest.fn<void, [ExtractionPreview]>()
        const view = await render(
            <ExtractionPanel session={session} loadPageAsset={loadAsset} onApply={onApply} onCopyRawStep={jest.fn()} />,
        )

        // Both pages are selected, but the evidence cites only page 1. Page 2 was still read, so it is recorded.
        await act(async () => {
            await fireEvent.press(view.getByLabelText('Select page 1 for extraction'))
        })
        await act(async () => {
            await fireEvent.press(view.getByLabelText('Select page 2 for extraction'))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Extract selected pages' }))
        })
        await waitFor(() => expect(view.getByRole('button', { name: 'Apply extraction preview' })).toBeTruthy())
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Apply extraction preview' }))
        })

        expect(onApply.mock.calls[0]?.[0].sourcePageIds).toEqual(['page-1', 'page-2'])
    })

    it('copies a raw step by its stable label and reports the raw step identity to the caller', async () => {
        const onCopyRawStep = jest.fn<void, [string]>()
        const withRaw = manualSessionSchema.parse({ ...session, rawExtraction: parsed })
        const view = await render(
            <ExtractionPanel
                session={withRaw}
                loadPageAsset={loadAsset}
                onApply={jest.fn()}
                onCopyRawStep={onCopyRawStep}
            />,
        )

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Copy raw step 1 to draft' }))
        })

        expect(onCopyRawStep).toHaveBeenCalledWith('s1')
    })

    it('a result that arrives after the connection was replaced is never previewed', async () => {
        modelConnectionStore.connect(ORIGIN, TOKEN)
        const replies: ((response: Response) => void)[] = []
        globalThis.fetch = jest.fn(
            () => new Promise<Response>((resolve) => replies.push(resolve)),
        ) as unknown as typeof fetch
        const view = await render(
            <ExtractionPanel
                session={session}
                loadPageAsset={loadAsset}
                onApply={jest.fn()}
                onCopyRawStep={jest.fn()}
            />,
        )
        await act(async () => {
            await fireEvent.press(view.getByLabelText('Select page 1 for extraction'))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Extract selected pages' }))
        })
        await waitFor(() => expect(replies).toHaveLength(1))

        await act(async () => {
            modelConnectionStore.connect(ORIGIN, 'replacement-token')
        })
        await act(async () => {
            const metadataBody = JSON.stringify({
                status: 'ok',
                requestId: 'x',
                mode: 'model',
                binding: {},
                value: parsed,
            })
            replies[0]?.(new Response(metadataBody, { status: 200, headers: { 'content-type': 'application/json' } }))
            await Promise.resolve()
        })

        expect(view.queryByRole('button', { name: 'Apply extraction preview' })).toBeNull()
    })
})
