/// <reference types="node" />
import { resolve } from 'node:path'
import { act, fireEvent, screen, waitFor, type RenderResult } from '@testing-library/react-native'
import type { CaptureController } from '../../capture/controller'
import { createController, createScreens } from '../../capture/controller-factory'
import type { LibraryEntry } from '../../capture/library'
import { ScreenStore } from '../screen-store'
import { nodeDigest } from './documents'
import { fixtureScreens, type FixtureServer, type FixtureServerOptions } from './fixture-server'
import { runtime, type Replies } from './route-harness'

// Mounts the production root layout. The calling test file must mock '../../capture/controller-factory' (the
// controller and the screen store are handed in through it) and the native modules, as navigation.test.tsx does.
const { renderRouter } = jest.requireActual<{
    renderRouter: (directory: string) => Promise<RenderResult & { getPathname: () => string }>
}>('expo-router/testing-library')

export type Mounted = {
    view: Awaited<ReturnType<typeof renderRouter>>
    controller: CaptureController
    server: FixtureServer
    store: ScreenStore | null
    calls: string[]
}

export async function mount(
    entries: LibraryEntry[],
    options: { screens?: FixtureServerOptions | 'off'; replies?: Replies } = {},
): Promise<Mounted> {
    const { controller, calls } = await runtime(entries, options.replies)
    const server = fixtureScreens(options.screens === 'off' ? {} : options.screens)
    const store =
        options.screens === 'off'
            ? null
            : new ScreenStore({
                  client: server,
                  mode: 'full',
                  id: (() => {
                      let id = 0
                      return (): string => `s-${++id}`
                  })(),
                  pollMs: 1,
                  sleep: async (): Promise<void> => undefined,
                  digest: nodeDigest,
              })
    jest.mocked(createController).mockReturnValue(controller)
    jest.mocked(createScreens).mockReturnValue(store)
    const view = await renderRouter(resolve(__dirname, '../../../../app'))
    await waitFor(() => expect(screen.queryByText('Getting your builds ready.')).toBeNull())
    return { view, controller, server, store, calls }
}

export async function press(name: string): Promise<void> {
    await fireEvent.press(screen.getByRole('button', { name }))
}

// Lets every pending promise settle inside act, so a request that was answered has been applied (or refused).
export async function flush(): Promise<void> {
    for (let turn = 0; turn < 12; turn++) await act(async () => Promise.resolve())
}
