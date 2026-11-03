/// <reference types="node" />
import { resolve } from 'node:path'
import { act, fireEvent, screen, waitFor, type RenderResult } from '@testing-library/react-native'
import type { CaptureController } from '../../capture/controller'
import { createController, createDocuments, createScreens } from '../../capture/controller-factory'
import type { LibraryEntry } from '../../capture/library'
import { DocumentStore } from '../../document-runtime/store'
import {
    fixtureDocuments,
    type DocumentFixtureServer as FixtureServer,
    type DocumentFixtureServerOptions as FixtureServerOptions,
} from './fixture-server'
import { runtime, type Replies } from './route-harness'
import type { LibraryStorage } from '../../capture/library'

// Mounts the production root layout. The calling test file must mock '../../capture/controller-factory' (the
// controller and the screen store are handed in through it) and the native modules, as navigation.test.tsx does.
const { renderRouter } = jest.requireActual<{
    renderRouter: (directory: string) => Promise<RenderResult & { getPathname: () => string }>
}>('expo-router/testing-library')

const fixtureFlag = process.env.EXPO_PUBLIC_DOCUMENT_FIXTURES
beforeEach(() => {
    process.env.EXPO_PUBLIC_DOCUMENT_FIXTURES = '1'
})
afterEach(() => {
    if (fixtureFlag === undefined) delete process.env.EXPO_PUBLIC_DOCUMENT_FIXTURES
    else process.env.EXPO_PUBLIC_DOCUMENT_FIXTURES = fixtureFlag
})

export type Mounted = {
    view: Awaited<ReturnType<typeof renderRouter>>
    controller: CaptureController
    server: FixtureServer
    store: DocumentStore
    calls: string[]
    storage: LibraryStorage
}

export async function mount(
    entries: LibraryEntry[],
    options: { screens?: FixtureServerOptions | 'off'; replies?: Replies; recordings?: 'off' } = {},
): Promise<Mounted> {
    const { controller, calls, storage } = await runtime(entries, options.replies)
    const server = fixtureDocuments(options.screens === 'off' ? {} : options.screens)
    const store = new DocumentStore({
        client: server,
        mode: options.screens === 'off' ? 'off' : 'full',
        id: (() => {
            let id = 0
            return (): string => `s-${++id}`
        })(),
        // Latency/failure protocol cases must explicitly request the transport path; normal mounts keep recordings.
        ...(options.recordings === 'off' ? { recordings: (): null => null } : {}),
    })
    jest.mocked(createController).mockReturnValue(controller)
    jest.mocked(createScreens).mockReturnValue(null)
    jest.mocked(createDocuments).mockReturnValue(store)
    const view = await renderRouter(resolve(__dirname, '../../../../app'))
    await waitFor(() => expect(controller.getSnapshot().loading).toBe(false))
    return { view, controller, server, store, calls, storage }
}

export async function press(name: string): Promise<void> {
    await fireEvent.press(screen.getByRole('button', { name }))
}

/** The native image event, after the real photo node exists; this exercises the photo-before-verdict gate. */
export async function loadPhoto(): Promise<void> {
    await fireEvent(await screen.findByTestId('frozen-photo-frame'), 'layout', {
        nativeEvent: { layout: { width: 390, height: 460, x: 0, y: 0 } },
    })
    await fireEvent(await screen.findByTestId('frozen-photo-image'), 'load')
}

// Lets every pending promise settle inside act, so a request that was answered has been applied (or refused).
export async function flush(): Promise<void> {
    for (let turn = 0; turn < 12; turn++) await act(async () => Promise.resolve())
}
