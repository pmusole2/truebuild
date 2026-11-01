import { useCallback, useRef, useState, type ReactElement } from 'react'
import { Stack as RouterStack } from 'expo-router'
import { Text, View } from 'react-native'
import { AppButton } from '../../../ui/button'
import { Card, Screen, Stack } from '../../../ui/surface'
import { Body, Caption, Heading, Title } from '../../../ui/text'
import { PieceViewer, PiecesGrid } from '../piece-viewer'
import { HERO_DIAGRAM_PNG_BASE64 } from '@truebuild/contracts/hero'
import { VIEWER_FIXTURE_PIECES } from './piece-spec'

/** Explicit dev-only fixture route. Counters observe completed renders; they never animate the viewer. */
export default function PieceViewerFixture(): ReactElement {
    const samples = useRef<number[]>([])
    const started = useRef<number | null>(null)
    const firstFrame = useRef(false)
    const [ready, setReady] = useState(false)
    const [measuring, setMeasuring] = useState(false)
    const [result, setResult] = useState('No measurement yet')
    const onFrame = useCallback((timestampMs: number): void => {
        if (!firstFrame.current) {
            firstFrame.current = true
            setReady(true)
        }
        if (started.current !== null && samples.current.length < 10_000) samples.current.push(timestampMs)
    }, [])
    const measure = (): void => {
        if (started.current === null) {
            samples.current = []
            started.current = performance.now()
            setMeasuring(true)
            return
        }
        const windowMs = performance.now() - started.current
        started.current = null
        setMeasuring(false)
        const frames = samples.current
        const first = frames[0]
        const last = frames.at(-1)
        const renderedSpanMs = first === undefined || last === undefined ? 0 : last - first
        setResult(
            JSON.stringify({
                frames: frames.length,
                windowMs,
                renderedSpanMs,
                renderedFps: renderedSpanMs > 0 ? ((frames.length - 1) * 1000) / renderedSpanMs : 0,
                samples: frames,
            }),
        )
    }
    return (
        <>
            <RouterStack.Screen options={{ headerShown: false }} />
            <Screen testID="piece-viewer-fixture" header="hidden">
                <Stack gap="md">
                    <Caption>Test fixture · viewer only</Caption>
                    <Title>Assembly pieces</Title>
                    <Body>Tap a piece to inspect it. Drag to rotate, pinch to zoom, and double-tap to reset.</Body>
                    <PiecesGrid pieces={VIEWER_FIXTURE_PIECES} onFrame={onFrame} />
                    <View testID="piece-fixture-cutout-fallback">
                        <PieceViewer
                            piece={{ name: 'Unresolved assembly piece', parts: [] }}
                            fallbackImageUri={`data:image/png;base64,${HERO_DIAGRAM_PNG_BASE64}`}
                            height={200}
                        />
                    </View>
                    <Text testID="piece-viewer-ready">{ready ? '3D ready' : 'Preparing 3D preview'}</Text>
                    <Card>
                        <Heading>Render cadence measurement</Heading>
                        <Caption>
                            Start, rotate, then stop. Counts draw submissions; idle time creates no frames.
                        </Caption>
                        <AppButton
                            testID="piece-viewer-measure"
                            label={measuring ? 'Stop measurement' : 'Start measurement'}
                            onPress={measure}
                        />
                        <View accessibilityLiveRegion="polite">
                            <Text testID="piece-viewer-fps">{result}</Text>
                        </View>
                    </Card>
                </Stack>
            </Screen>
        </>
    )
}
