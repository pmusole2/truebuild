import type * as ReactModule from 'react'
import { Linking, type View } from 'react-native'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { createController, createDocuments, createScreens } from '../capture/controller-factory'
import { loadPhoto, mount, press, type Mounted } from '../screens/test-support/flow'
import { deferred, entry } from '../screens/test-support/route-harness'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import { documentInputs } from '../capture/document-surface'

jest.mock('expo-router/build/testing-library/mocks', () => ({}))
jest.mock('react', () => {
    const actual = jest.requireActual<typeof ReactModule>('react')
    return {
        ...actual,
        useEffectEvent: (callback: (...args: unknown[]) => unknown): ((...args: unknown[]) => unknown) => {
            const ref = actual.useRef(callback)
            actual.useLayoutEffect(() => {
                ref.current = callback
            })
            return actual.useCallback((...args: unknown[]) => ref.current(...args), [])
        },
    }
})
jest.mock('../capture/controller-factory', () => ({
    createController: jest.fn(),
    createScreens: jest.fn(),
    createDocuments: jest.fn(),
}))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('../ai-effort-proof/config', () => ({ nativeProofConfig: (): null => null }))
jest.mock('../../media/owned-temporary-images', () => ({
    ownTemporaryImage: jest.fn(),
    releaseTemporaryImage: jest.fn(async () => undefined),
}))

type Permission = { granted: boolean; canAskAgain: boolean }
let mockPermission: Permission | null = { granted: true, canAskAgain: true }
const mockRequestPermission = jest.fn<Promise<Permission>, []>()
const mockTakePicture = jest.fn<Promise<{ uri: string; width: number; height: number }>, []>()
const mockMounted = jest.fn()
const mockUnmounted = jest.fn()
jest.mock('expo-camera', () => {
    const React = jest.requireActual<typeof ReactModule>('react')
    return {
        useCameraPermissions: (): unknown[] => {
            const [permission, setPermission] = React.useState(mockPermission)
            return [
                permission,
                async (): Promise<Permission> => {
                    const next = await mockRequestPermission()
                    setPermission(next)
                    return next
                },
            ]
        },
        CameraView: React.forwardRef((props: Record<string, unknown>, ref): ReactModule.ReactElement => {
            React.useImperativeHandle(ref, () => ({ takePictureAsync: mockTakePicture }))
            React.useEffect(() => {
                mockMounted()
                return (): void => {
                    mockUnmounted()
                }
            }, [])
            return React.createElement(jest.requireActual<{ View: typeof View }>('react-native').View, {
                ...props,
                testID: 'hardware-preview',
            })
        }),
    }
})
let active: Mounted | null = null
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
const previousSkip = process.env.EXPO_PUBLIC_SKIP_TIPS
beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { search: '' } })
})
beforeEach(() => {
    process.env.EXPO_PUBLIC_SKIP_TIPS = '1'
    mockPermission = { granted: true, canAskAgain: true }
    mockRequestPermission.mockReset()
    mockTakePicture.mockReset().mockResolvedValue({ uri: 'file:///synthetic-camera.jpg', width: 600, height: 800 })
    mockMounted.mockClear()
    mockUnmounted.mockClear()
})
afterEach(async () => {
    await cleanup()
    active?.store.dispose()
    active?.controller.dispose()
    active = null
    jest.mocked(createController).mockReset()
    jest.mocked(createDocuments).mockReset()
    jest.mocked(createScreens).mockReset()
    jest.restoreAllMocks()
})
afterAll(() => {
    if (originalLocation === undefined) Reflect.deleteProperty(window, 'location')
    else Object.defineProperty(window, 'location', originalLocation)
    if (previousSkip === undefined) delete process.env.EXPO_PUBLIC_SKIP_TIPS
    else process.env.EXPO_PUBLIC_SKIP_TIPS = previousSkip
})
async function openCamera(): Promise<Mounted> {
    active = await mount([entry()], { screens: 'off' })
    await act(async () =>
        active!.controller.open(active!.controller.getSnapshot().entries[0]!.session.manualId, 'guide'),
    )
    await act(async () => active!.controller.camera({ kind: 'question' }))
    await waitFor(() => expect(active!.view.getPathname()).toBe('/camera'))
    return active
}

