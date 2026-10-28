import { useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { SkeletonCard } from '../../ui/skeleton'
import { Caption, Instruction } from '../../ui/text'
import { space } from '../../theme/tokens'
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
                  primary: { label: 'Stop reading', testID: 'stop-reading', onPress: stop },
                  secondary: { label: 'Keep reading', onPress: (): void => setConfirming(false) },
              }
            : {
                  primary: null,
                  secondary: { label: 'Cancel', testID: 'cancel-reading', onPress: (): void => setConfirming(true) },
              }
        : {
              primary: {
                  label: state.notice !== null ? 'Try again' : 'Read my manual',
                  testID: 'retry-reading',
                  onPress: read,
                  disabled: state.pending !== null,
              },
              secondary: { label: 'Back to pages', onPress: nav.back },
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
                {reading ? <Caption>Keep this screen open.</Caption> : null}
                {!reading && state.notice !== null && plainNotice(state.notice) !== sentence ? (
                    <Caption>{plainNotice(state.notice)}</Caption>
                ) : null}
            </TextRegion>
            <FixedBottomBar {...bar} />
        </ScreenBody>
    )
}

const styles = StyleSheet.create({
    hero: { padding: space.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
})
