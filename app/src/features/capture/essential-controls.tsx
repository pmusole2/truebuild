import type { ReactElement, ReactNode } from 'react'
import { View } from 'react-native'
import { visitVariantNodesV2, type AppIntent, type ScreenKindV2, type ScreenVariantV2 } from '@truebuild/contracts'
import { AppButton, IconButton } from '../../ui/button'
import { RenderOriginProvider, originId } from '../../ui/render-origin'
import { space } from '../../theme/tokens'
import { Caption } from '../../ui/text'
import type { FrameBindings } from '../documents/types'
import type { ResolvedIntent } from '../screens/intents'
import type { LibraryEntry } from './library'
import type { WorkflowState } from './controller'
import type { WorkflowController } from './workflow-types'
import type { ScreenNav } from './screen-nav'
import { stopFor } from './plain-copy'

/** Camera capture and photo-library import are separate capabilities, even when both are capture intents. */
export function resolveCameraCapture(
    intent: AppIntent,
    camera: FrameBindings['camera'],
    busy: boolean,
    choosePages: (() => void) | undefined,
): ResolvedIntent | null {
    if (intent.intent !== 'capture') return null
    if (intent.target === 'choose-pages') {
        const enabled = !busy && choosePages !== undefined
        return {
            enabled,
            reason: enabled ? null : 'Choosing photos is not available right now.',
            run: (): void => {
                if (enabled) choosePages?.()
            },
        }
    }
    if (intent.target !== 'take-photo' && intent.target !== 'retake') return null
    const enabled = !busy && camera?.ready === true
    return {
        enabled,
        reason: enabled ? null : 'The camera is not ready.',
        run: (): void => {
            if (enabled) camera?.capture()
        },
    }
}

/** App-owned navigation survives an incomplete model layout; equivalent visible model intents win deduplication. */
export function EssentialDocumentControls({
    kind,
    variant,
    state,
    entry,
    busy,
    resolve,
    controller,
    nav,
    primary,
    secondary,
}: {
    readonly primary?: ReactNode
    readonly secondary?: ReactNode
    readonly kind: ScreenKindV2
    readonly variant: ScreenVariantV2
    readonly state: WorkflowState
    readonly entry: LibraryEntry | undefined
    readonly busy: boolean
    readonly resolve: (intent: AppIntent) => ResolvedIntent
    readonly controller: WorkflowController
    readonly nav: ScreenNav
}): ReactElement | null {
    const intents = new Set<string>()
    let stepper = false
    const remember = (intent: AppIntent): void => {
        intents.add(`${intent.intent}:${intent.target}`)
    }
    if (variant.header.back !== null) remember(variant.header.back.intent)
    variant.header.actions.forEach((action) => remember(action.intent))
    visitVariantNodesV2(variant, '', ({ node, hidden }) => {
        if (hidden) return
        if ('intent' in node) remember(node.intent)
        if (node.type === 'Choice' && node.options.mode === 'intents')
            node.options.items.forEach((item) => remember(item.intent))
        if (node.type === 'Stepper' && node.binding === 'steps') stepper = true
    })
    const importAction =
        (kind === 'add' || kind === 'pages') && !intents.has('capture:choose-pages')
            ? resolve({ intent: 'capture', target: 'choose-pages' })
            : null
    const resume =
        kind === 'home' && !intents.has('navigate:guide')
            ? [...state.entries]
                  .filter((candidate) => stopFor(candidate) !== 'done')
                  .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))[0]
            : undefined
    const steps = kind === 'guide' && !stepper && entry?.session.reviewStatus === 'reviewed' ? entry : undefined
    // The closer look runs with no `pending`, so this cue is informational and never part of `disabled` below.
    const doubleChecking =
        kind === 'result' &&
        state.check?.decision === 'cannot_verify' &&
        state.check.secondOpinion?.status === 'available'
    if (
        primary === undefined &&
        secondary === undefined &&
        importAction === null &&
        resume === undefined &&
        steps === undefined &&
        !doubleChecking
    )
        return null
    const disabled = busy || state.storageReadOnly
    return (
        <RenderOriginProvider origin="shell">
            <View
                nativeID={originId('shell')}
                testID="essential-controls"
                style={primary === undefined ? { paddingHorizontal: space.md, gap: space.xs } : { gap: space.xs }}
            >
                {!doubleChecking ? null : (
                    <View testID="shell-double-checking" nativeID={originId('shell')} accessibilityLiveRegion="polite">
                        <Caption>Double-checking…</Caption>
                    </View>
                )}
                {importAction === null ? null : (
                    <AppButton
                        label="Choose photos"
                        testID="shell-choose-photos"
                        variant="quiet"
                        disabled={disabled || !importAction.enabled}
                        onPress={importAction.run}
                    />
                )}
                {resume === undefined ? null : (
                    <AppButton
                        label="Resume"
                        testID="shell-resume"
                        variant="quiet"
                        disabled={disabled || state.loading}
                        onPress={(): void => {
                            if (!disabled && !state.loading) nav.openStop(resume)
                        }}
                    />
                )}
                {steps === undefined ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                        {primary === undefined ? null : <View style={{ flex: 1 }}>{primary}</View>}
                        {secondary}
                    </View>
                ) : (
                    <View
                        testID="guide-action-row"
                        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
                        nativeID={originId('shell')}
                    >
                        <IconButton
                            label="Previous step"
                            icon="chevronLeft"
                            testID="shell-previous-step"
                            variant="secondary"
                            disabled={disabled || steps.stepIndex === 0}
                            onPress={(): void => {
                                if (!disabled && steps.stepIndex > 0) void controller.step(steps.stepIndex - 1)
                            }}
                        />
                        {primary === undefined ? null : <View style={{ flex: 1 }}>{primary}</View>}
                        {secondary}
                        <IconButton
                            label="Next step"
                            icon="chevronRight"
                            testID="shell-next-step"
                            variant="secondary"
                            disabled={disabled || steps.stepIndex >= steps.session.reviewedSteps.length - 1}
                            onPress={(): void => {
                                if (!disabled && steps.stepIndex < steps.session.reviewedSteps.length - 1)
                                    void controller.step(steps.stepIndex + 1)
                            }}
                        />
                    </View>
                )}
            </View>
        </RenderOriginProvider>
    )
}
