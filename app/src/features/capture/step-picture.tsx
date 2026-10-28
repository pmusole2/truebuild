import { useState, type ReactElement } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import type { ManualSession, SourceRef } from '@truebuild/contracts'
import { Skeleton } from '../../ui/skeleton'
import { Caption } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { radius } from '../../theme/tokens'
import { ManualImage } from './page-media'
import type { WorkflowState } from './controller'

// Breathing room around a cited region so the part is shown with a little of its surroundings.
const CROP_MARGIN = 0.12

type Crop = { x: number; y: number; width: number; height: number }

/** The area of the page to show: the cited region with a margin, or the whole page when none is cited. Normalized. */
export function cropFor(region: SourceRef['region']): Crop {
    if (region === null || region === undefined) {
        return { x: 0, y: 0, width: 1, height: 1 }
    }
    const x = Math.max(0, region.x - region.width * CROP_MARGIN)
    const y = Math.max(0, region.y - region.height * CROP_MARGIN)
    const right = Math.min(1, region.x + region.width * (1 + CROP_MARGIN))
    const bottom = Math.min(1, region.y + region.height * (1 + CROP_MARGIN))
    return { x, y, width: right - x, height: bottom - y }
}

/** Where to draw the page image so `crop` fills the frame as large as it fits, centred. Pure for its own test. */
export function placeCrop(
    frame: { width: number; height: number },
    page: { width: number; height: number },
    crop: Crop,
): { left: number; top: number; width: number; height: number } {
    const cropWidth = crop.width * page.width
    const cropHeight = crop.height * page.height
    const scale = Math.min(frame.width / cropWidth, frame.height / cropHeight)
    const width = page.width * scale
    const height = page.height * scale
    const centreX = (crop.x + crop.width / 2) * width
    const centreY = (crop.y + crop.height / 2) * height
    return { left: frame.width / 2 - centreX, top: frame.height / 2 - centreY, width, height }
}

/**
 * The manual's own picture for a step, cropped to the cited area, filling a frame of `height` points. This is the hero
 * before any photo has been taken. A page that has not loaded yet shows a skeleton, never a blank box.
 */
export function StepPicture({
    reference,
    session,
    pageUris,
    height,
    testID = 'guide-hero',
}: {
    reference: SourceRef | undefined
    session: ManualSession
    pageUris: WorkflowState['pageUris']
    height: number
    testID?: string
}): ReactElement {
    const { colors } = useTheme()
    const [width, setWidth] = useState(0)
    const page =
        session.pages.find((candidate) => candidate.pageId === reference?.pageId) ??
        (reference === undefined ? session.pages[0] : undefined)
    const uri = page === undefined ? undefined : pageUris[page.pageId]
    const onLayout = (event: LayoutChangeEvent): void => setWidth(event.nativeEvent.layout.width)
    const placed =
        page === undefined || width === 0
            ? null
            : placeCrop({ width, height }, page, cropFor(reference?.region ?? null))
    return (
        <View
            testID={testID}
            onLayout={onLayout}
            style={[styles.frame, { height, backgroundColor: colors.surfaceSunken }]}
        >
            {page === undefined ? (
                <Caption>There is no picture for this step.</Caption>
            ) : uri === undefined || placed === null ? (
                <Skeleton height={height} />
            ) : (
                <ManualImage uri={uri} label="Picture from your manual" style={[styles.image, placed]} />
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    frame: {
        width: '100%',
        overflow: 'hidden',
        borderRadius: radius.hero,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
    },
    image: { position: 'absolute' },
})
