import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { MAX_PARSE_PAGES } from '@truebuild/contracts/model'
import { ScrollView, StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { AppButton } from '../../ui/button'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { MoreSheet } from '../../ui/sheet'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction } from '../../ui/text'
import { SegmentedControl, TextField } from '../../ui/fields'
import { SkeletonCard } from '../../ui/skeleton'
import { Icon } from '../../ui/icons'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { PressMotion } from '../../ui/press-motion'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import { useLoadEntrance } from '../../ui/motion'
import { pagesCandidates } from '../onboarding/coach-inventory'
import { useCoachAttention, useCoachScope, useCoachScreen } from '../onboarding/coach-provider'
import { PRIVACY_COPY } from './privacy-copy'
import { setReadingLanguage } from './reading-language'
import type { LibraryEntry } from './library'
import { PageImage } from './page-media'
import { PlainNotice, ScreenBody } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import type { WorkflowScreenProps } from './workflow-types'
const MAX_PAGES = 20

// Common reading languages by name; the codes are the ones the reader already accepts.
const LANGUAGES = [
    {
        value: 'en',
        label: 'English',
    },
    {
        value: 'es',
        label: 'Spanish',
    },
    {
        value: 'fr',
        label: 'French',
    },
    {
        value: 'de',
        label: 'German',
    },
    {
        value: 'pt-BR',
        label: 'Portuguese',
    },
] as const
export type PagesScreenProps = WorkflowScreenProps &
    ChromeProps & {
        entry: LibraryEntry
        choosePages: (replaceIndex?: number) => void
    }
type Sheet =
    | {
          kind: 'page'
          pageId: string
      }
    | {
          kind: 'add'
      }
    | {
          kind: 'settings'
      }

