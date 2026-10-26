import { LIMITS, type ManualPage } from '@truebuild/contracts'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { readCappedResponse } from '../manuals/capped-read'
import { ImportRejectedError } from '../manuals/import-errors'
import { normalizeImage, type SourceImageAsset } from '../manuals/import-pages'
import { SEGMENTATION_MAX_PIXELS, segmentationSize } from './segmentation-size'

/**
 * A photo of the assembly for one check. It is never a manual page and is never written to the manual. It is kept on this
 * device until the user chooses to send it for a check. Native picker and manipulator outputs are temporary platform cache
 * files: they may remain until the device clears them, and this app does not clean them up. The capture identity (in the
 * binding) changes with every new photo.
 */
export type Observation = {
    readonly bytes: Uint8Array<ArrayBuffer>
    readonly mimeType: ManualPage['mimeType']
    readonly width: number
    readonly height: number
    readonly uri: string
}

const OBSERVATION_MIME: ManualPage['mimeType'] = 'image/jpeg'

async function toObservation(asset: SourceImageAsset): Promise<Observation> {
    const normalized = await normalizeImage(asset)
    return {
        bytes: normalized.bytes,
        mimeType: OBSERVATION_MIME,
        width: normalized.width,
        height: normalized.height,
        uri: normalized.uri,
    }
}

/** Fresh observation from the photo library. Returns null when the user cancels; nothing is stored. */
export async function pickObservationFromLibrary(): Promise<Observation | null> {
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
    })
    const asset = result.assets?.[0]
    if (result.canceled || asset === undefined) {
        return null
    }
    return toObservation(asset)
}

/** Observation from an explicit camera capture (the caller owns the camera UI and its permission step). */
export async function observationFromCapture(asset: SourceImageAsset): Promise<Observation> {
    return toObservation(asset)
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
        throw new ImportRejectedError('pixels')
    }
    return { bytes, mimeType: OBSERVATION_MIME, width: saved.width, height: saved.height, uri: saved.uri }
}
