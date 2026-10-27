import { useRef, useState, type ReactElement } from 'react'
import { Button, Linking, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import type { SourceImageAsset } from '../../media/normalize-image'

export type CameraScreenProps = {
    busy: boolean
    onCancel: () => void
    onCapture: (take: () => Promise<SourceImageAsset>) => void
}
/** Rear camera only; processing remains enabled so camera EXIF orientation is applied before normalization. */
export function CameraScreen({ busy, onCancel, onCapture }: CameraScreenProps): ReactElement {
    const camera = useRef<CameraView>(null)
    const [permission, requestPermission] = useCameraPermissions()
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    if (permission === null || !permission.granted) {
        return (
            <SafeAreaView style={styles.fallback}>
                <Text>Camera permission is needed to photograph manual pages or assembly steps.</Text>
                <Button
                    title="Allow camera"
                    onPress={(): void => {
                        void requestPermission().catch((): void => setError(true))
                    }}
                />
                {permission?.canAskAgain === false ? (
                    <Button
                        title="Open device settings"
                        onPress={(): void => {
                            void Linking.openSettings().catch((): void => setError(true))
                        }}
                    />
                ) : null}
                {error ? (
                    <Text>
                        Camera access unavailable. Retry, use device settings, or choose manual pages from photos.
                    </Text>
                ) : null}
                <Button title="Back" onPress={onCancel} />
            </SafeAreaView>
        )
    }
    return (
        <View style={styles.full}>
            {error ? (
                <SafeAreaView style={styles.fallback}>
                    <Text>
                        Camera unavailable. Close other camera apps and retry, or return to choose pages from photos.
                    </Text>
                    <Button
                        title="Retry camera"
                        onPress={(): void => {
                            setError(false)
                            setReady(false)
                            setAttempt(attempt + 1)
                        }}
                    />
                </SafeAreaView>
            ) : (
                <CameraView
                    key={attempt}
                    ref={camera}
                    facing="back"
                    mode="picture"
                    style={StyleSheet.absoluteFill}
                    onCameraReady={(): void => setReady(true)}
                    onMountError={(): void => {
                        setError(true)
                        setReady(false)
                    }}
                />
            )}
            <SafeAreaView style={styles.controls}>
                <Text style={styles.caption}>Frame the page or current assembly step clearly.</Text>
                <Button
                    title={busy ? 'Preparing photo…' : 'Capture photo'}
                    disabled={!ready || error || busy}
                    onPress={(): void => {
                        const view = camera.current
                        if (view === null) {
                            return
                        }
                        onCapture(async (): Promise<SourceImageAsset> => {
                            const picture = await view.takePictureAsync({
                                quality: 1,
                                skipProcessing: false,
                                exif: false,
                            })
                            ownTemporaryImage(picture.uri)
                            return { uri: picture.uri, width: picture.width, height: picture.height }
                        })
                    }}
                />
                <Button title="Cancel camera" onPress={onCancel} />
            </SafeAreaView>
        </View>
    )
}
const styles = StyleSheet.create({
    full: { flex: 1, backgroundColor: '#000' },
    controls: { marginTop: 'auto', padding: 20, gap: 16, backgroundColor: '#0009' },
    caption: { color: '#fff' },
    fallback: { flex: 1, padding: 20, justifyContent: 'center', gap: 16 },
})
