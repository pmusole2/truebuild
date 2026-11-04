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
const over = NORMALIZED_TARGET_BYTES + 1

afterEach(async () => {
    await releaseTemporaryImage(camera)
    for (let index = 1; index <= 3; index++) {
        await releaseTemporaryImage(`file:///app-normalized/${index}.jpg`)
    }
    globalThis.fetch = originalFetch
    jest.clearAllMocks()
})

it.each([
    {
        name: 'tall page, SDK rounding remains inside the output pixel budget',
        width: 2689,
        height: 21312,
        decoded: { maxWidth: 5765, maxHeight: 5765 },
        pixels: { width: 727, height: 5765 },
        sizes: [100],
        appCamera: false,
        success: true,
        resizes: [],
    },
    {
        name: 'out-of-budget codec dimensions are refused even when encoded bytes fit',
        width: 2689,
        height: 21312,
        decoded: { maxWidth: 5765, maxHeight: 5765 },
        pixels: { width: 728, height: 5766 },
        sizes: [100],
        appCamera: false,
        success: false,
        expectedFailure: 'pixels',
        resizes: [],
    },

    {
        name: 'normal page, first encode fits',
        width: 8064,
        height: 6048,
        decoded: { maxWidth: 1280, maxHeight: 1280 },
        pixels: { width: 1280, height: 960 },
        sizes: [100],
        appCamera: true,
        success: true,
        resizes: [],
    },
    {
        name: 'normal page, retries retain the existing width-only 80 percent resize',
        width: 8064,
        height: 6048,
        decoded: { maxWidth: 1280, maxHeight: 1280 },
        pixels: { width: 1280, height: 960 },
        sizes: [over, 100],
        appCamera: false,
        success: true,
        resizes: [{ width: 1024 }],
    },
    {
        name: 'normal page, unattainable budget retains both existing shrink attempts',
        width: 8064,
        height: 6048,
        decoded: { maxWidth: 1280, maxHeight: 1280 },
        pixels: { width: 1280, height: 960 },
        sizes: [over, over, over],
        appCamera: true,
        success: false,
        resizes: [{ width: 1024 }, { width: 819 }],
    },
    {
        // The 438-pixel short side is the readability floor: decode and every retry keep it, and only quality drops.
        name: 'tall strip, retries lower quality without shrinking the short side',
        width: 438,
        height: 2625,
        decoded: { maxWidth: 2625, maxHeight: 2625 },
        pixels: { width: 438, height: 2625 },
        sizes: [over, over, 100],
        appCamera: false,
        success: true,
        resizes: [],
    },
    {
        name: 'tall strip, unattainable budget rejects with no shrink',
        width: 438,
        height: 2625,
        decoded: { maxWidth: 2625, maxHeight: 2625 },
        pixels: { width: 438, height: 2625 },
        sizes: [over, over, over],
        appCamera: true,
        success: false,
        resizes: [],
    },
])(
    'normalizes $name and cleans only superseded app-owned files',
    async ({ width, height, decoded, pixels, sizes, appCamera, success, expectedFailure, resizes }) => {
        const files = new Map<string, Uint8Array>()
        let saves = 0
        const inputUri = appCamera ? camera : source
        const recorded: Array<{ width: number; height?: number }> = []
        let output = { ...pixels }
        files.set(inputUri, jpegHeader(width, height))
        if (appCamera) {
            ownTemporaryImage(inputUri)
        }
        const released = jest.mocked(removeTemporaryImage)
        const saveAsync = async (): Promise<{ uri: string; width: number; height: number }> => {
            const length = sizes[saves++]!
            const uri = `file:///app-normalized/${saves}.jpg`
            const bytes = new Uint8Array(length)
            bytes.set(jpegHeader(output.width, output.height))
            files.set(uri, bytes)
            return { uri, ...output }
        }
        const image = { saveAsync, release: (): void => undefined }
        const context = {
            renderAsync: async (): Promise<typeof image> => image,
            resize: (size: { width: number; height?: number }): unknown => {
                recorded.push(size)
                output = {
                    width: size.width,
                    height: size.height ?? Math.round((output.height * size.width) / output.width),
                }
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
        const pending = normalizeImage({ uri: inputUri, width, height, fileSize: 12_000_000 })
        if (success) {
            const result = await pending
            expect(result.bytes.length).toBeLessThanOrEqual(NORMALIZED_TARGET_BYTES)
            expect({ width: result.width, height: result.height }).toEqual(output)
            if (width === 438)
                expect({ width: result.width, height: result.height }).toEqual({ width: 438, height: 2625 })
            expect(result.uri).toBe(`file:///app-normalized/${sizes.length}.jpg`)
            expect(released.mock.calls.some(([uri]) => uri === result.uri)).toBe(false)
            if (appCamera) {
                expect(released.mock.calls.some(([uri]) => uri === camera)).toBe(true)
            }
            await releaseTemporaryImage(result.uri)
            expect(released.mock.calls.some(([uri]) => uri === result.uri)).toBe(true)
        } else {
            await expect(pending).rejects.toMatchObject({ failure: expectedFailure ?? 'oversize' })
        }
        expect(ImageManipulator.manipulate).toHaveBeenCalledWith(inputUri, decoded)
        expect(recorded).toEqual(resizes)
        expect(saves).toBe(sizes.length)
        for (let index = 1; index <= sizes.length - (success ? 1 : 0); index++) {
            expect(released.mock.calls.some(([uri]) => uri === `file:///app-normalized/${index}.jpg`)).toBe(true)
        }
        expect(released.mock.calls.some(([uri]) => uri === source)).toBe(false)
    },
)