it('uses the real hardware camera port once and keeps its preview mounted while taking a photo', async () => {
    const picture = deferred<{ uri: string; width: number; height: number }>()
    mockTakePicture.mockReturnValue(picture.promise)
    const { controller, calls } = await openCamera()
    expect(screen.getByTestId('camera-shutter')).toBeDisabled()
    await fireEvent(screen.getByTestId('hardware-preview'), 'cameraReady')
    await fireEvent.press(screen.getByTestId('camera-shutter'))
    expect(mockTakePicture).toHaveBeenCalledWith({ quality: 1, skipProcessing: false, exif: false })
    expect(mockMounted).toHaveBeenCalledTimes(1)
    expect(mockUnmounted).not.toHaveBeenCalled()
    expect(screen.getByTestId('hardware-preview')).toBeTruthy()
    await act(async () => picture.resolve({ uri: 'file:///synthetic-camera.jpg', width: 600, height: 800 }))
    await waitFor(() => expect(controller.getSnapshot().capture?.reusable).toBe(true))
    expect(mockTakePicture).toHaveBeenCalledTimes(1)
    expect(ownTemporaryImage).toHaveBeenCalledWith('file:///synthetic-camera.jpg')
    expect(calls).toEqual([])
})

it('retries an actual camera mount error with a fresh native preview and waits for readiness', async () => {
    await openCamera()
    await fireEvent(screen.getByTestId('hardware-preview'), 'mountError', { message: 'Synthetic mount error' })
    expect(screen.queryByTestId('hardware-preview')).toBeNull()
    await fireEvent.press(await screen.findByRole('button', { name: 'Try camera again' }))
    expect(await screen.findByTestId('hardware-preview')).toBeTruthy()
    expect(mockMounted).toHaveBeenCalledTimes(2)
    expect(mockUnmounted).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('camera-shutter')).toBeDisabled()
    await fireEvent(screen.getByTestId('hardware-preview'), 'cameraReady')
    expect(screen.getByTestId('camera-shutter')).toBeEnabled()
})

it('requests real permission and preserves the permission cause when its OS promise rejects', async () => {
    mockPermission = null
    mockRequestPermission
        .mockRejectedValueOnce(new Error('Synthetic permission failure'))
        .mockResolvedValueOnce({ granted: true, canAskAgain: true })
    await openCamera()
    await fireEvent.press(await screen.findByRole('button', { name: 'Allow camera' }))
    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Try camera again' })).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Allow camera' }))
    expect(await screen.findByTestId('hardware-preview')).toBeTruthy()
    expect(screen.getByTestId('camera-shutter')).toBeDisabled()
})

it('opens OS settings for a permanent denial without reporting a camera hardware failure', async () => {
    mockPermission = { granted: false, canAskAgain: false }
    const settings = jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('Synthetic settings failure'))
    await openCamera()
    await fireEvent.press(await screen.findByRole('button', { name: 'Open settings' }))
    expect(settings).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try camera again' })).toBeNull()
})

