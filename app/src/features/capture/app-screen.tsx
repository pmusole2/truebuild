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
import { CaptureController, type WorkflowState } from './controller'
import { LibraryStorage, type Digest, type LibraryEntry } from './library'
import { GuideScreen, LibraryScreen, OverviewScreen, PagesScreen, SettingsScreen, stepAssemblyGuide } from './screens'
import { testRestoreDelayMs } from './test-controls'
import type { AssemblyGuide } from './camera-screen'
import { AppUnavailableScreen } from './app-unavailable'

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
    return runtime.controller === null ? <AppUnavailableScreen /> : <CaptureWorkflow controller={runtime.controller} />
}
/** The step guide shown over the assembly camera. Manual scanning has no step guide. */
function assemblyGuide(entry: LibraryEntry | undefined, state: WorkflowState): AssemblyGuide | undefined {
    if (entry === undefined || state.cameraIntent === null || state.cameraIntent.kind === 'page') {
        return undefined
    }
    return stepAssemblyGuide(entry.session, entry.stepIndex, state.pageUris)
}

export function CaptureWorkflow({ controller }: { controller: CaptureController }): ReactElement {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    // Settings are presentation-only state: they open over the library and change nothing that is stored or sent.
    const [settingsOpen, setSettingsOpen] = useState(false)
    useEffect(() => {
        // Test-only delay (development builds, query parameter) keeps the initial loading state visible for evidence capture.
        const delay = testRestoreDelayMs()
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        if (delay > 0) {
            timer = setTimeout((): void => {
                if (!cancelled) {
                    void controller.restore()
                }
            }, delay)
        } else {
            void controller.restore()
        }
        return (): void => {
            cancelled = true
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            controller.dispose()
        }
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
                intent={state.cameraIntent}
                guide={assemblyGuide(entry, state)}
                onCancel={controller.cancel}
                onCapture={(take): void => {
                    void controller.shutter(take)
                }}
            />
        )
    } else if (state.route === 'library' || entry === undefined) {
        screen = settingsOpen ? (
            <SettingsScreen state={state} onBack={(): void => setSettingsOpen(false)} />
        ) : (
            <LibraryScreen state={state} controller={controller} onOpenSettings={(): void => setSettingsOpen(true)} />
        )
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
