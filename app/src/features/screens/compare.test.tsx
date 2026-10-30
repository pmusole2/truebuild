import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { jpegHeader } from '../../media/test-fixtures'
import { bytesToDataUri } from '../../media/image-source'
import { WorkflowContext } from '../capture/workflow-context'
import { entry, runtime, source } from './test-support/route-harness'
import { ComparePane } from './compare'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock('../capture/controller-factory', () => ({
    createController: jest.fn(),
    createScreens: jest.fn(),
    createDocuments: jest.fn(),
}))
jest.mock('expo-router', () => ({
    ...jest.requireActual('expo-router'),
    usePathname: (): string => '/compare',
    useIsFocused: (): boolean => true,
}))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

async function setup(): Promise<
    Awaited<ReturnType<typeof runtime>> & {
        alpha: ReturnType<typeof entry>
        beta: ReturnType<typeof entry>
        alphaUri: string
        betaUri: string
    }
> {
    const alpha = entry('alpha', 'reviewed', 2, 'Alpha')
    const beta = entry('beta', 'reviewed', 2, 'Beta')
    alpha.session.pages[0]!.assetId = 'alpha-asset'
    beta.session.pages[0]!.assetId = 'beta-asset'
    const alphaBytes = Uint8Array.from(jpegHeader(600, 800))
    const betaBytes = Uint8Array.from(jpegHeader(900, 700))
    Object.assign(alpha.session.pages[0]!, { width: 600, height: 800, mimeType: 'image/jpeg' })
    Object.assign(beta.session.pages[0]!, { width: 900, height: 700, mimeType: 'image/jpeg' })
    const ports = await runtime([])
    await ports.storage.save(
        [alpha, beta],
        [
            { assetId: 'alpha-asset', bytes: alphaBytes },
            { assetId: 'beta-asset', bytes: betaBytes },
        ],
    )
    await ports.controller.restore()
    await ports.controller.open('beta', 'guide')
    ports.controller.camera({ kind: 'check' })
    await ports.controller.shutter(async () => source)
    return {
        ...ports,
        alpha,
        beta,
        alphaUri: bytesToDataUri(alphaBytes, 'image/jpeg'),
        betaUri: bytesToDataUri(betaBytes, 'image/jpeg'),
    }
}

function wrap(ports: Awaited<ReturnType<typeof setup>>, children: ReactElement): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <WorkflowContext.Provider
                    value={{
                        controller: ports.controller,
                        state: ports.controller.getSnapshot(),
                        entry: ports.controller.current,
                        screens: null,
                        documents: null,
                    }}
                >
                    {children}
                </WorkflowContext.Provider>
            </FeedbackProvider>
        </ThemeProvider>
    )
}

it('loads both production panes from their own manual even with colliding page ids, while the held workflow remains unchanged', async () => {
    const ports = await setup()
    const before = ports.controller.getSnapshot()
    const dispatched = [...ports.calls]
    expect(ports.alpha.session.pages[0]!.pageId).toBe(ports.beta.session.pages[0]!.pageId)
    await render(
        wrap(
            ports,
            <>
                <ComparePane entry={ports.alpha} />
                <ComparePane entry={ports.beta} />
            </>,
        ),
    )
    for (const [entry, uri] of [
        [ports.alpha, ports.alphaUri],
        [ports.beta, ports.betaUri],
    ] as const) {
        const pane = within(screen.getByTestId(`compare-pane-${entry.session.manualId}`))
        fireEvent(pane.getByTestId('guide-hero-picture'), 'layout', {
            nativeEvent: { layout: { width: 320, height: 340 } },
        })
        await waitFor(() => expect(pane.getByLabelText('Picture from your manual').props.source.uri).toBe(uri))
        expect(pane.getByRole('button', { name: 'Take photo' })).toBeDisabled()
        fireEvent.press(pane.getByRole('button', { name: 'Take photo' }))
    }
    expect(ports.alphaUri).not.toBe(ports.betaUri)
    expect(ports.controller.getSnapshot()).toBe(before)
    expect(before.capture).not.toBeNull()
    expect(ports.calls).toEqual(dispatched)
    ports.controller.dispose()
})

it('discards replaced panes and shows a terminal picture state with the global integrity pause on read failure', async () => {
    const ports = await setup()
    const before = ports.controller.getSnapshot()
    const dispatched = [...ports.calls]
    const read = ports.storage.readAsset.bind(ports.storage)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    jest.spyOn(ports.storage, 'readAsset').mockImplementation(async (page) => {
        if (page.assetId === 'alpha-asset') await gate
        return read(page)
    })
    const mounted = await render(wrap(ports, <ComparePane entry={ports.alpha} />))
    await mounted.rerender(wrap(ports, <ComparePane entry={ports.beta} />))
    fireEvent(screen.getByTestId('guide-hero-picture'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 340 } },
    })
    await waitFor(() => expect(screen.getByLabelText('Picture from your manual').props.source.uri).toBe(ports.betaUri))
    await act(() => release())
    expect(screen.getByLabelText('Picture from your manual').props.source.uri).toBe(ports.betaUri)
    expect(ports.controller.getSnapshot()).toBe(before)
    await mounted.unmount()
    jest.spyOn(ports.storage, 'readAsset').mockRejectedValue(new Error('Synthetic unavailable image'))
    await render(wrap(ports, <ComparePane entry={ports.alpha} />))
    await waitFor(() => expect(screen.getByText(/picture.*unavailable/iu)).toBeTruthy())
    expect(screen.queryByTestId('skeleton-block')).toBeNull()
    const paused = ports.controller.getSnapshot()
    expect(paused.storageReadOnly).toBe(true)
    expect(paused.notice).toMatch(/Local library images could not be read/u)
    expect({ ...paused, storageReadOnly: before.storageReadOnly, notice: before.notice }).toEqual(before)
    const save = jest.spyOn(ports.storage, 'save')
    await ports.controller.rename('Must not save while paused')
    expect(save).not.toHaveBeenCalled()
    expect(ports.controller.getSnapshot()).toBe(paused)
    expect(ports.calls).toEqual(dispatched)
    ports.controller.dispose()
})
