import { useState, type ReactElement, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ThemeProvider, useTheme } from '../../theme/theme'
import type { ColorScheme } from '../../theme/tokens'
import { AppButton, IconButton, type ButtonVariant } from '../button'
import { CameraChrome } from '../camera-chrome'
import { FeedbackProvider } from '../feedback'
import { Icon, type IconName } from '../icons'
import { ComparisonFrame } from '../comparison'
import { SegmentedControl, SettingRow, TextField } from '../fields'
import { ResultSheet } from '../result-sheet'
import { AskSheet } from '../ask-sheet'
import { InstructionSheet } from '../sheet'
import { ManualCard, ThumbnailCard } from '../cards'
import { ProgressBar, StepList } from '../progress'
import { EmptyState, ErrorState, LoadingState, PermissionState } from '../states'
import { Notice, StatusTag, VerdictTag } from '../status'
import { Card, Screen, Stack } from '../surface'
import { Body, Callout, Caption, Heading, Label, Title } from '../text'
import { SkeletonLines } from '../skeleton'
import {
    INSTRUCTION_EXAMPLE,
    PART_EXAMPLES,
    PREVIEW_BANNER,
    SAMPLE_REGION,
    STEP_EXAMPLES,
    VERDICT_EXAMPLES,
} from './examples'

const BUTTON_VARIANTS: readonly ButtonVariant[] = ['primary', 'accent', 'secondary', 'quiet', 'danger']
const ICON_NAMES: readonly IconName[] = [
    'alert',
    'camera',
    'check',
    'chevronLeft',
    'chevronRight',
    'close',
    'help',
    'image',
    'info',
    'plus',
    'refresh',
    'search',
]

const SCHEME_OPTIONS = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
] as const

