import { parseNativeMeterMarkers } from '../../ui/native-meter-markers'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { reloadAppAsync } from 'expo'
import { StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { screenDocumentV2Schema } from '@truebuild/contracts'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { DocumentRoot } from '../documents/document-renderer'
import { DocumentNavigationRoot, DocumentOwnershipProvider, DocumentRouteBoundary } from '../documents/ownership'
import { hostsOutsideDocuments, type OwnershipTree } from '../documents/ownership-audit'
import { AppUnavailableScreen } from './app-unavailable'

jest.mock('expo', () => ({ ...jest.requireActual('expo'), reloadAppAsync: jest.fn() }))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const reload = jest.mocked(reloadAppAsync)

function wrap(ownership = false): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                {ownership ? (
                    <DocumentOwnershipProvider>
                        <DocumentNavigationRoot>
                            <DocumentRouteBoundary>
                                <AppUnavailableScreen />
                            </DocumentRouteBoundary>
                        </DocumentNavigationRoot>
                    </DocumentOwnershipProvider>
                ) : (
                    <AppUnavailableScreen />
                )}
            </FeedbackProvider>
        </ThemeProvider>
    )
}

beforeEach(() => {
    reload.mockReset()
    jest.mocked(useSafeAreaInsets).mockReturnValue({ top: 32, bottom: 16, left: 0, right: 0 })
})

it('owns the startup failure and native frame with a complete local fallback before Workflow or Coach exists', async () => {
    await render(wrap(true))
    type Fiber = { type: unknown; memoizedProps?: { document?: unknown }; return: Fiber | null }
    let fiber = screen.getByTestId('app-unavailable-screen').unstable_fiber as unknown as Fiber | null
    while (fiber !== null && fiber.type !== DocumentRoot) fiber = fiber.return
    expect(fiber).not.toBeNull()
    const document = screenDocumentV2Schema.parse(fiber?.memoizedProps?.document)
    expect(document.kind).toBe('error')
    expect(document.metadata).toMatchObject({
        source: 'fallback',
        evidence: 'local-deterministic',
        model: null,
        effort: null,
    })
    expect(Object.values(document.metadata.timing).every((value) => value === null)).toBe(true)
    expect(Object.values(document.metadata.usage).every((value) => value === null)).toBe(true)
    expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['fallback']))
    expect(hostsOutsideDocuments(screen.container as unknown as OwnershipTree, new Set([document.screenId]))).toEqual(
        [],
    )
    expect(parseNativeMeterMarkers(screen.getByTestId('document-navigation-root').props.nativeID)).toMatchObject({
        documentNavigation: document.screenId,
        origin: 'fallback',
    })
    expect(screen.getAllByTestId('bottom-bar')).toHaveLength(1)
    expect(StyleSheet.flatten(screen.getByTestId('app-unavailable-screen').props.style).paddingTop).toBe(32)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Home' })).toBeDisabled()
    expect(screen.getByText(/Home is unavailable until the app opens/u)).toBeTruthy()
    expect(screen.getByText(/Couldn’t open TrueBuild/u)).toBeTruthy()
    expect(reload).not.toHaveBeenCalled()
})

it('reloads only on an explicit Retry, prevents an overlapping attempt, and recovers from rejection without leaking it', async () => {
    let reject: (reason: Error) => void = () => undefined
    reload.mockImplementationOnce(
        () =>
            new Promise<void>((_resolve, rejectPromise) => {
                reject = rejectPromise
            }),
    )
    await render(wrap())
    expect(reload).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: 'Home' }))
    expect(reload).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalledTimes(1)
    const working = screen.getByRole('button', { name: 'Working…' })
    expect(working).toBeDisabled()
    await fireEvent.press(working)
    expect(reload).toHaveBeenCalledTimes(1)

    await act(() => reject(new Error('private initialization diagnostic must never be shown')))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled())
    expect(screen.getByText(/Close and reopen TrueBuild/u)).toBeTruthy()
    expect(screen.queryByText(/private initialization diagnostic/u)).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)

    reload.mockResolvedValueOnce(undefined)
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
})
