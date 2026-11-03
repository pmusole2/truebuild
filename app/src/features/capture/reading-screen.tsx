import { useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { BlueprintLoader, LoaderSwap } from '../../ui/blueprint-loader'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { SkeletonCard } from '../../ui/skeleton'
import { Caption, Instruction } from '../../ui/text'
import { space } from '../../theme/tokens'
import { useCoachAttention, useCoachScope } from '../onboarding/coach-provider'
import type { LibraryEntry } from './library'
import { PageImage } from './page-media'
import { plainNotice } from './plain-copy'
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

// The one caption Reading shows while it works. It names no step of the pipeline and promises nothing new.
const KEEP_OPEN_CAPTION = 'Keep this screen open.'

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
    // Covered or blurred screens hold the final drawing; reading again restarts its calm reveal.
    const running = reading && scope.active && !attention && !confirming
    const first = entry.session.pages[0]
    // Only the stream's own output phase is named; every other reading phase keeps the calm known-page line.
    const laying = state.pending?.startsWith('Reading manual pages: laying out steps') === true
    const read = (): void => {
        void controller.parse(entry.session.readingLanguage ?? 'en')
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
          ? (plainNotice(state.notice) ?? 'We could not read those pages. Try again.')
          : 'Ready to read your manual.'
    const bar = reading
        ? confirming
            ? {
                  primary: {
                      label: 'Stop reading',
                      compactLabel: 'Stop',
                      testID: 'stop-reading',
                      onPress: stop,
                  },
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
              secondary: {
                  label: 'Back to pages',
                  icon: 'chevronLeft' as const,
                  onPress: nav.back,
              },
          }
    return (
        <ScreenBody testID="reading-screen">
            <View
                style={[
                    styles.hero,
                    {
                        height: heroHeight,
                    },
                ]}
            >
                <LoaderSwap
                    waiting={reading}
                    loader={
                        <BlueprintLoader
                            phase="reading"
                            pageCount={entry.session.pages.length || undefined}
                            label={laying ? 'Laying out steps…' : undefined}
                            running={running}
                            testID="reading-indicator"
                        />
                    }
                >
                    {first === undefined ? (
                        <SkeletonCard />
                    ) : (
                        <PageImage
                            uri={state.pageUris[first.pageId]}
                            label="First page of your manual"
                            aspectRatio={first.width / first.height}
                        />
                    )}
                </LoaderSwap>
            </View>
            <TextRegion>
                <Instruction>{sentence}</Instruction>
                {reading ? <Caption>{KEEP_OPEN_CAPTION}</Caption> : null}
                {!reading && state.notice !== null && plainNotice(state.notice) !== sentence ? (
                    <Caption>{plainNotice(state.notice)}</Caption>
                ) : null}
            </TextRegion>
            <FixedBottomBar {...bar} />
        </ScreenBody>
    )
}
const styles = StyleSheet.create({
    hero: {
        padding: space.md,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
    },
})
