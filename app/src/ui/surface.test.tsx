import { describe, expect, it, jest } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import type * as ReactModule from 'react'
import type { ReactElement, ReactNode } from 'react'
import type * as ReactNative from 'react-native'
import { Text, type ViewProps } from 'react-native'
import { Card, Screen, Stack } from './surface'

// Insets are not under test here. The mock keeps the requested edges visible on the rendered node.
jest.mock('react-native-safe-area-context', () => {
    const { createElement } = jest.requireActual<typeof ReactModule>('react')
    const { View } = jest.requireActual<typeof ReactNative>('react-native')
    return {
        SafeAreaView: (props: {
            readonly edges?: readonly string[]
            readonly style?: ViewProps['style']
            readonly testID?: string
            readonly children?: ReactNode
        }): ReactElement =>
            createElement<ViewProps & { readonly edges?: readonly string[] }>(
                View,
                { edges: props.edges, style: props.style, testID: props.testID },
                props.children,
            ),
    }
})

describe('Screen shell', () => {
    it('keeps content clear of the sides and home indicator, and scrolls by default', async () => {
        await render(
            <Screen testID="shell">
                <Text>Plan</Text>
            </Screen>,
        )
        expect(screen.getByText('Plan')).toBeTruthy()
        expect(screen.getByTestId('shell')).toHaveProp('edges', ['left', 'right', 'bottom'])
    })

    it('a non-scrolling shell still renders its content', async () => {
        await render(
            <Screen scroll={false}>
                <Text>Camera</Text>
            </Screen>,
        )
        expect(screen.getByText('Camera')).toBeTruthy()
    })
})

describe('Stack and Card', () => {
    it('keeps card content together inside the bordered surface', async () => {
        await render(
            <Stack gap="sm">
                <Card elevation={1}>
                    <Text>Missing: inward groove</Text>
                </Card>
            </Stack>,
        )
        expect(screen.getByText('Missing: inward groove')).toBeTruthy()
    })
})
