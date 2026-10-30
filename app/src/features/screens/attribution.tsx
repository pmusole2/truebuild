import type { ReactElement } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { router } from 'expo-router'
import type { ScreenDocumentV2 } from '@truebuild/contracts'
import type { CheckStages, StageStatus } from '../capture/controller'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { FrozenPhoto } from '../assembly/frozen-photo'
import { SegmentMasks } from '../assembly/grounded-overlays'
import { AppButton } from '../../ui/button'
import { useFeedback } from '../../ui/feedback'
import { useContentFade } from '../../ui/motion'
import { SettingRow } from '../../ui/fields'
import { Stack } from '../../ui/surface'
import { Caption, Heading } from '../../ui/text'
import { useJudge } from './judge-context'
import { PROOF_EVIDENCE_LABEL } from '../ai-effort-proof/evidence'
import { proofEvidenceLabel } from './proof-mode'
import { orderStages } from './stage-order'
import {
    NATIVE_HOST_METER_SCOPE,
    type NativeHostFailure,
    type NativeHostMeasurement,
    type NativeHostSessionSummary,
} from './native-host-meter'
import { useMeterReading } from './native-meter'

/** The exact label of the one judge preference. */
export const BUILT_TOGGLE_LABEL = 'Show how Meta AI built this'
export const NOT_RECORDED = 'Not recorded'

const ms = (value: number | null | undefined): string =>
    value === null || value === undefined ? NOT_RECORDED : `${Math.round(value)} ms`

/** The device-only toggle. Off by default; on adds the current screen's attribution and nothing else. */
export function BuiltToggleRow(): ReactElement {
    const { showBuilt, setShowBuilt } = useJudge()
    return (
        <SettingRow
            testID="judge-built-toggle"
            label={BUILT_TOGGLE_LABEL}
            description="Stays on this phone."
            value={showBuilt}
            onValueChange={setShowBuilt}
        />
    )
}

/** Opens the judge-only comparison of two parsed manuals. A real screen, not a gallery case. */
export function CompareManualsRow({ onOpen }: { readonly onOpen?: () => void }): ReactElement | null {
    const { showBuilt } = useJudge()
    if (!showBuilt) return null
    return (
        <AppButton
            testID="judge-compare"
            label="Compare two manuals"
            variant="quiet"
            onPress={(): void => {
                onOpen?.()
                router.push('/compare' as never)
            }}
        />
    )
}

function Row({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
    return <Caption>{`${label}: ${value}`}</Caption>
}

const REASON_WORDS: Readonly<Record<NativeHostFailure, string>> = {
    'no-roots': 'no screen has been counted yet',
    'missing-root': 'a screen or sheet could not be reached',
    disconnected: 'a screen changed while it was being counted',
    'invalid-marker': 'a screen label was malformed',
    'unsupported-tree': 'this runtime does not expose the native view tree',
    'traversal-limit': 'the screens were too large to count',
    'root-census-changed': 'screens changed while counting',
    'incomplete-checkpoints': 'an earlier check could not be counted',
    'no-checkpoints': 'nothing has been counted yet',
    'empty-tree': 'there was nothing on screen',
    disposed: 'the counter was turned off',
    'focus-unavailable': 'the current screen could not be reached',
}

const percent = (share: number | null): string => (share === null ? NOT_RECORDED : `${(share * 100).toFixed(1)}%`)
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour12: false })

function countsLine(counts: { generated: number; fallback: number; shell: number; total: number }): string {
    return `${counts.total} elements: ${counts.generated} generated, ${counts.fallback} app-built, ${counts.shell} native`
}

function sampleLine(measurement: NativeHostMeasurement): string {
    return measurement.status === 'measured'
        ? `${countsLine(measurement.counts)} (${percent(measurement.generatedShare)} generated)`
        : `${NOT_RECORDED} (${REASON_WORDS[measurement.reason]})`
}

function sessionLine(summary: NativeHostSessionSummary | null): string {
    if (summary === null || summary.sampleCount === 0) return `${NOT_RECORDED} (nothing has been counted yet)`
    return summary.status === 'measured'
        ? `${summary.sampleCount} checkpoints, ${countsLine(summary.counts).replace('elements:', 'element observations:')} (${percent(summary.generatedShare)} generated, weighted across checkpoints), lowest screen ${percent(summary.minimumScreenGeneratedShare)}`
        : `${NOT_RECORDED} (${REASON_WORDS[summary.reason]})`
}

/**
 * The elements actually on this phone, counted from the running screen through the public host view API: the root, this
 * screen and the whole session, each with when it was counted, whether it is out of date, and what the count covers. A
 * count that could not be taken says why and shows no number. Nothing is estimated or taken from a document.
 */