/** Add manual: photograph every page, then read. One primary, one quiet secondary; page tools live in More. */
export function PagesScreen({
    state,
    controller,
    entry,
    choosePages,
    chrome = 'inline',
    more: moreProp,
}: PagesScreenProps): ReactElement {
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const [title, setTitle] = useState(entry.session.title)
    const [language, setLanguage] = useState('en')
    const [sheet, setSheet] = useState<Sheet>({
        kind: 'settings',
    })
    const { pages } = entry.session
    const initialPages = useRef(new Set(pages.map((page) => page.pageId)))
    const busy = state.pending !== null || state.storageReadOnly
    const full = pages.length >= MAX_PAGES
    const saving =
        state.pending !== null && /^(Choosing manual pages|Preparing page |Saving manual pages)/u.test(state.pending)
    const previewPage = sheet.kind === 'page' ? pages.find((page) => page.pageId === sheet.pageId) : undefined
    const previewIndex = previewPage === undefined ? -1 : pages.indexOf(previewPage)
    // The header's More button opens the general sheet; a tapped page or "Add a page" asks for its own.
    const requested = useRef(false)
    useEffect(() => {
        if (more.open && !requested.current) {
            setSheet({
                kind: 'settings',
            })
        }
        requested.current = false
    }, [more.open])
    const open = (next: Sheet): void => {
        requested.current = true
        setSheet(next)
        more.show()
    }
    const close = (): void => more.hide()
    const takePhoto = (): void => {
        close()
        controller.camera({
            kind: 'page',
        })
    }
    const choose = (): void => {
        close()
        choosePages()
    }
    const primary = saving
        ? {
              label: 'Adding photos…',
              compactLabel: 'Adding',
              busy: true,
              onPress: (): void => undefined,
          }
        : pages.length === 0
          ? {
                label: 'Take photo',
                compactLabel: 'Photo',
                icon: 'camera' as const,
                testID: 'take-page-photo',
                onPress: takePhoto,
                disabled: busy || full,
            }
          : {
                label: entry.session.rawExtraction === null ? 'Read my manual' : 'Read my manual again',
                compactLabel: 'Read',
                testID: 'read-manual',
                busy: state.pending !== null && state.pending.startsWith('Reading'),
                disabled: busy,
                onPress: (): void => {
                    setReadingLanguage(entry.session.manualId, language)
                    void controller.parse(language)
                },
            }
    const secondary = saving
        ? {
              label: 'Cancel',
              icon: 'close' as const,
              testID: 'cancel-page-import',
              onPress: controller.cancel,
          }
        : pages.length === 0
          ? {
                label: 'Choose from photos',
                accessibilityLabel: 'Choose pages from photos',
                icon: 'image' as const,
                testID: 'choose-pages',
                onPress: choose,
                disabled: busy || full,
            }
          : {
                label: 'Add a page',
                icon: 'plus' as const,
                testID: 'add-page',
                onPress: (): void =>
                    open({
                        kind: 'add',
                    }),
                disabled: busy || full,
            }
    useCoachScreen('pages', {
        suppressed: busy || more.open,
        candidates: pagesCandidates({
            pages: pages.length,
            open: !saving && !full,
            canRead: !saving && pages.length >= 1,
        }),
    })
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const entrance = useLoadEntrance(scope.active && !attention && !more.open && state.pending === null)
    return (
        <ScreenBody testID="pages-screen">
            {chrome === 'inline' ? (
                <InlineHeader
                    title="Add manual"
                    subtitle={pages.length === 0 ? undefined : `Page ${pages.length} of up to ${MAX_PAGES}`}
                    more={{
                        ...more,
                        show: () =>
                            open({
                                kind: 'settings',
                            }),
                    }}
                />
            ) : null}
            <Animated.View style={[styles.flex, entrance]}>
                <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    <PlainNotice state={state} controller={controller} />
                    <>
                        {pages.length === 0 ? <Icon name="camera" /> : null}
                        <Instruction>
                            {pages.length === 0
                                ? 'Take a photo of each page of your paper manual.'
                                : 'Add every page, even the parts list.'}
                        </Instruction>
                    </>
                    {pages.length > MAX_PARSE_PAGES ? (
                        <Caption>We can read 8 pages at a time. Remove a few pages to read your manual.</Caption>
                    ) : null}
                    {pages.map((page, index) => (
                        <PageArrival
                            key={page.pageId}
                            waiting={saving && !initialPages.current.has(page.pageId)}
                            animate={
                                !initialPages.current.has(page.pageId) &&
                                scope.active &&
                                !attention &&
                                !more.open &&
                                state.pending === null
                            }
                        >
                            <PageRow
                                index={index}
                                uri={state.pageUris[page.pageId]}
                                aspectRatio={page.width / page.height}
                                onPress={(): void =>
                                    open({
                                        kind: 'page',
                                        pageId: page.pageId,
                                    })
                                }
                            />
                        </PageArrival>
                    ))}
                    {saving ? <SkeletonCard /> : null}
                </ScrollView>
            </Animated.View>
            <FixedBottomBar
                {...{
                    primary,
                    secondary,
                }}
                reason={null}
            />
            <MoreSheet
                visible={more.open}
                title={
                    previewPage !== undefined
                        ? `Page ${previewIndex + 1}`
                        : sheet.kind === 'add'
                          ? 'Add a page'
                          : 'More'
                }
                compactTitle={previewPage === undefined ? (sheet.kind === 'add' ? 'Add' : 'More') : undefined}
                onClose={close}
                detents={previewPage !== undefined ? ['tall', 'full'] : ['peek', 'tall']}
            >
                {previewPage !== undefined ? (
                    <Stack gap="md">
                        <PageImage
                            uri={state.pageUris[previewPage.pageId]}
                            label={`Manual page ${previewIndex + 1}`}
                            aspectRatio={previewPage.width / previewPage.height}
                        />
                        <PageTools
                            index={previewIndex}
                            count={pages.length}
                            busy={busy}
                            controller={controller}
                            choosePages={choosePages}
                            onDone={close}
                        />
                    </Stack>
                ) : sheet.kind === 'add' ? (
                    <Stack gap="sm">
                        <AppButton label="Take photo" icon="camera" disabled={busy || full} onPress={takePhoto} />
                        <AppButton
                            label="Choose from photos"
                            accessibilityLabel="Choose pages from photos"
                            icon="image"
                            disabled={busy || full}
                            onPress={choose}
                        />
                    </Stack>
                ) : (
                    <Stack gap="md">
                        <Caption>{`You can add up to ${MAX_PAGES} pages.`}</Caption>
                        <TextField
                            label="Name this build"
                            value={title}
                            maxLength={200}
                            placeholder="e.g. Bedroom dresser"
                            onChangeText={setTitle}
                            onEndEditing={(): void => {
                                void controller.rename(title)
                            }}
                            editable={!state.storageReadOnly}
                        />
                        <Stack gap="xs">
                            <Heading>Reading language</Heading>
                            <SegmentedControl
                                label="Reading language"
                                options={LANGUAGES}
                                value={language}
                                onChange={(code): void => {
                                    setLanguage(code)
                                }}
                            />
                        </Stack>
                        {entry.session.rawExtraction === null ? null : (
                            <AppButton
                                label="Go to questions"
                                disabled={busy}
                                onPress={(): void => {
                                    close()
                                    controller.navigate('overview')
                                }}
                            />
                        )}
                        <Body>{PRIVACY_COPY.stayOnDevice}</Body>
                        <Caption>Photos are prepared on this device before they are sent.</Caption>
                    </Stack>
                )}
            </MoreSheet>
        </ScreenBody>
    )
}
function PageTools({
    index,
    count,
    busy,
    controller,
    choosePages,
    onDone,
}: {
    index: number
    count: number
    busy: boolean
    controller: WorkflowScreenProps['controller']
    choosePages: (replaceIndex?: number) => void
    onDone: () => void
}): ReactElement {
    const number = index + 1
    return (
        <Stack gap="xs">
            <AppButton
                label="Retake"
                accessibilityLabel={`Retake page ${number}`}
                variant="quiet"
                disabled={busy}
                onPress={(): void => {
                    onDone()
                    controller.camera({
                        kind: 'page',
                        replaceIndex: index,
                    })
                }}
            />
            <AppButton
                label="Replace from photos"
                accessibilityLabel={`Replace page ${number} from photos`}
                variant="quiet"
                disabled={busy}
                onPress={(): void => {
                    onDone()
                    choosePages(index)
                }}
            />
            <AppButton
                label="Move up"
                accessibilityLabel={`Move page ${number} up`}
                variant="quiet"
                disabled={busy || index === 0}
                onPress={(): void => {
                    void controller.editPage(index, 'up')
                    onDone()
                }}
            />
            <AppButton
                label="Move down"
                accessibilityLabel={`Move page ${number} down`}
                variant="quiet"
                disabled={busy || index === count - 1}
                onPress={(): void => {
                    void controller.editPage(index, 'down')
                    onDone()
                }}
            />
            <AppButton
                label="Remove"
                accessibilityLabel={`Remove page ${number}`}
                variant="danger"
                disabled={busy}
                onPress={(): void => {
                    void controller.editPage(index, 'remove')
                    onDone()
                }}
            />
        </Stack>
    )
}

