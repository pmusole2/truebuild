/** External provider fixture adapter: parsed payloads are unchanged; a requested stream gets the documented events. */
export async function asRequestedMetaResponse(response: Response, init?: RequestInit): Promise<Response> {
    let stream = false
    try {
        stream = JSON.parse(String(init?.body)).stream === true
    } catch {
        /* Not a structured provider request. */
    }
    if (!stream || !response.ok || !response.headers.get('content-type')?.includes('application/json')) return response
    const value: unknown = await response.json()
    const status = typeof value === 'object' && value !== null && 'status' in value ? value.status : undefined
    const terminal = status === 'failed' || status === 'incomplete' ? status : 'completed'
    return new Response(
        `data: ${JSON.stringify({ type: 'response.created', response: { status: 'in_progress' } })}\n\n` +
            `data: ${JSON.stringify({ type: `response.${terminal}`, response: value })}\n\n`,
        { status: response.status, headers: { 'content-type': 'text/event-stream' } },
    )
}

/** A finite synthetic event stream with controlled monotonic event spacing, without wall-clock sleeps. */
export function timedMetaResponse(value: unknown, elapsedMs: number, advance: (ms: number) => void): Response {
    const events = [
        'response.created',
        ...Array.from({ length: Math.floor(elapsedMs / 10_000) }, () => 'response.in_progress'),
        'response.completed',
    ]
    let index = 0,
        advanced = 0
    const encoder = new TextEncoder()
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller): void {
                const type = events[index++]
                if (type === undefined) {
                    controller.close()
                    return
                }
                if (type !== 'response.created') {
                    const increment = type === 'response.completed' ? elapsedMs - advanced : 10_000
                    advance(increment)
                    advanced += increment
                }
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type, ...(type === 'response.completed' ? { response: value } : {}) })}\n\n`,
                    ),
                )
            },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
    )
}

/** Decode the simulator's terminal payload before a test deliberately rewrites identity or usage. */
export async function decodeMetaFixtureResponse(response: Response): Promise<unknown> {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json()
    const text = await response.text()
    for (const block of text.split(/\r?\n\r?\n/u)) {
        const data = block
            .split(/\r?\n/u)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
        if (!data || data === '[DONE]') continue
        const event: unknown = JSON.parse(data)
        if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            'response' in event &&
            ['response.completed', 'response.incomplete', 'response.failed'].includes(String(event.type))
        )
            return event.response
    }
    throw new Error('Missing simulator terminal response')
}
