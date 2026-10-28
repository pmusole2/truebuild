import type { ReactElement } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { AppButton } from '../../ui/button'
import { Card, Stack } from '../../ui/surface'
import { Body, Callout, Caption, Heading, Label } from '../../ui/text'
import { Icon } from '../../ui/icons'
import { space } from '../../theme/tokens'
import type { WorkflowState } from './controller'
import { PRIVACY_COPY } from './privacy-copy'
import { Screen } from './screen-chrome'

function openDeviceSettings(): void {
    void Linking.openSettings().catch((): void => undefined)
}

export function SettingsScreen({
    state,
    onBack,
    onOpenDeviceSettings = openDeviceSettings,
}: {
    state: WorkflowState
    onBack: () => void
    onOpenDeviceSettings?: () => void
}): ReactElement {
    const count = state.entries.length
    return (
        <Screen title="Settings" onBack={onBack} testID="settings-screen">
            <Card>
                <Heading>Your manuals on this device</Heading>
                <Body>
                    {count === 1 ? '1 manual is stored on this device.' : `${count} manuals are stored on this device.`}
                </Body>
                <Caption>Stored locally. Nothing is removed unless you remove it.</Caption>
            </Card>
            <Card>
                <Heading>What leaves this phone</Heading>
                <Stack gap="sm">
                    <Label>Read a manual</Label>
                    <Callout>{PRIVACY_COPY.read}</Callout>
                </Stack>
                <Stack gap="sm">
                    <Label>Check a step</Label>
                    <Callout>{PRIVACY_COPY.check}</Callout>
                </Stack>
                <Stack gap="sm">
                    <Label>Ask a question</Label>
                    <Callout>{PRIVACY_COPY.ask}</Callout>
                </Stack>
                <Caption>Each request is sent once. Cancelled requests are not repeated automatically.</Caption>
            </Card>
            <Card>
                <View style={styles.sectionTitle}>
                    <Icon name="camera" />
                    <View style={styles.titleText}>
                        <Heading>Camera and photos</Heading>
                    </View>
                </View>
                <Body>{PRIVACY_COPY.camera}</Body>
                <Body>
                    Photos you choose from your library stay on this device until you send them for extraction, a step
                    check or a question.
                </Body>
                <AppButton label="Open device settings" onPress={onOpenDeviceSettings} />
            </Card>
            <Caption>Settings describe this build. No preference here changes what is sent.</Caption>
        </Screen>
    )
}

const styles = StyleSheet.create({
    sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
    titleText: { flex: 1, minWidth: 0 },
})
