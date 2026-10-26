import type { ManualPage, NormalizedBox } from '@truebuild/contracts'
import { useEffect, useState, type ReactElement } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { fonts, palette, radius, space } from '../../components/theme'
import { FIXTURE_LABEL, Tag } from '../../components/ui'
import { bytesToDataUri } from './image-source'
import { localStore } from './local-store'

type PageImageState =
    | { readonly status: 'idle' | 'loading' }
    | { readonly status: 'ready'; readonly uri: string }
    | { readonly status: 'missing' }
    | { readonly status: 'failed' }

// Loads a saved page as a data URI each time the view mounts. The URI is never written back to storage.
export function usePageImage(page: ManualPage, enabled: boolean): PageImageState {
    const [state, setState] = useState<PageImageState>({ status: 'idle' })

    useEffect(() => {
        if (!enabled) {
            return undefined
        }
        let active = true
        setState({ status: 'loading' })
        localStore
            .loadPageAsset(page.assetId)
            .then((asset) => {
                if (!active) {
                    return
                }
                setState(
                    asset === null
                        ? { status: 'missing' }
                        : { status: 'ready', uri: bytesToDataUri(asset.bytes, asset.mimeType) },
                )
            })
            .catch(() => {
                if (active) {
                    setState({ status: 'failed' })
                }
            })
        return (): void => {
            active = false
        }
    }, [enabled, page.assetId])

    return state
}

type SourceViewProps = {
    readonly page: ManualPage
    readonly isDemo: boolean
    readonly highlights?: readonly NormalizedBox[]
    readonly caption: string
}

function ImportedPageImage({ page }: { readonly page: ManualPage }): ReactElement {
    const image = usePageImage(page, true)
    if (image.status === 'ready') {
        return (
            <Image
                accessibilityLabel="Manual page"
                source={{ uri: image.uri }}
                style={styles.image}
                resizeMode="contain"
            />
        )
    }
    const message =
        image.status === 'missing'
            ? 'This page image is not in local storage.'
            : image.status === 'failed'
              ? 'This page could not be loaded from local storage.'
              : 'Loading page…'
    return (
        <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>{message}</Text>
        </View>
    )
}

// Code-drawn synthetic sheet: no raster asset, so it cannot be mistaken for a photograph of a real manual.
function DemoSheet(): ReactElement {
    return (
        <View accessibilityLabel="Synthetic demo sheet" style={styles.demoSheet}>
            <View style={[styles.demoPanel, { left: '14%', top: '18%', width: '12%', height: '62%' }]}>
                <Text style={styles.demoLabel}>1 · side panel</Text>
            </View>
            <View style={[styles.demoGroove, { left: '26%', top: '18%', width: '1%', height: '62%' }]} />
            <View style={[styles.demoDivider, { left: '26%', top: '48%', width: '48%', height: '7%' }]}>
                <Text style={styles.demoLabel}>2 · divider shelf</Text>
            </View>
        </View>
    )
}

export function SourceView({ page, isDemo, highlights = [], caption }: SourceViewProps): ReactElement {
    return (
        <View style={styles.wrapper}>
            <View style={styles.header}>
                <Text style={styles.caption}>{caption}</Text>
                {isDemo ? (
                    <Tag tone="simulated" text={FIXTURE_LABEL} />
                ) : (
                    <Tag tone="unreviewed" text="Manual source" />
                )}
            </View>
            <View style={[styles.frame, { aspectRatio: page.width / page.height }]}>
                {isDemo ? <DemoSheet /> : <ImportedPageImage key={page.assetId} page={page} />}
                {highlights.map((box, index) => (
                    <View
                        key={`${box.x}-${box.y}-${index}`}
                        accessibilityLabel="Cited region"
                        style={[
                            styles.highlight,
                            {
                                left: `${box.x * 100}%`,
                                top: `${box.y * 100}%`,
                                width: `${box.width * 100}%`,
                                height: `${box.height * 100}%`,
                            },
                        ]}
                    />
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    wrapper: {
        gap: space.xs,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    caption: {
        color: palette.graphite,
        fontFamily: fonts.mono,
        fontSize: 12,
    },
    frame: {
        width: '100%',
        backgroundColor: palette.paperRaised,
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        overflow: 'hidden',
    },
    image: {
        width: '100%',
        height: '100%',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.md,
    },
    placeholderText: {
        color: palette.graphite,
        textAlign: 'center',
    },
    demoSheet: {
        flex: 1,
        backgroundColor: palette.paperRaised,
    },
    demoPanel: {
        position: 'absolute',
        borderWidth: 2,
        borderColor: palette.charcoal,
        backgroundColor: palette.paperDeep,
        justifyContent: 'flex-end',
        padding: space.xs,
    },
    demoGroove: {
        position: 'absolute',
        backgroundColor: palette.charcoalSoft,
    },
    demoDivider: {
        position: 'absolute',
        borderWidth: 2,
        borderColor: palette.charcoal,
        backgroundColor: palette.paperDeep,
        justifyContent: 'center',
        paddingLeft: space.xs,
    },
    demoLabel: {
        color: palette.charcoal,
        fontFamily: fonts.mono,
        fontSize: 11,
    },
    highlight: {
        position: 'absolute',
        borderWidth: 2,
        borderColor: palette.signal,
        backgroundColor: 'rgba(224, 86, 31, 0.12)',
    },
})
