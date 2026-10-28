import { useState, type ReactElement } from 'react'
import { MAX_PARSE_PAGES, PARSE_SPLIT_MESSAGE, parseLanguageSchema } from '@truebuild/contracts/model'
import { Pressable, StyleSheet, View } from 'react-native'
import { AppButton } from '../../ui/button'
import { ActionGroup, Card, Stack } from '../../ui/surface'
import { Caption, Heading } from '../../ui/text'
import { EmptyState } from '../../ui/states'
import { StatusTag } from '../../ui/status'
import { TextField } from '../../ui/fields'
import { SkeletonCard } from '../../ui/skeleton'
import { Icon } from '../../ui/icons'
import { BottomSheet } from '../../ui/sheet'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { PRIVACY_COPY } from './privacy-copy'
import type { LibraryEntry } from './library'
import { PageImage } from './page-media'
import { Screen, WorkflowNotice } from './screen-chrome'
import type { WorkflowScreenProps } from './workflow-types'

const MAX_PAGES = 20

export type PagesScreenProps = WorkflowScreenProps & {
    entry: LibraryEntry
    choosePages: (replaceIndex?: number) => void
}

export function PagesScreen({ state, controller, entry, choosePages }: PagesScreenProps): ReactElement {
    const { colors } = useTheme()
    const [title, setTitle] = useState(entry.session.title)
    const [language, setLanguage] = useState('en')
    const languageValid = parseLanguageSchema.safeParse(language).success
    const [previewId, setPreviewId] = useState<string | null>(null)
    const { pages } = entry.session
    const busy = state.pending !== null || state.storageReadOnly
    const full = pages.length >= MAX_PAGES
    const reading = state.pending !== null && state.pending.startsWith('Reading')
    const previewPage = pages.find((page) => page.pageId === previewId)
    return (
        <Screen title="Manual pages" onBack={controller.home} testID="pages-screen">
            <WorkflowNotice state={state} controller={controller} />
            <Card>
                <TextField
                    label="Manual title"
                    value={title}
                    maxLength={200}
                    onChangeText={setTitle}
                    onEndEditing={(): void => {
                        void controller.rename(title)
                    }}
                    editable={!state.storageReadOnly}
                />
                <View style={styles.privacy}>
                    <Icon name="info" size="sm" color={colors.inkMuted} />
                    <View style={styles.privacyText}>
                        <Caption>{PRIVACY_COPY.stayOnDevice}</Caption>
                        <Caption>{PRIVACY_COPY.read}</Caption>
                        <Caption>
                            Store up to 20 pages. Read up to 8 pages at a time. Phone photos are resized and compressed
                            locally before upload.
                        </Caption>
                    </View>
                </View>
            </Card>
            <View style={styles.sectionHeader}>
                <Heading>Pages</Heading>
                <StatusTag label={`${pages.length} of ${MAX_PAGES}`} tone={full ? 'caution' : 'neutral'} />
            </View>
            <ActionGroup>
                <AppButton
                    label="Scan a page"
                    variant="accent"
                    icon="camera"
                    disabled={busy || full}
                    onPress={(): void => controller.camera({ kind: 'page' })}
                />
                <AppButton
                    label="Choose pages from photos"
                    icon="image"
                    disabled={busy || full}
                    onPress={(): void => choosePages()}
                />
            </ActionGroup>
            {pages.length === 0 ? (
                <Card>
                    <EmptyState title="No pages yet." body="Scan a page or choose pages from photos." />
                </Card>
            ) : null}
            {pages.map((page, index) => (
                <Card key={page.pageId}>
                    <View style={styles.pageRow}>
                        <PageThumbnail
                            uri={state.pageUris[page.pageId]}
                            index={index}
                            aspectRatio={page.width / page.height}
                            onPress={(): void => setPreviewId(page.pageId)}
                        />
                        <View style={styles.pageInfo}>
                            <Heading>{`Page ${index + 1}`}</Heading>
                            <Caption>{`${index + 1} of ${pages.length}`}</Caption>
                        </View>
                    </View>
                    <ActionGroup>
                        <AppButton
                            label="Up"
                            accessibilityLabel={`Move page ${index + 1} up`}
                            variant="quiet"
                            disabled={busy || index === 0}
                            onPress={(): void => {
                                void controller.editPage(index, 'up')
                            }}
                        />
                        <AppButton
                            label="Down"
                            accessibilityLabel={`Move page ${index + 1} down`}
                            variant="quiet"
                            disabled={busy || index === pages.length - 1}
                            onPress={(): void => {
                                void controller.editPage(index, 'down')
                            }}
                        />
                        <AppButton
                            label="Retake"
                            accessibilityLabel={`Retake page ${index + 1}`}
                            variant="quiet"
                            disabled={busy}
                            onPress={(): void => controller.camera({ kind: 'page', replaceIndex: index })}
                        />
                        <AppButton
                            label="Replace"
                            accessibilityLabel={`Replace page ${index + 1} from photos`}
                            variant="quiet"
                            disabled={busy}
                            onPress={(): void => choosePages(index)}
                        />
                        <AppButton
                            label="Remove"
                            accessibilityLabel={`Remove page ${index + 1}`}
                            variant="danger"
                            disabled={busy}
                            onPress={(): void => {
                                void controller.editPage(index, 'remove')
                            }}
                        />
                    </ActionGroup>
                </Card>
            ))}
            {reading ? (
                <Card>
                    <Caption>Reading your pages. Page changes are paused until it finishes.</Caption>
                    <SkeletonCard />
                </Card>
            ) : null}
            <Stack gap="xs">
                <TextField
                    label="Reading language code"
                    value={language}
                    onChangeText={setLanguage}
                    maxLength={16}
                    editable={!busy}
                    error={languageValid ? undefined : 'Use a language code such as en, fr or pt-BR.'}
                />
                {pages.length > MAX_PARSE_PAGES ? <Caption>{PARSE_SPLIT_MESSAGE}</Caption> : null}
                <AppButton
                    label={entry.session.rawExtraction === null ? 'Read manual' : 'Read manual again'}
                    variant="primary"
                    busy={reading}
                    disabled={busy || pages.length === 0 || !languageValid}
                    onPress={(): void => {
                        void controller.parse(language)
                    }}
                />
                {entry.session.rawExtraction === null ? null : (
                    <AppButton
                        label="Review extracted facts"
                        variant="quiet"
                        disabled={busy}
                        onPress={(): void => controller.navigate('overview')}
                    />
                )}
            </Stack>
            <BottomSheet
                visible={previewPage !== undefined}
                title={previewPage === undefined ? 'Manual page' : `Page ${pages.indexOf(previewPage) + 1}`}
                onClose={(): void => setPreviewId(null)}
            >
                {previewPage === undefined ? null : (
                    <PageImage
                        uri={state.pageUris[previewPage.pageId]}
                        label={`Manual page ${pages.indexOf(previewPage) + 1}`}
                        aspectRatio={previewPage.width / previewPage.height}
                    />
                )}
            </BottomSheet>
        </Screen>
    )
}

function PageThumbnail({
    uri,
    index,
    aspectRatio,
    onPress,
}: {
    uri: string | undefined
    index: number
    aspectRatio: number
    onPress: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View page ${index + 1}`}
            onPress={onPress}
            {...focus.focusHandlers}
            style={[styles.thumb, focusRingStyle(focus.focused, colors)]}
        >
            <PageImage uri={uri} label={`Manual page ${index + 1}`} aspectRatio={aspectRatio} />
        </Pressable>
    )
}

const styles = StyleSheet.create({
    privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
    privacyText: { flex: 1, gap: space.xs },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
    pageRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    thumb: { width: 96, minHeight: touchTarget, justifyContent: 'center' },
    pageInfo: { flex: 1, gap: space.xxs },
})
