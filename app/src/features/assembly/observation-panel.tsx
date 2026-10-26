import { useRef, useState, type ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { palette, space } from '../../components/theme'
import { ActionButton, Notice, Panel, SectionTitle } from '../../components/ui'
import { observationFromCapture, pickObservationFromLibrary, type Observation } from './observation'
import { userMessageForImportError } from '../manuals/import-errors'

type ObservationPanelProps = {
    readonly onObservation: (observation: Observation) => void
    readonly disabled: boolean
}

const CAMERA_HEIGHT = 320

/**
 * Mounted only after the user presses "Use camera". The permission request and the camera preview therefore never
 * start on their own; denial or failure returns the user to the library picker.
 */
function CameraCapture({
    disabled,
    onObservation,
    onFallback,
    onClose,
}: ObservationPanelProps & {
    readonly onFallback: (message: string) => void
    readonly onClose: () => void
}): ReactElement {
    const [permission, requestPermission] = useCameraPermissions()
    const cameraRef = useRef<CameraView | null>(null)
    const [busy, setBusy] = useState(false)

    async function allow(): Promise<void> {
        const response = await requestPermission()
        if (!response.granted) {
            onFallback('Camera access was not allowed. Choose a photo from your library instead.')
        }
    }

    async function take(): Promise<void> {
        if (busy || cameraRef.current === null) {
            return
        }
        setBusy(true)
        try {
            const picture = await cameraRef.current.takePictureAsync({ quality: 0.92 })
            const observation = await observationFromCapture({
                uri: picture.uri,
                width: picture.width,
                height: picture.height,
            })
            onObservation(observation)
            onClose()
        } catch (error: unknown) {
            onFallback(userMessageForImportError(error))
        } finally {
            setBusy(false)
        }
    }

    if (permission?.granted !== true) {
        return (
            <View style={styles.stack}>
                <Notice text="The camera is used only for this photo. It is not saved to the manual and stays on this device until you choose to send it for a check. Temporary platform cache copies may remain until the device clears them; this app does not clean them up." />
                <View style={styles.actions}>
                    <ActionButton
                        label="Allow camera"
                        tone="primary"
                        disabled={disabled}
                        onPress={() => void allow()}
                    />
                    <ActionButton label="Cancel camera" onPress={onClose} />
                </View>
            </View>
        )
    }

    return (
        <View style={styles.stack}>
            <CameraView ref={cameraRef} facing="back" style={styles.camera} />
            <View style={styles.actions}>
                <ActionButton
                    label={busy ? 'Taking photo…' : 'Take photo'}
                    tone="primary"
                    disabled={busy || disabled}
                    onPress={() => void take()}
                />
                <ActionButton label="Cancel camera" onPress={onClose} />
            </View>
        </View>
    )
}

export function ObservationPanel({ onObservation, disabled }: ObservationPanelProps): ReactElement {
    const [cameraOpen, setCameraOpen] = useState(false)
    const [notice, setNotice] = useState<string | null>(null)
    const [importing, setImporting] = useState(false)

    async function importFromLibrary(): Promise<void> {
        if (importing) {
            return
        }
        setImporting(true)
        setNotice(null)
        try {
            const observation = await pickObservationFromLibrary()
            if (observation !== null) {
                onObservation(observation)
            }
        } catch (error: unknown) {
            setNotice(userMessageForImportError(error))
        } finally {
            setImporting(false)
        }
    }

    return (
        <Panel>
            <SectionTitle>Photo of your assembly</SectionTitle>
            <Text style={styles.body}>
                A fresh photo of the assembly for this check. It is never a manual page and is not saved to the manual.
            </Text>
            {cameraOpen ? (
                <CameraCapture
                    disabled={disabled}
                    onObservation={onObservation}
                    onFallback={(message) => {
                        setNotice(message)
                        setCameraOpen(false)
                    }}
                    onClose={() => setCameraOpen(false)}
                />
            ) : (
                <View style={styles.actions}>
                    <ActionButton
                        label={importing ? 'Importing photo…' : 'Choose fresh photo'}
                        tone="primary"
                        disabled={disabled || importing}
                        onPress={() => void importFromLibrary()}
                    />
                    <ActionButton
                        label="Use camera for a fresh photo"
                        disabled={disabled}
                        onPress={() => {
                            setNotice(null)
                            setCameraOpen(true)
                        }}
                    />
                </View>
            )}
            {notice === null ? null : <Notice tone="error" text={notice} />}
        </Panel>
    )
}

const styles = StyleSheet.create({
    body: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 22,
    },
    stack: {
        gap: space.sm,
    },
    camera: {
        height: CAMERA_HEIGHT,
        width: '100%',
        borderRadius: 4,
        overflow: 'hidden',
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
})
