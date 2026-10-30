import { render } from '@testing-library/react-native'
import { MeterRootsContext, type MeterRootKind, type MeterRootSelection } from '../../ui/meter-roots'
import { MoreSheet } from '../../ui/sheet'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { ScreenBody } from './screen-layout'

jest.mock('expo-router', () => ({
    ...jest.requireActual<object>('expo-router'),
    useIsFocused: (): boolean => true,
    usePathname: (): string => '/guide/private-manual',
}))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
it('registers only the outer route as an app and lets the real sheet own its nested document census', async () => {
    const active = new Map<symbol, { kind: MeterRootKind; selection?: MeterRootSelection }>()
    const roots = {
        registerRoot: (_ref: unknown, kind: MeterRootKind, selection?: MeterRootSelection): (() => void) => {
            const key = Symbol()
            active.set(key, { kind, selection })
            return (): void => {
                active.delete(key)
            }
        },
    }
    await render(
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <MeterRootsContext.Provider value={roots}>
                    <ScreenBody>
                        <ScreenBody testID="nested-compare-document">{null}</ScreenBody>
                    </ScreenBody>
                    <MoreSheet visible title="More" onClose={(): void => undefined} documentFrame>
                        <ScreenBody testID="nested-sheet-document">{null}</ScreenBody>
                    </MoreSheet>
                </MeterRootsContext.Provider>
            </FeedbackProvider>
        </ThemeProvider>,
    )
    const apps = [...active.values()].filter((registration) => registration.kind === 'app')
    expect(apps).toEqual([{ kind: 'app', selection: { screen: 'guide', focused: true } }])
    expect([...active.values()].some((registration) => registration.kind === 'sheet')).toBe(true)
})
