import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Button, Text } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as Crypto from 'expo-crypto'
import { deviceStorage } from './device-storage'
import { API_BASE_URL, API_SECRET, developmentHost } from '../../config'
import { ModelApiClient } from '../../api/model-client'
import { MediaRejectedError } from '../../media/media-errors'
import { normalizeImage } from '../../media/normalize-image'
import { CameraScreen } from './camera-screen'
import { CaptureController } from './controller'
import { LibraryStorage, type Digest } from './library'
import { GuideScreen, LibraryScreen, OverviewScreen, PagesScreen, Screen } from './screens'

export const imageDigest: Digest = async (bytes): Promise<string> => {
    const result = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes))
    return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, '0')).join('')
}
function createController(): CaptureController {
    return new CaptureController({
        storage: new LibraryStorage(deviceStorage, imageDigest),
        client: new ModelApiClient({ baseUrl: API_BASE_URL, secret: API_SECRET }),
        normalize: normalizeImage,
        digest: imageDigest,
        id: (): string => Crypto.randomUUID(),
    })
}
/** Production route always uses ModelApiClient. Synthetic state belongs in tests or the UI owner's explicit preview. */
export function CaptureApp(): ReactElement {
    const [runtime] = useState((): { controller: CaptureController | null } => {
        try {
            return { controller: createController() }
        } catch {
            return { controller: null }
        }
    })
    return runtime.controller === null ? (
        <Screen title="TrueBuild">
            <Text>API configuration is unavailable. Configure a valid TrueBuild API origin for this build.</Text>
        </Screen>
    ) : (
        <CaptureWorkflow controller={runtime.controller} />
    )
}
export function CaptureWorkflow({ controller }: { controller: CaptureController }): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    useEffect(() => {
        void controller.restore()
        return controller.dispose
    }, [controller])
    const entry = controller.current
    function choosePages(replaceIndex?: number): void {
        void controller.importPages(async () => {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
            if (!permission.granted) {
                throw new MediaRejectedError('permission')
            }
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsMultipleSelection: replaceIndex === undefined,
                selectionLimit: replaceIndex === undefined ? Math.max(1, 20 - (entry?.session.pages.length ?? 0)) : 1,
                orderedSelection: true,
                exif: false,
                quality: 1,
            })
            return result.canceled ? [] : result.assets
        }, replaceIndex)
    }
    let screen: ReactElement
    if (state.route === 'camera') {
        screen = (
            <CameraScreen
                busy={state.pending !== null}
                onCancel={controller.cancel}
                onCapture={(take): void => {
                    void controller.shutter(take)
                }}
            />
        )
    } else if (state.route === 'library' || entry === undefined) {
        screen = <LibraryScreen state={state} controller={controller} />
    } else if (state.route === 'pages') {
        screen = (
            <PagesScreen
                key={entry.session.manualId}
                state={state}
                controller={controller}
                entry={entry}
                choosePages={choosePages}
            />
        )
    } else if (state.route === 'overview') {
        screen = (
            <OverviewScreen
                key={`${entry.session.manualId}-${entry.session.revision}`}
                state={state}
                controller={controller}
                entry={entry}
            />
        )
    } else {
        screen = <GuideScreen state={state} controller={controller} entry={entry} />
    }
    return (
        <>
            {screen}
            {__DEV__ && state.route !== 'camera' ? (
                <Text testID="development-api-host">Meta · {developmentHost(API_BASE_URL)}</Text>
            ) : null}
        </>
    )
}

/** Explicit UI-test/preview entry: callers supply a real controller with provider-boundary transport fixtures.
 * Never linked from the production route and never selects fixture mode as a fallback.
 */
export function CapturePreview({ controller }: { controller: CaptureController }): ReactElement {
    return (
        <>
            <Text>Automated preview · synthetic inputs</Text>
            <CaptureWorkflow controller={controller} />
            <Button title="Reset preview navigation" onPress={controller.home} />
        </>
    )
}