export function HostCounts(): ReactElement {
    const { active, snapshot, session, measureNow } = useMeterReading()
    if (!active) {
        return <Row label="On-screen elements" value={`${NOT_RECORDED} on this device`} />
    }
    const latest = snapshot?.latest ?? null
    const screen =
        latest === null ? undefined : session?.screens.find((item) => item.screen === latest.checkpoint.screen)
    return (
        <>
            <Row
                label="On-screen elements, all open screens"
                value={latest === null ? `${NOT_RECORDED} (measuring)` : sampleLine(latest)}
            />
            {latest === null ? null : (
                <Row
                    label="Counted"
                    value={`${clock(latest.sampledAt)} on ${latest.checkpoint.screen}, ${snapshot?.stale === true ? 'out of date, a new count is due' : 'sampled snapshot'}, ${latest.rootCount ?? 0} root${latest.rootCount === 1 ? '' : 's'}`}
                />
            )}
            <Row
                label="This screen, lowest over the session"
                value={screen === undefined ? NOT_RECORDED : percent(screen.minimumGeneratedShare)}
            />
            <Row label="Whole session" value={sessionLine(session)} />
            <Row
                label="Whole session, strict (capability internals excluded)"
                value={
                    session === null || session.strictGeneratedShare === null
                        ? NOT_RECORDED
                        : `${percent(session.strictGeneratedShare)} generated`
                }
            />
            <Row
                label="Mean per route"
                value={
                    session === null ||
                    session.meanRouteGeneratedShare === null ||
                    session.meanRouteStrictGeneratedShare === null
                        ? NOT_RECORDED
                        : `${percent(session.meanRouteGeneratedShare)} generated, ${percent(session.meanRouteStrictGeneratedShare)} strict`
                }
            />
            <Caption>{`Counts ${NATIVE_HOST_METER_SCOPE}. Navigation hosts are included; physical keyboard and system views are outside this scope.`}</Caption>
            <Caption>Use Count again after opening details or inspecting a component.</Caption>
            <AppButton testID="judge-measure" label="Count again" variant="quiet" onPress={measureNow} />
        </>
    )
}

function stageWord(status: StageStatus, waited = 'measured on this phone'): string {
    switch (status.status) {
        case 'pending':
            return 'Working'
        case 'landed':
            return `Landed after ${ms(status.elapsedMs)} (${waited})`
        case 'skipped':
            return `Skipped (${status.reason.replace('_', ' ')})`
        case 'failed':
            return `Did not finish (${status.code}${status.elapsedMs === null ? '' : `, ${ms(status.elapsedMs)}`})`
    }
}

function StageRow({
    rank,
    label,
    value,
    scope,
    identity,
}: {
    readonly rank: number
    readonly label: string
    readonly value: string
    readonly scope: string | null
    readonly identity: string
}): ReactElement {
    // A stage fades in once when it lands; under Reduce Motion the shared primitive shows it at once.
    const fade = useContentFade(identity, true)
    return (
        <Animated.View style={fade}>
            <Row label={`${rank}. ${label}`} value={value} />
            {scope === null ? null : <Caption>{scope}</Caption>}
        </Animated.View>
    )
}

/** When a stage arrived, in this phone's own time after the verdict was published; null when it has not arrived. */
function arrival(status: StageStatus): number | null {
    return status.status === 'landed' || status.status === 'failed' ? (status.elapsedMs ?? null) : null
}

const phoneScope = (at: number | null): string | null =>
    at === null ? null : `Arrived ${Math.round(at)} ms after the verdict, by this phone's clock.`

/**
 * The same held photo with the stages that followed its verdict, in the order they arrived on this phone: the verdict,
 * the composed result screen, the precise mask and the extra regions. The photo is the one the verdict is about, and
 * its mask is drawn on it only from that photo's own stage. Each line says what happened, and which clock any time
 * comes from (the server's own record, or this phone's wait), so a stage that never landed reads as that and never as a
 * success. The verdict and everything the person can do never wait for a later stage.
 */
