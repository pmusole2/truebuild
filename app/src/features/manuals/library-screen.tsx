import { createDemoManual, type ManualSession } from '@truebuild/contracts'
import { useFocusEffect } from 'expo-router'
import { useCallback, useState, type ReactElement } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { contentMaxWidth, fonts, palette, radius, space } from '../../components/theme'
import { ActionButton, FIXTURE_LABEL, Notice, Panel, SectionTitle, Tag } from '../../components/ui'
import { createManualSession } from '../../domain/manual-session'
import { useModelConnection } from '../connection/connection-store'
import { localStore } from './local-store'
import { userMessageForImportError } from './import-errors'
import { pickAndNormalizePages } from './import-pages'
import { DEMO_MANUAL_ID } from './workspace-state'

type LibraryEntry = {
    readonly manualId: string
    readonly title: string
    readonly updatedAt: string
    readonly isDemo: boolean
}

type LibraryScreenProps = {
    readonly onOpenManual: (manualId: string) => void
    readonly onOpenConnection: () => void
}

const DEMO_SESSION = createDemoManual()
const DEMO_ENTRY: LibraryEntry = {
    manualId: DEMO_MANUAL_ID,
    title: DEMO_SESSION.title,
    updatedAt: DEMO_SESSION.updatedAt,
    isDemo: true,
}

function importTitle(now: Date): string {
    return `Imported manual ${now.toISOString().slice(0, 10)}`
}

// Builds a new manual from the picked pages and writes it only after every page passed validation.
async function importManual(): Promise<ManualSession | null> {
    const imported = await pickAndNormalizePages()
    if (imported === null) {
        return null
    }
    const session = createManualSession(
        importTitle(new Date()),
        imported.map((item) => item.page),
    )
    await localStore.saveManual(
        session,
        imported.map((item) => item.asset),
    )
    return session
}

export function LibraryScreen({ onOpenManual, onOpenConnection }: LibraryScreenProps): ReactElement {
    const connection = useModelConnection()
    const [saved, setSaved] = useState<readonly LibraryEntry[]>([])
    const [notice, setNotice] = useState<string | null>(null)
    const [importing, setImporting] = useState(false)

    useFocusEffect(
        useCallback(() => {
            let active = true
            localStore
                .listManuals()
                .then((entries) => {
                    if (active) {
                        setSaved(entries.map((entry) => ({ ...entry, isDemo: false })))
                    }
                })
                .catch(() => {
                    if (active) {
                        setNotice('Saved manuals could not be read from this device.')
                    }
                })
            return (): void => {
                active = false
            }
        }, []),
    )

    async function handleImport(): Promise<void> {
        if (importing) {
            return
        }
        setImporting(true)
        setNotice(null)
        try {
            const session = await importManual()
            if (session !== null) {
                onOpenManual(session.manualId)
            }
        } catch (error: unknown) {
            setNotice(userMessageForImportError(error))
        } finally {
            setImporting(false)
        }
    }

    const entries: readonly LibraryEntry[] = [DEMO_ENTRY, ...saved]

    return (
        <ScrollView contentContainerStyle={styles.page}>
            <View style={styles.inner}>
                <Text accessibilityRole="header" style={styles.heading}>
                    Manual workspace
                </Text>
                <Text style={styles.lede}>
                    Import manual pages you own, then read and correct the steps they describe. Nothing here analyses a
                    photo of your assembly.
                </Text>
                <Notice text={`${FIXTURE_LABEL}: the built-in demo is the only manual with simulated checks.`} />

                <Notice
                    text={
                        connection === null
                            ? 'Fixture mode: no backend connection. Simulated results only; no request is sent.'
                            : 'Live backend connection set in memory for this session. Model calls happen only when you press an action.'
                    }
                />
                <ActionButton label="Live backend connection" onPress={onOpenConnection} />
                {notice === null ? null : <Notice tone="error" text={notice} />}

                <Panel>
                    <SectionTitle>Manuals</SectionTitle>
                    {entries.map((entry) => (
                        <Pressable
                            key={entry.manualId}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${entry.title}`}
                            onPress={() => onOpenManual(entry.manualId)}
                            style={styles.entry}
                        >
                            <View style={styles.entryHeader}>
                                <Text style={styles.entryTitle}>{entry.title}</Text>
                                {entry.isDemo ? <Tag tone="simulated" text="Demo" /> : null}
                            </View>
                            <Text style={styles.entryMeta}>
                                {entry.isDemo ? 'Built in · not saved' : `Updated ${entry.updatedAt.slice(0, 10)}`}
                            </Text>
                        </Pressable>
                    ))}
                    {saved.length === 0 ? (
                        <Text style={styles.lede}>No saved manuals yet. Import pages to create one.</Text>
                    ) : null}
                </Panel>

                <Panel>
                    <SectionTitle>Import pages</SectionTitle>
                    <Text style={styles.lede}>
                        Choose up to 20 JPEG, PNG or WebP pages. Each page is at most 4 MiB and 24 megapixels. Pages are
                        kept in this app's local storage on this device; temporary platform copies made while importing
                        may remain until the device clears them.
                    </Text>
                    <ActionButton
                        label={importing ? 'Importing…' : 'Choose manual pages'}
                        tone="primary"
                        disabled={importing}
                        onPress={() => void handleImport()}
                    />
                </Panel>
            </View>
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    page: {
        padding: space.md,
        alignItems: 'center',
    },
    inner: {
        width: '100%',
        maxWidth: contentMaxWidth,
        gap: space.md,
    },
    heading: {
        color: palette.charcoal,
        fontFamily: fonts.display,
        fontSize: 30,
        fontWeight: '700',
    },
    lede: {
        color: palette.graphite,
        fontSize: 15,
        lineHeight: 22,
    },
    entry: {
        minHeight: 44,
        padding: space.sm,
        gap: space.xs,
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        backgroundColor: palette.paper,
    },
    entryHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: space.xs,
    },
    entryTitle: {
        color: palette.charcoal,
        fontSize: 17,
        fontWeight: '700',
        flexShrink: 1,
    },
    entryMeta: {
        color: palette.graphite,
        fontFamily: fonts.mono,
        fontSize: 12,
    },
})