/** An incoming page stays a static placeholder until saved, then settles once without replaying the existing list. */
function PageArrival({
    waiting,
    animate,
    children,
}: {
    readonly waiting: boolean
    readonly animate: boolean
    readonly children: ReactNode
}): ReactElement {
    return waiting ? <SkeletonCard /> : <PageArrivalContent animate={animate}>{children}</PageArrivalContent>
}
function PageArrivalContent({
    animate,
    children,
}: {
    readonly animate: boolean
    readonly children: ReactNode
}): ReactElement {
    const entrance = useLoadEntrance(animate)
    return <Animated.View style={entrance}>{children}</Animated.View>
}
export function PageRow({
    index,
    uri,
    aspectRatio,
    onPress,
    nativeID,
    numbered = true,
}: {
    index: number
    uri: string | undefined
    aspectRatio: number
    onPress: () => void
    nativeID?: string
    numbered?: boolean
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Card tone="raised" nativeID={nativeID}>
            <PressMotion
                accessibilityRole="button"
                accessibilityLabel={`View page ${index + 1}`}
                onPress={onPress}
                {...focus.focusHandlers}
                style={[styles.pageRow, focusRingStyle(focus.focused, colors)]}
            >
                <View style={styles.thumb}>
                    <PageImage uri={uri} label={`Manual page ${index + 1}`} aspectRatio={aspectRatio} />
                </View>
                <View style={styles.pageInfo}>{numbered ? <Heading>{`Page ${index + 1}`}</Heading> : null}</View>
                <Icon name="chevronRight" color={colors.inkMuted} />
            </PressMotion>
        </Card>
    )
}
const styles = StyleSheet.create({
    flex: {
        flex: 1,
        minHeight: 0,
    },
    content: {
        padding: space.md,
        gap: space.md,
    },
    pageRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: touchTarget,
    },
    thumb: {
        width: 96,
    },
    pageInfo: {
        flex: 1,
    },
})