function PreviewSection({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
    return (
        <Card>
            <Heading>{title}</Heading>
            <Stack gap="sm">{children}</Stack>
        </Card>
    )
}

function Preview(): ReactElement {
    const [askText, setAskText] = useState('')
    const [askTarget, setAskTarget] = useState<string | null>(null)
    const [sheetOpen, setSheetOpen] = useState(false)
    const [fieldText, setFieldText] = useState('')
    const [setting, setSetting] = useState(false)
    const [choice, setChoice] = useState<'left' | 'right'>('left')
    const { colors } = useTheme()
    return (
        <Screen>
            <Notice tone="caution" text={PREVIEW_BANNER} />

            <PreviewSection title="Typography">
                <Title>Workshop title</Title>
                <Heading>Section heading</Heading>
                <Body>Body copy reads at the system size and scales to 200 percent.</Body>
                <Callout>Callout text for notices and secondary guidance.</Callout>
                <Caption>Caption for captions, hints and helper text.</Caption>
                <Label>Stamp label</Label>
            </PreviewSection>

            <PreviewSection title="Buttons">
                {BUTTON_VARIANTS.map((variant) => (
                    <AppButton key={variant} label={`${variant} button`} variant={variant} onPress={noopPreview} />
                ))}
                <AppButton label="Disabled button" disabled={true} onPress={noopPreview} />
                <AppButton label="Busy button" busy={true} onPress={noopPreview} />
                <View style={styles.row}>
                    <IconButton label="Preview close" icon="close" onPress={noopPreview} />
                    <IconButton label="Preview search" icon="search" onPress={noopPreview} variant="secondary" />
                </View>
            </PreviewSection>

            <PreviewSection title="Icons">
                <View style={styles.row}>
                    {ICON_NAMES.map((name) => (
                        <View key={name} style={styles.iconCell}>
                            <Icon name={name} />
                            <Caption>{name}</Caption>
                        </View>
                    ))}
                </View>
            </PreviewSection>

            <PreviewSection title="Status and verdicts">
                <View style={styles.row}>
                    <VerdictTag verdict="pass" />
                    <VerdictTag verdict="refuse" />
                    <VerdictTag verdict="cannot_verify" />
                </View>
                <StatusTag label="Simulated" tone="simulated" icon="info" />
                <StatusTag label="Unconfirmed" tone="accent" />
            </PreviewSection>

            <PreviewSection title="Results">
                {VERDICT_EXAMPLES.map((example) => (
                    <ResultSheet
                        key={example.verdict}
                        verdict={example.verdict}
                        reason={example.reason}
                        missing={example.missing}
                        provenance={example.provenance}
                        citedPage={
                            example.verdict === 'refuse' ? (
                                <Notice text="Cited manual page: placeholder, not an image." />
                            ) : undefined
                        }
                    />
                ))}
            </PreviewSection>

            <PreviewSection title="Notices">
                <Notice text="Information: read in place." />
                <Notice tone="caution" text="Caution: check before continuing." />
                <Notice tone="error" text="Error: announced as an alert." />
            </PreviewSection>

            <PreviewSection title="Cards">
                <ThumbnailCard title="Side panel photo" caption="Step 1" selected={true} onPress={noopPreview} />
                <ThumbnailCard title="Unphotographed step" onPress={noopPreview} />
                <ManualCard title="Side divider" summary="6 pages · 2 steps" onPress={noopPreview} />
                <ManualCard title="Bookshelf" summary="4 pages · 1 step" selected={true} onPress={noopPreview} />
            </PreviewSection>

            <PreviewSection title="Progress and steps">
                <ProgressBar label="Steps confirmed" value={1} total={4} />
                <StepList steps={STEP_EXAMPLES} />
            </PreviewSection>

            <PreviewSection title="Loading, empty, error and permission">
                <LoadingState label="Reading the manual" />
                <SkeletonLines />
                <EmptyState
                    title="No manual yet"
                    body="Photograph a manual to start a plan."
                    action={{ label: 'Photograph a manual', onPress: noopPreview }}
                />
                <ErrorState
                    title="Check unavailable"
                    body="Nothing was shown as a result."
                    retry={{ label: 'Try again', onPress: noopPreview }}
                />
                <PermissionState
                    title="Camera is off"
                    body="Allow the camera to photograph the assembly."
                    primary={{ label: 'Allow camera', onPress: noopPreview }}
                    secondary={{ label: 'Choose a photo', onPress: noopPreview }}
                />
            </PreviewSection>

            <PreviewSection title="Fields and settings">
                <TextField
                    label="Question about this step"
                    value={fieldText}
                    onChangeText={setFieldText}
                    placeholder="Type a question"
                    hint="Nothing is sent from this preview."
                />
                <TextField label="Shared key" value="" onChangeText={noopText} secure={true} error="Enter the key." />
                <SegmentedControl<'left' | 'right'>
                    label="Panel side"
                    value={choice}
                    onChange={setChoice}
                    options={[
                        { value: 'left', label: 'Left' },
                        { value: 'right', label: 'Right' },
                    ]}
                />
                <SettingRow
                    label="Keep photos on this device"
                    description="Example setting. Changing it here changes nothing."
                    value={setting}
                    onValueChange={setSetting}
                />
            </PreviewSection>

            <PreviewSection title="Camera">
                <View style={styles.cameraFrame}>
                    <CameraChrome
                        hint="Frame the whole step."
                        shutterLabel="Preview shutter"
                        onShutter={noopPreview}
                        onClose={noopPreview}
                    >
                        <Text style={{ color: colors.ink }}>Placeholder viewfinder</Text>
                    </CameraChrome>
                </View>
            </PreviewSection>

            <PreviewSection title="Sheets">
                <AppButton label="Open instruction sheet" onPress={() => setSheetOpen(true)} />
                <InstructionSheet
                    visible={sheetOpen}
                    title="Step 1"
                    steps={INSTRUCTION_EXAMPLE}
                    onClose={() => setSheetOpen(false)}
                />
                <AskSheet
                    question={askText}
                    questionLabel="Question about frozen photo"
                    onQuestionChange={setAskText}
                    parts={PART_EXAMPLES}
                    selectedPartId={askTarget}
                    onSelectPart={setAskTarget}
                    targetSummary={askTarget === null ? 'Choose a point or part.' : 'Selected part (preview only).'}
                    hasTarget={askTarget !== null}
                    onSubmit={noopPreview}
                    disabledReason={askText.trim().length === 0 ? 'Type a question to enable the button.' : undefined}
                    answer={<Notice text="Preview only: an answer would appear here." />}
                />
            </PreviewSection>

            <PreviewSection title="Comparison">
                <ComparisonFrame
                    diagram={{
                        caption: 'Manual diagram',
                        media: <Caption>Placeholder diagram (landscape)</Caption>,
                        mediaSize: { width: 4, height: 3 },
                    }}
                    photo={{
                        caption: 'Your photo (portrait)',
                        media: <Caption>Placeholder photo</Caption>,
                        mediaSize: { width: 3, height: 4 },
                        regions: [SAMPLE_REGION],
                    }}
                />
                <Caption>Refusal layout: side by side at phone width, stacked under large text.</Caption>
                <ComparisonFrame
                    layout="row"
                    diagram={{
                        caption: 'Manual diagram',
                        media: <Caption>Placeholder diagram</Caption>,
                        mediaSize: { width: 4, height: 3 },
                    }}
                    photo={{
                        caption: 'Your photo',
                        media: <Caption>Placeholder photo</Caption>,
                        mediaSize: { width: 3, height: 4 },
                        regions: [SAMPLE_REGION],
                    }}
                />
            </PreviewSection>
        </Screen>
    )
}

// Every preview control is inert. Nothing in this file reaches the product flow, a network or a native module.
function noopPreview(): void {
    return undefined
}

function noopText(): void {
    return undefined
}

/**
 * Component gallery for design review. Light/dark and reduced motion can be switched here without touching the product.
 */
export function ComponentPreview(): ReactElement {
    const [scheme, setScheme] = useState<ColorScheme>('light')
    const [reduceMotion, setReduceMotion] = useState(false)
    return (
        <ThemeProvider scheme={scheme}>
            <FeedbackProvider reduceMotion={reduceMotion}>
                <View style={styles.controls}>
                    <SegmentedControl<ColorScheme>
                        label="Preview appearance"
                        value={scheme}
                        onChange={setScheme}
                        options={SCHEME_OPTIONS}
                    />
                    <SettingRow
                        label="Reduce motion (preview)"
                        description="Forces the reduced-motion path for this preview only."
                        value={reduceMotion}
                        onValueChange={setReduceMotion}
                    />
                </View>
                <Preview />
            </FeedbackProvider>
        </ThemeProvider>
    )
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
    },
    iconCell: {
        alignItems: 'center',
        gap: 4,
        minWidth: 72,
    },
    controls: {
        padding: 16,
        gap: 12,
    },
    cameraFrame: {
        height: 420,
        borderRadius: 12,
        overflow: 'hidden',
    },
})
