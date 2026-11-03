import { useState, type ReactElement } from 'react'
import { Stack, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StyleSheet, View } from 'react-native'
import { HERO_DIAGRAM_PNG_BASE64 } from '@truebuild/contracts/hero'
import { ThemeProvider } from '../../theme/theme'
import { darkColors, space } from '../../theme/tokens'
import { AppButton } from '../button'
import { BlueprintLoader, LoaderSwap, type BlueprintPhase } from '../blueprint-loader'
import { FeedbackProvider } from '../feedback'
import { Body, Caption, Heading } from '../text'
import { STOOL_PHOTO_PNG_BASE64 } from './synthetic-stool-photo-png'
import { PiecesGrid } from '../../features/pieces/piece-viewer'
import { VIEWER_FIXTURE_PIECES } from '../../features/pieces/__fixtures__/piece-spec'

const PIECE = VIEWER_FIXTURE_PIECES[0]!
const PIECE_ITEMS = [{ pieceId: PIECE.id, name: PIECE.name, quantity: 1, state: 'pending' as const }]

/** Actual native loader components with synthetic local images; no controller, camera or API calls. */
export default function BlueprintPreview(): ReactElement {
    const { phase, motion } = useLocalSearchParams<{ phase?: string; motion?: string }>()
    const scene: BlueprintPhase = phase === 'reading' || phase === 'piece' || phase === 'check' ? phase : 'guide'
    const [ready, setReady] = useState(false)
    return (
        <ThemeProvider scheme="dark">
            <FeedbackProvider reduceMotion={motion === 'static' ? true : null}>
                <Stack.Screen options={{ headerShown: false }} />
                <StatusBar style="light" />
                <SafeAreaView style={styles.screen}>
                    <Caption>TRUEBUILD · OFFLINE FIXTURE</Caption>
                    <Heading>
                        {scene === 'reading' ? 'Your manual' : scene === 'check' ? 'Your build' : 'Your guide'}
                    </Heading>
                    <View style={styles.slot}>
                        {scene === 'piece' ? (
                            <PiecesGrid
                                pieces={ready ? [PIECE] : []}
                                items={PIECE_ITEMS}
                                cutouts={{ [PIECE.id]: `data:image/png;base64,${HERO_DIAGRAM_PNG_BASE64}` }}
                            />
                        ) : (
                            <LoaderSwap
                                key={scene}
                                waiting={!ready}
                                loader={
                                    <BlueprintLoader
                                        phase={scene}
                                        pageCount={scene === 'reading' ? 8 : undefined}
                                        stepNumber={scene === 'guide' ? 2 : undefined}
                                        imageUri={
                                            scene === 'check'
                                                ? `data:image/png;base64,${STOOL_PHOTO_PNG_BASE64}`
                                                : undefined
                                        }
                                    />
                                }
                            >
                                <View style={styles.arrival}>
                                    <Body>Fixture content is ready.</Body>
                                </View>
                            </LoaderSwap>
                        )}
                    </View>
                    <AppButton label={ready ? 'Show loader' : 'Show arrival'} onPress={(): void => setReady(!ready)} />
                    <Caption>Synthetic scene proof · no model request</Caption>
                </SafeAreaView>
            </FeedbackProvider>
        </ThemeProvider>
    )
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: darkColors.canvas, padding: space.lg, gap: space.lg },
    slot: { flex: 1, justifyContent: 'center' },
    arrival: { minHeight: 280, alignItems: 'center', justifyContent: 'center' },
})
