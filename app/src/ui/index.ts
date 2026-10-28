// Public surface of the UI kit. Screens import from here; preview examples live in ./preview and are not product code.
export { AppButton, IconButton, type AppButtonProps, type ButtonVariant, type IconButtonProps } from './button'
export { Icon, type IconName, type IconSize } from './icons'
export {
    FeedbackProvider,
    noopHaptics,
    useFeedback,
    useSystemReduceMotion,
    type Feedback,
    type HapticKind,
    type HapticPort,
} from './feedback'
export { Body, Callout, Caption, Heading, Label, Title, type TextTone } from './text'
export { ActionDock, ActionGroup, Card, Divider, Screen, Stack, type CardTone } from './surface'
export { Notice, StatusTag, VerdictTag, type NoticeTone, type StatusTone, type Verdict } from './status'
export { ProgressBar, StepList, type StepListItem, type StepState } from './progress'
export { Skeleton, SkeletonCard, SkeletonLines } from './skeleton'
export { EmptyState, ErrorState, LoadingState, PermissionState, type StateAction } from './states'
export { SegmentedControl, SettingRow, TextField, type SegmentOption, type TextFieldProps } from './fields'
export { ThumbnailCard, ManualCard } from './cards'
export { CameraChrome, ShutterButton, ViewfinderCorners } from './camera-chrome'
export { BottomSheet, InstructionSheet } from './sheet'
export { ResultSheet } from './result-sheet'
export { ResultReveal } from './result-reveal'
export { AskSheet, type AskPart } from './ask-sheet'
export {
    ComparisonFrame,
    MeasuredPane,
    type ComparisonLayout,
    type ComparisonPane,
    type ComparisonRegion,
} from './comparison'
export { clampBox, regionOnFrame } from './comparison-geometry'
