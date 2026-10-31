import type { ReactElement } from 'react'
import { Linking, View } from 'react-native'
import { AppButton } from '../../ui/button'
import { Stack } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import type { WorkflowState } from './controller'
import { PRIVACY_COPY } from './privacy-copy'

function openDeviceSettings(): void {
    void Linking.openSettings().catch((): void => undefined)
}

/** What stays on the phone, what is sent and when. Lives inside More; no preference here changes what is sent. */
export function SettingsSections({
    state,
    onOpenDeviceSettings = openDeviceSettings,
}: {
    state: Pick<WorkflowState, 'entries'>
    onOpenDeviceSettings?: () => void
}): ReactElement {
    const count = state.entries.length
    return (
        <Stack gap="md">
            <Stack gap="xs">
                <Heading>Your builds on this device</Heading>
                <Body>
                    {count === 1 ? '1 build is saved on this device.' : `${count} builds are saved on this device.`}
                </Body>
                <Caption>Nothing is removed unless you remove it.</Caption>
            </Stack>
            <Stack gap="xs">
                <Heading>What leaves this device</Heading>
                <Body>{PRIVACY_COPY.read}</Body>
                <Body>{PRIVACY_COPY.check}</Body>
                <Body>{PRIVACY_COPY.ask}</Body>
                <Caption>{PRIVACY_COPY.once}</Caption>
            </Stack>
            <Stack gap="xs">
                <Heading>Camera and photos</Heading>
                <Body>{PRIVACY_COPY.camera}</Body>
                <Body>{PRIVACY_COPY.library}</Body>
                <AppButton label="Open device settings" onPress={onOpenDeviceSettings} />
            </Stack>
        </Stack>
    )
}

/** The settings content on its own, for previews. Production shows it inside More. */
export function SettingsScreen({
    state,
    onOpenDeviceSettings,
}: {
    state: Pick<WorkflowState, 'entries'>
    onOpenDeviceSettings?: () => void
}): ReactElement {
    return (
        <View testID="settings-screen" style={{ padding: 16 }}>
            <SettingsSections state={state} onOpenDeviceSettings={onOpenDeviceSettings} />
        </View>
    )
}
