import { useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { Linking, Modal, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { API_BASE_URL } from '../../config'
import { useTheme } from '../../theme/theme'
import { space } from '../../theme/tokens'
import { AppButton } from '../../ui/button'
import { Body, Caption, Heading } from '../../ui/text'
import { aiConsent } from './consent-runtime'

/** App-owned disclosure: generated documents cannot author or accept this permission. */
export function AiConsentRoot(): ReactElement | null {
    const state = useSyncExternalStore(aiConsent.subscribe, aiConsent.getSnapshot, aiConsent.getSnapshot)
    const { colors } = useTheme()
    useEffect(() => {
        void aiConsent.restore()
    }, [])
    if (!state.visible) return null
    return (
        <Modal
            visible
            animationType="slide"
            onRequestClose={(): void => {
                void aiConsent.choose(false)
            }}
        >
            <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} testID="ai-consent-screen">
                <ScrollView
                    contentContainerStyle={{ flexGrow: 1, padding: space.lg, justifyContent: 'center', gap: space.lg }}
                >
                    <Heading>Before you use AI</Heading>
                    <Body>
                        TrueBuild sends your manual pages and photos to Meta's AI models to read the manual and check
                        your build. Photos aren't stored on our server.
                    </Body>
                    <Caption>
                        Images are processed in temporary server memory, not saved to server disk. Meta processes them
                        under its own terms; we don't control Meta's retention.
                    </Caption>
                    <AppButton
                        label="Privacy policy"
                        variant="quiet"
                        onPress={(): void => {
                            void Linking.openURL(new URL('/privacy', API_BASE_URL).toString()).catch(
                                (): void => undefined,
                            )
                        }}
                    />
                    {state.error === null ? null : <Body tone="refuse">{state.error}</Body>}
                    <View style={{ gap: space.sm }}>
                        <AppButton
                            label="Agree and continue"
                            variant="accent"
                            size="primary"
                            busy={state.saving}
                            testID="ai-consent-agree"
                            onPress={(): void => {
                                void aiConsent.choose(true)
                            }}
                        />
                        <AppButton
                            label="Not now"
                            variant="quiet"
                            disabled={state.saving}
                            testID="ai-consent-not-now"
                            onPress={(): void => {
                                void aiConsent.choose(false)
                            }}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        </Modal>
    )
}
