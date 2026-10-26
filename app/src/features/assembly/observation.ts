import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { LIMITS, type ManualPage } from '@truebuild/contracts'
import { readCappedResponse } from '../../media/capped-read'
import { MediaRejectedError } from '../../media/media-errors'
import { normalizeImage } from '../../media/normalize-image'
import { SEGMENTATION_MAX_PIXELS, segmentationSize } from './segmentation-size'

/**
 * One photo for one capture, held in memory and sent only when the user asks for a check, question or part search.
 * A new capture replaces it. Native picker and manipulator outputs are temporary platform cache files; this app does not
 * delete them, so they may remain until the platform clears its cache.
 */
export type Observation = {
    readonly bytes: Uint8Array<ArrayBuffer>
    readonly mimeType: ManualPage['mimeType']
    readonly width: number
    readonly height: number
    readonly uri: string
}

export type PhotoSource = 'camera' | 'library'

export type CaptureResult =
    | { readonly status: 'picked'; readonly observation: Observation }
    | { readonly status: 'cancelled' }
    | { readonly status: 'denied' }

/**
 * Camera use requests permission explicitly first; the native picker refuses to open the camera without it. A denied or
 * cancelled request ends here: no picker result, no bytes and no network use.
 */
export async function captureObservation(source: PhotoSource): Promise<CaptureResult> {
    const options = { mediaTypes: ['images'] as ['images'], allowsMultipleSelection: false }
    if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync()
        if (!permission.granted) {
            return { status: 'denied' }
        }
    }
    const result =
        source === 'camera'
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync(options)
    const asset = result.assets?.[0]
    if (result.canceled || asset === undefined) {
        return { status: 'cancelled' }
    }
    return { status: 'picked', observation: await normalizeImage(asset) }
}

/**
 * Returns the observation itself when it is already within the ceiling; otherwise re-renders it at the reduced size.
 * Normalized box coordinates from the model refer to the whole image, so they stay valid after this resize.
 */
export async function observationForSegmentation(observation: Observation): Promise<Observation> {
    const target = segmentationSize(observation.width, observation.height)
    if (target.width === observation.width && target.height === observation.height) {
        return observation
    }

    const rendered = await ImageManipulator.manipulate(observation.uri)
        .resize({ width: target.width, height: target.height })
        .renderAsync()
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 })
    const bytes = await readCappedResponse(await fetch(saved.uri), LIMITS.imageBytes)
    if (saved.width * saved.height > SEGMENTATION_MAX_PIXELS) {
        throw new MediaRejectedError('pixels')
    }
    return { bytes, mimeType: observation.mimeType, width: saved.width, height: saved.height, uri: saved.uri }
}
