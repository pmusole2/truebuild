import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { ConnectionScreen } from './connection-screen'
import { modelConnectionStore } from './connection-store'

const ORIGIN = 'http://127.0.0.1:3001'
const TOKEN = 'owner-token-for-connection-test'

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('ConnectionScreen', () => {
    let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        modelConnectionStore.clear()
        fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>()
        globalThis.fetch = fetchMock as unknown as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        modelConnectionStore.clear()
    })

    it('keeps Connect disabled until a token is entered, and sends nothing when connecting', async () => {
        const view = await render(<ConnectionScreen />)
        const connect = view.getByRole('button', { name: 'Connect' })
        expect(connect.props.accessibilityState).toMatchObject({ disabled: true })

        await fireEvent.changeText(view.getByLabelText('Owner session token'), TOKEN)
        expect(view.getByRole('button', { name: 'Connect' }).props.accessibilityState).toMatchObject({
            disabled: false,
        })

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Connect' }))
        })

        expect(modelConnectionStore.get()).toMatchObject({ origin: ORIGIN, token: TOKEN, session: null })
        expect(view.getByLabelText('Owner session token').props.value).toBe('')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses a remote or path-bearing address and stores nothing', async () => {
        const view = await render(<ConnectionScreen />)
        await fireEvent.changeText(view.getByLabelText('Local backend address'), 'https://example.com/api')
        await fireEvent.changeText(view.getByLabelText('Owner session token'), TOKEN)

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Connect' }))
        })

        expect(view.getByText(/plain local address/)).toBeTruthy()
        expect(modelConnectionStore.get()).toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('runs one authenticated session check that reports the key flag without calling a model', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(200, {
                status: 'ok',
                runId: 'run-1',
                expiresAt: Date.now() + 60 * 60 * 1000,
                model: 'configured',
            }),
        )
        const view = await render(<ConnectionScreen />)
        await fireEvent.changeText(view.getByLabelText('Owner session token'), TOKEN)
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Connect' }))
        })

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Check session' }))
        })

        await waitFor(() => expect(view.getByText(/key is configured/)).toBeTruthy())
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe(`${ORIGIN}/api/session`)
        expect(init?.method).toBe('GET')
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(url).not.toContain(TOKEN)
        const session = modelConnectionStore.get()?.session
        expect(session?.model).toBe('configured')
        expect(typeof session?.expiresAt).toBe('number')
    })

    it('clears the connection when the backend rejects the owner token', async () => {
        fetchMock.mockResolvedValue(jsonResponse(401, { status: 'unavailable' }))
        const view = await render(<ConnectionScreen />)
        await fireEvent.changeText(view.getByLabelText('Owner session token'), TOKEN)
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Connect' }))
        })

        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Check session' }))
        })

        await waitFor(() => expect(view.getByText(/owner token was rejected/)).toBeTruthy())
        expect(modelConnectionStore.get()).toBeNull()
    })

    it('a session reply for an earlier token cannot clear a newer connection', async () => {
        const replies: ((response: Response) => void)[] = []
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => replies.push(resolve)))
        const view = await render(<ConnectionScreen />)
        await fireEvent.changeText(view.getByLabelText('Owner session token'), TOKEN)
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Connect' }))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Check session' }))
        })

        // The user replaces the token while token A's status request is still in flight.
        await act(async () => {
            modelConnectionStore.connect(ORIGIN, 'replacement-token')
        })
        await act(async () => {
            replies[0]?.(jsonResponse(401, { status: 'unavailable' }))
            await Promise.resolve()
        })

        expect(modelConnectionStore.get()?.token).toBe('replacement-token')
    })

    it('a verified session reply for an earlier token is not recorded onto the newer connection', async () => {
        const replies: ((response: Response) => void)[] = []
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => replies.push(resolve)))
        const view = await render(<ConnectionScreen />)
        await fireEvent.changeText(view.getByLabelText('Owner session token'), TOKEN)
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Connect' }))
        })
        await act(async () => {
            await fireEvent.press(view.getByRole('button', { name: 'Check session' }))
        })

        await act(async () => {
            modelConnectionStore.connect(ORIGIN, 'replacement-token')
        })
        await act(async () => {
            replies[0]?.(
                jsonResponse(200, {
                    status: 'ok',
                    runId: 'run-1',
                    expiresAt: Date.now() + 3_600_000,
                    model: 'configured',
                }),
            )
            await Promise.resolve()
        })

        expect(modelConnectionStore.get()).toMatchObject({ token: 'replacement-token', session: null })
    })
})