it('cannot mutate the selected manual or its held photo through a valid generated Stepper in a real Compare pane', async () => {
    const first = entry('first-manual')
    const second = entry('second-manual')
    active = await mount([first, second], {
        screens: {
            arrange: (proposal, inputs) =>
                inputs.kind !== 'guide'
                    ? proposal
                    : {
                          ...proposal,
                          body: {
                              type: 'Stack',
                              gap: 'md',
                              align: 'stretch',
                              children: [{ type: 'Stepper', binding: 'steps', label: null }, proposal.body],
                          },
                      },
        },
    })
    const { controller } = active
    await act(async () => controller.open(first.session.manualId, 'guide'))
    await act(async () => controller.camera({ kind: 'question' }))
    await fireEvent(screen.getByTestId('hardware-preview'), 'cameraReady')
    await fireEvent.press(screen.getByTestId('camera-shutter'))
    await waitFor(() => expect(controller.getSnapshot().capture?.reusable).toBe(true))
    const capture = controller.getSnapshot().capture
    const step = jest.spyOn(controller, 'step')
    await press('More')
    await fireEvent.press(await screen.findByTestId('judge-entry'))
    await fireEvent.press(await screen.findByTestId('judge-built-toggle'))
    await fireEvent.press(await screen.findByRole('button', { name: 'Compare two manuals' }))
    await waitFor(() => expect(active!.view.getPathname()).toBe('/compare'))
    await fireEvent.press(screen.getByTestId('compare-choose-second-manual'))
    const pane = await screen.findByTestId('compare-pane-second-manual')
    const target = await within(pane).findByRole('button', { name: second.session.reviewedSteps[1]!.title })
    expect(target).toBeDisabled()
    await fireEvent.press(target)
    expect(step).not.toHaveBeenCalled()
    expect(controller.getSnapshot().selectedId).toBe(first.session.manualId)
    expect(controller.getSnapshot().capture).toBe(capture)
    expect(active.view.getPathname()).toBe('/compare')
})