export function StagesPanel({
    check,
    stages,
    resultDocument,
    resultArrivedAt,
}: {
    readonly check: { readonly model?: string; readonly decision: string; readonly evidence?: string } | null
    readonly stages: CheckStages | null | undefined
    readonly resultDocument?: ScreenDocumentV2 | null
    readonly resultArrivedAt?: number | null
}): ReactElement | null {
    const { showBuilt } = useJudge()
    const workflow = useOptionalWorkflow()
    const { reduceMotion } = useFeedback()
    if (!showBuilt || check === null) return null
    const primary = workflow?.state.primary
    const capture = workflow?.state.capture ?? null
    // The run's own guard, or the server's stamp on this very result: either way no model ran and none is credited.
    const proof = proofEvidenceLabel() ?? (check.evidence === 'synthetic-fixture' ? PROOF_EVIDENCE_LABEL : null)
    // On simulated IO the wait is this phone's own, not a provider's, and a model named by an offer is only a target.
    const waited = proof === null ? 'measured on this phone' : 'phone wait on simulated IO, not provider time'
    const sameHeldPhoto = capture !== null && primary?.captureId === capture.binding.captureId
    const masks =
        sameHeldPhoto && stages != null && stages.captureId === capture.binding.captureId
            ? stages.masks.filter((mark) => mark.mask !== undefined)
            : []
    const sameDocument =
        resultDocument?.kind === 'result' && resultDocument.bound.captureId === capture?.binding.captureId
    const readyAt = sameDocument ? (resultArrivedAt ?? null) : null
    const resultAt =
        readyAt !== null && stages?.publishedAt !== undefined ? Math.max(0, readyAt - stages.publishedAt) : null
    const maskAt = stages == null ? null : arrival(stages.segments)
    const regionsAt = stages == null ? null : arrival(stages.overlay)
    const rows = orderStages([
        {
            id: 'verdict' as const,
            at: 0,
            label: 'Verdict',
            identity: 'verdict',
            scope: null,
            value: `${(proof === null ? primary?.model : null) ?? NOT_RECORDED}, ${primary?.deviceMs == null ? NOT_RECORDED : `${ms(primary.deviceMs)} (${waited})`}`,
        },
        {
            id: 'result' as const,
            at: resultAt,
            label: 'Result screen',
            identity: `result:${sameDocument ? resultDocument.screenId : 'none'}`,
            scope: phoneScope(resultAt),
            value: sameDocument
                ? `${resultDocument.metadata.source === 'fallback' ? `App fallback (${resultDocument.metadata.fallbackReason ?? 'Not recorded'})` : resultDocument.metadata.evidence === 'synthetic-fixture' ? 'Simulated fixture composition' : 'Model-composed'}, model ${resultDocument.metadata.model ?? NOT_RECORDED}, effort ${resultDocument.metadata.effort ?? NOT_RECORDED}, provider ${ms(resultDocument.metadata.timing.totalMs)}`
                : 'Not asked for',
        },
        {
            id: 'mask' as const,
            at: maskAt,
            label: 'Precise mask',
            identity: `mask:${stages?.segments.status ?? 'none'}`,
            scope: phoneScope(maskAt),
            value:
                stages == null
                    ? 'Not offered'
                    : `${stageWord(stages.segments, waited)}${stages.segments.status === 'landed' || stages.segments.status === 'failed' ? `, server ${ms(proof === null ? (stages.segments.modelElapsedMs ?? null) : null)}` : ''}${stages.segments.status === 'landed' ? `, ${stages.masks.filter((mark) => mark.mask !== undefined).length} outlined, model ${proof === null ? (stages.segments.model ?? NOT_RECORDED) : NOT_RECORDED}` : ''}`,
        },
        {
            id: 'regions' as const,
            at: regionsAt,
            label: 'Extra regions',
            identity: `regions:${stages?.overlay.status ?? 'none'}`,
            scope: phoneScope(regionsAt),
            value:
                stages == null
                    ? 'Not offered'
                    : `${stageWord(stages.overlay, waited)}${stages.overlay.status === 'landed' ? `, model ${proof === null ? (stages.overlay.model ?? NOT_RECORDED) : NOT_RECORDED}, effort ${proof === null ? (stages.overlay.effort ?? NOT_RECORDED) : NOT_RECORDED}` : ''}`,
        },
    ])
    return (
        <Stack gap="xs">
            <Heading>Same photo, in the order it arrived</Heading>
            {proof === null ? null : <Row label="Evidence" value={proof} />}
            {sameHeldPhoto ? (
                <View testID="stages-photo">
                    <FrozenPhoto
                        observation={capture.observation}
                        caption="The photo all of this is about."
                        overlay={(displayed): ReactElement | null =>
                            masks.length === 0 ? null : (
                                <SegmentMasks marks={masks} displayed={displayed} reduceMotion={reduceMotion} />
                            )
                        }
                    />
                </View>
            ) : null}
            {rows.map((row, index) => (
                <StageRow
                    key={row.id}
                    rank={index + 1}
                    label={row.label}
                    value={row.value}
                    scope={row.scope}
                    identity={row.identity}
                />
            ))}
        </Stack>
    )
}
