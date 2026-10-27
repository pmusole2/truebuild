import { ImageManipulator } from 'expo-image-manipulator'
import { normalizeImage } from './normalize-image'
import { ownTemporaryImage, releaseTemporaryImage } from './owned-temporary-images'
import { removeTemporaryImage } from './temporary-image-storage'
import { jpegHeader } from './test-fixtures'
import { NORMALIZED_TARGET_BYTES } from './normalization-policy'

// Same SDK boundary used by the existing demo tests: real normalization orchestration/header validation, synthetic codec IO.
jest.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: { manipulate: jest.fn() },
}))
jest.mock('./temporary-image-storage', () => ({ removeTemporaryImage: jest.fn(async (): Promise<void> => undefined) }))

const source = 'file:///photo-library/original.jpg'
const camera = 'file:///app-camera/capture.jpg'
const originalFetch = globalThis.fetch

afterEach(async () => {
    await releaseTemporaryImage(camera)
    for (let index = 1; index <= 3; index++) {
        await releaseTemporaryImage(`file:///app-normalized/${index}.jpg`)
    }
    globalThis.fetch = originalFetch
    jest.clearAllMocks()
})

it.each([
    { name: 'success', sizes: [100], appCamera: true, success: true },
    { name: 'reduction', sizes: [NORMALIZED_TARGET_BYTES + 1, 100], appCamera: false, success: true },
    {
        name: 'unattainable budget',
        sizes: [NORMALIZED_TARGET_BYTES + 1, NORMALIZED_TARGET_BYTES + 1, NORMALIZED_TARGET_BYTES + 1],
        appCamera: true,
        success: false,
    },
])(
    'normalizes with bounded $name and cleans only superseded app-owned files',
    async ({ sizes, appCamera, success }) => {
        const files = new Map<string, Uint8Array>()
        let saves = 0
        let reductions = 0
        const inputUri = appCamera ? camera : source
        files.set(inputUri, jpegHeader(8064, 6048))
        if (appCamera) {
            ownTemporaryImage(inputUri)
        }
        const released = jest.mocked(removeTemporaryImage)
        const saveAsync = async (): Promise<{ uri: string; width: number; height: number }> => {
            const length = sizes[saves++]!
            const uri = `file:///app-normalized/${saves}.jpg`
            const bytes = new Uint8Array(length)
            bytes.set(jpegHeader(800, 600))
            files.set(uri, bytes)
            return { uri, width: 800, height: 600 }
        }
        const image = { saveAsync, release: (): void => undefined }
        const context = {
            renderAsync: async (): Promise<typeof image> => image,
            resize: (): unknown => {
                reductions++
                return context
            },
            release: (): void => undefined,
        }
        // Native SharedObjects are unavailable in Jest; the SDK boundary is represented explicitly, as in existing tests.
        jest.mocked(ImageManipulator.manipulate).mockImplementation(
            () => context as unknown as ReturnType<typeof ImageManipulator.manipulate>,
        )
        globalThis.fetch = jest.fn(async (input: string | URL | Request): Promise<Response> => {
            const bytes = files.get(String(input))
            if (bytes === undefined) {
                throw new Error('Unknown synthetic SDK file')
            }
            return new Response(Uint8Array.from(bytes))
        })
        const pending = normalizeImage({ uri: inputUri, width: 8064, height: 6048, fileSize: 12_000_000 })
        if (success) {
            const result = await pending
            expect(result.bytes.length).toBeLessThanOrEqual(NORMALIZED_TARGET_BYTES)
            expect(result.width).toBe(800)
            expect(result.height).toBe(600)
            expect(result.uri).toBe(`file:///app-normalized/${sizes.length}.jpg`)
            expect(released.mock.calls.some(([uri]) => uri === result.uri)).toBe(false)
            if (appCamera) {
                expect(released.mock.calls.some(([uri]) => uri === camera)).toBe(true)
            }
            await releaseTemporaryImage(result.uri)
            expect(released.mock.calls.some(([uri]) => uri === result.uri)).toBe(true)
        } else {
            await expect(pending).rejects.toMatchObject({ failure: 'oversize' })
        }
        expect(saves).toBe(sizes.length)
        expect(reductions).toBe(sizes.length - 1)
        for (let index = 1; index <= sizes.length - (success ? 1 : 0); index++) {
            expect(released.mock.calls.some(([uri]) => uri === `file:///app-normalized/${index}.jpg`)).toBe(true)
        }
        expect(released.mock.calls.some(([uri]) => uri === source)).toBe(false)
        expect(ImageManipulator.manipulate).toHaveBeenCalledWith(inputUri, { maxWidth: 1280, maxHeight: 1280 })
    },
)
