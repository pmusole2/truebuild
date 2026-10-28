import type { ReactElement, ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Screen as ScreenShell, Stack } from '../../ui/surface'
import { Title } from '../../ui/text'

/** Plain frame for a state that has no navigator: safe-area shell and a title. Used when the app cannot start. */
export function Screen({
    title,
    children,
    testID,
}: {
    title: string
    children: ReactNode
    testID?: string
}): ReactElement {
    return (
        <ScreenShell header="hidden" testID={testID}>
            <Stack gap="md">
                <View style={styles.titleWrap}>
                    <Title>{title}</Title>
                </View>
                {children}
            </Stack>
        </ScreenShell>
    )
}

const styles = StyleSheet.create({
    titleWrap: { flex: 1 },
})
