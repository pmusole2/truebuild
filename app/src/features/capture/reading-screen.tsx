import { useEffect, useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { SkeletonCard } from '../../ui/skeleton'
import { Caption, Instruction } from '../../ui/text'
import { useReadingLoop } from '../../ui/motion'
import { useTheme } from '../../theme/theme'
import { radius, space } from '../../theme/tokens'
import { useCoachAttention, useCoachScope } from '../onboarding/coach-provider'
import type { LibraryEntry } from './library'
import { PageImage } from './page-media'
import { plainNotice } from './plain-copy'
import { readingLanguage } from './reading-language'
import { ScreenBody, TextRegion, useHeroHeight } from './screen-layout'
import { defaultNav, type ScreenNav } from './screen-nav'
import type { WorkflowScreenProps } from './workflow-types'

type ReadingProps = WorkflowScreenProps & {
    entry: LibraryEntry
    readonly nav?: ScreenNav
    // Native Back while reading asks first. The route sets this; without a router the Cancel button sets it.
    readonly confirming?: boolean
    readonly onConfirmingChange?: (confirming: boolean) => void
}

// The only captions Reading ever shows. They name no step of the pipeline and promise nothing new.
export const READING_CAPTIONS = ['Keep this screen open.', 'You can stop and try again later.'] as const
// A caption stays at least this long before the next one replaces it.
export const CAPTION_MS = 3500

/** Reading: wait calmly, know it is working, never be trapped. A presentation of the existing parse request. */
export function ReadingScreen({
    state,
    controller,
    entry,
    nav: navProp,
    confirming: confirmingProp,
    onConfirmingChange,
}: ReadingProps): ReactElement {
    const nav = navProp ?? defaultNav(controller)
    const [internal, setInternal] = useState(false)
    const confirming = confirmingProp ?? internal
    const setConfirming = onConfirmingChange ?? setInternal
    const heroHeight = useHeroHeight()
    const reading = state.pending !== null && state.pending.startsWith('Reading')
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const { colors } = useTheme()
    // The one calm loop: it pauses while the screen is covered or blurred and stops when reading stops.
    const running = reading && scope.active && !attention && !confirming
    const breath = useReadingLoop(running)
    const [caption, setCaption] = useState(0)
    useEffect(() => {
        if (!reading) {
            setCaption(0)
            return undefined
        }
        if (!running) return undefined
        const timer = setInterval(() => setCaption((now) => (now + 1) % READING_CAPTIONS.length), CAPTION_MS)
        return (): void => clearInterval(timer)
    }, [reading, running])
    const first = entry.session.pages[0]
    const read = (): void => {
        void controller.parse(readingLanguage(entry.session.manualId))
    }
    const stop = (): void => {
        setConfirming(false)
        controller.cancel()
        nav.back()
    }
    const sentence = reading
        ? confirming
            ? 'Stop reading? You can start again.'
            : 'Reading your manual. This can take a minute.'
        : state.notice !== null
          ? 'We could not read those pages. Check your connection and try again.'
          : 'Ready to read your manual.'
    const bar = reading
        ? confirming
            ? {
                  primary: { label: 'Stop reading', compactLabel: 'Stop', testID: 'stop-reading', onPress: stop },
                  secondary: {
                      label: 'Keep reading',
                      icon: 'check' as const,
                      onPress: (): void => setConfirming(false),
                  },
              }
            : {
                  primary: null,
                  secondary: {
                      label: 'Cancel',
                      icon: 'close' as const,
                      testID: 'cancel-reading',
                      onPress: (): void => setConfirming(true),
                  },
              }
        : {
              primary: {
                  label: state.notice !== null ? 'Try again' : 'Read my manual',
                  compactLabel: state.notice !== null ? 'Retry' : 'Read',
                  testID: 'retry-reading',
                  onPress: read,
                  disabled: state.pending !== null,
              },
              secondary: { label: 'Back to pages', icon: 'chevronLeft' as const, onPress: nav.back },
          }
    return (
        <ScreenBody testID="reading-screen">
            <View style={[styles.hero, { height: heroHeight }]}>
                {first === undefined ? (
                    <SkeletonCard />
                ) : (
                    <PageImage
                        uri={state.pageUris[first.pageId]}
                        label="First page of your manual"
                        aspectRatio={first.width / first.height}
                    />
                )}
            </View>
            <TextRegion>
                <Instruction>{sentence}</Instruction>
                {reading ? (
                    <Animated.View
                        testID="reading-indicator"
                        accessibilityElementsHidden={true}
                        importantForAccessibility="no-hide-descendants"
                        style={[styles.indicator, { backgroundColor: colors.accent }, breath]}
                    />
                ) : null}
                {reading ? <Caption>{READING_CAPTIONS[caption]}</Caption> : null}
                {!reading && state.notice !== null && plainNotice(state.notice) !== sentence ? (
                    <Caption>{plainNotice(state.notice)}</Caption>
                ) : null}
            </TextRegion>
            <FixedBottomBar {...bar} />
        </ScreenBody>
    )
}

const styles = StyleSheet.create({
    indicator: { width: space.xl, height: space.xxs, borderRadius: radius.pill },
    hero: { padding: space.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
})
