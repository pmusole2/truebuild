import { serve } from '@hono/node-server'

import { createApp } from './app'

const rawPort = process.env.PORT ?? '3001'
const port = Number(rawPort)
if (!/^\d+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid_port')
}

const server = serve({ fetch: createApp().fetch, hostname: '0.0.0.0', port })
function shutdown(): void {
    server.close()
    if ('closeIdleConnections' in server) {
        server.closeIdleConnections()
    }
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
