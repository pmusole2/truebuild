import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { LIMITS, type ManualPage } from '@truebuild/contracts'
import { readCappedResponse } from '../../media/capped-read'
import { MediaRejectedError } from '../../media/media-errors'
import { normalizeImage } from '../../media/normalize-image'
import { SEGMENTATION_MAX_PIXELS, segmentationSize } from './segmentation-size'

/**
 * One photo of the assembly for one capture. It is held in memory only: it is never saved, and it is sent to the
 * configured backend only when the user asks for a check, a question or a part search. A new capture replaces it.
 */
export type Observation = {
    readonly bytes: Uint8Array<ArrayBuffer>
    readonly mimeType: ManualPage['mimeType']
    readonly width: number
    readonly height: number
    readonly uri: string
}

export type PhotoSource = 'camera' | 'library'

/** Null when the user cancels; nothing is captured and the current photo stays in place. */
export async function captureObservation(source: PhotoSource): Promise<Observation | null> {
    const options = { mediaTypes: ['images'] as ['images'], allowsMultipleSelection: false }
    const result =
        source === 'camera'
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync(options)
    const asset = result.assets?.[0]
    if (result.canceled || asset === undefined) {
        return null
    }
    return normalizeImage(asset)
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