it('keeps the same refused photo, immutable question and independently cited answer in contextual More without approval', async () => {
    const manual = entry()
    const firstPage = manual.session.pages[0]!
    const secondPage = { ...firstPage, pageId: 'more-page-2', assetId: 'more-asset-2' }
    manual.session.pages.push(secondPage)
    manual.session.reviewedSteps[0]!.sourceRefs.push({ pageId: secondPage.pageId, region: null })
    active = await mount([manual], {
        screens: {},
        replies: {
            check: {
                decision: 'refuse',
                reason: 'The joint faces outward.',
                sourceRefs: [{ pageId: firstPage.pageId, region: null }],
                missingEvidence: ['The reverse face is hidden.'],
            },
            answer: {
                answer: 'Use the manual picture to turn the joint inward.',
                sourceRefs: [{ pageId: secondPage.pageId, region: null }],
                missingEvidence: ['The bolt label is hidden.'],
            },
        },
    })
    const { controller, server } = active
    await act(async () => controller.open(manual.session.manualId, 'guide'))
    await act(async () => controller.camera({ kind: 'check' }))
    await fireEvent(screen.getByTestId('hardware-preview'), 'cameraReady')
    await fireEvent.press(screen.getByTestId('camera-shutter'))
    await waitFor(() => expect(controller.getSnapshot().check?.decision).toBe('refuse'))
    await loadPhoto()
    const held = controller.getSnapshot().capture
    const refused = controller.getSnapshot().check
    const staleInputs = documentInputs(
        'more',
        {
            state: {
                ...controller.getSnapshot(),
                capture: { ...held!, binding: { ...held!.binding, stepId: 'another-step' } },
            },
            entry: controller.current,
        },
        undefined,
        true,
    )
    expect(staleInputs.captureId).toBeNull()
    expect(staleInputs.result).toBeNull()
    expect(staleInputs.uiState?.capture).toBeNull()
    await waitFor(() =>
        expect(
            server.requests.some(
                (request) =>
                    request.op === 'generate' &&
                    request.kind === 'more' &&
                    request.stepId !== null &&
                    request.captureId === held!.binding.captureId &&
                    request.result?.kind === 'check',
            ),
        ).toBe(true),
    )
    await press('More')
    const moreImage = await screen.findByTestId('frozen-photo-image')
    await loadPhoto()
    let sheet = screen.getByTestId('more-sheet')
    expect(await within(sheet).findByText(refused!.reason)).toBeTruthy()
    expect(screen.getByTestId('frozen-photo-image')).toBe(moreImage)
    expect(within(sheet).getByText('The reverse face is hidden.')).toBeTruthy()
    await fireEvent.press(within(sheet).getByRole('button', { name: 'Ask about this step' }))
    expect(screen.getAllByTestId('more-sheet')).toHaveLength(1)
    await fireEvent(screen.getByTestId('frozen-photo-frame'), 'accessibilityTap')
    const submitted = 'Which way should this joint face?'
    await fireEvent.changeText(screen.getByLabelText('Your question'), `  ${submitted}  `)
    await fireEvent.press(within(screen.getByTestId('more-sheet')).getByTestId('guide-primary'))
    await waitFor(() => expect(controller.getSnapshot().answer).not.toBeNull())
    await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
    await loadPhoto()
    await waitFor(() =>
        expect(
            server.requests.some(
                (request) =>
                    request.op === 'generate' &&
                    request.kind === 'more' &&
                    request.companionAnswer?.question === submitted,
            ),
        ).toBe(true),
    )
    await press('More')
    await loadPhoto()
    sheet = screen.getByTestId('more-sheet')
    const checkCard = within(sheet).getByTestId('document-check-result')
    const answerCard = within(sheet).getByTestId('document-question-result')
    expect(within(sheet).getByText(submitted)).toBeTruthy()
    expect(within(checkCard).getByText(refused!.reason)).toBeTruthy()
    expect(within(checkCard).getByText('The reverse face is hidden.')).toBeTruthy()
    expect(within(checkCard).queryByText('The bolt label is hidden.')).toBeNull()
    expect(within(answerCard).getByText(controller.getSnapshot().answer!.answer)).toBeTruthy()
    expect(within(answerCard).getByText('The bolt label is hidden.')).toBeTruthy()
    expect(within(answerCard).queryByText('The reverse face is hidden.')).toBeNull()
    await fireEvent.press(within(checkCard).getByRole('button', { name: 'See it in the manual' }))
    await fireEvent.press(within(answerCard).getByRole('button', { name: 'See it in the manual' }))
    expect(within(checkCard).getByText('Picture from your manual · Page 1')).toBeTruthy()
    expect(within(answerCard).getByText('Picture from your manual · Page 2')).toBeTruthy()
    expect(within(sheet).queryByText('Looks right')).toBeNull()
    expect(controller.getSnapshot().capture).toBe(held)
    expect(controller.getSnapshot().check).toBe(refused)
    expect(controller.current?.completedStepIds).toEqual([])
    expect(mockTakePicture).toHaveBeenCalledTimes(1)
    const global = documentInputs('more', { state: controller.getSnapshot(), entry: controller.current })
    expect(global).toMatchObject({ session: null, stepId: null, captureId: null, result: null })
    expect(global.companionAnswer).toBeUndefined()
    await fireEvent.press(within(sheet).getByTestId('close-sheet'))
    await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull())
    await act(async () => controller.open(manual.session.manualId, 'guide'))
    await waitFor(() => expect(controller.getSnapshot().capture?.reusable).toBe(false))
    await press('More')
    sheet = screen.getByTestId('more-sheet')
    expect(within(sheet).getByTestId('frozen-photo-image')).toBeTruthy()
    expect(within(sheet).queryByTestId('document-check-result')).toBeNull()
    expect(within(sheet).queryByTestId('document-question-result')).toBeNull()
    expect(within(sheet).getByRole('button', { name: 'Ask about this step' })).toBeDisabled()
    const target = jest.spyOn(controller, 'targetChanged')
    await fireEvent(within(sheet).getByTestId('frozen-photo-frame'), 'accessibilityTap')
    expect(target).not.toHaveBeenCalled()
    expect(controller.getSnapshot().target).toBeNull()
    expect(controller.getSnapshot().check).toBeNull()
    expect(mockTakePicture).toHaveBeenCalledTimes(1)
})
