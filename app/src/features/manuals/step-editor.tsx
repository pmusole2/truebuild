import type { ManualSession, ManualStep } from '@truebuild/contracts'
import { useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { palette, radius, space, touchTarget } from '../../components/theme'
import { ActionButton, Notice, Panel, SectionTitle, Tag } from '../../components/ui'
import { FactDraft, TextDraft, citedPageNumbers, pageNumberOf, partDisplayName } from './fact-draft'
import type { ManualEdit } from './manual-edits'

type StepEditorProps = {
    readonly session: ManualSession
    readonly step: ManualStep
    readonly citePageId: string
    readonly isFirst: boolean
    readonly isLast: boolean
    readonly onEdit: (edit: ManualEdit) => void
    readonly onOpenCheck: () => void
    readonly checkBlockedReason: string | null
}

function knownText(fact: ManualStep['orientation']): string | null {
    return fact.state === 'known' ? fact.value.description : null
}

function knownConnectionIds(step: ManualStep): ReadonlySet<string> {
    return step.connection.state === 'known' ? new Set(step.connection.value.partIds) : new Set()
}

function toggled(selection: ReadonlySet<string>, partId: string): ReadonlySet<string> {
    const next = new Set(selection)

    if (next.has(partId)) {
        next.delete(partId)
    } else {
        next.add(partId)
    }

    return next
}

// Every step field is editable here and every change resets review through the domain layer.
export function StepEditor({
    session,
    step,
    citePageId,
    isFirst,
    isLast,
    onEdit,
    onOpenCheck,
    checkBlockedReason,
}: StepEditorProps): ReactElement {
    const requiredIds = new Set(step.parts.map((part) => part.partId))
    const addable = session.parts.filter((part) => !requiredIds.has(part.partId))
    const selectedPageNumber = pageNumberOf(session, citePageId)
    const [orientationTargetId, setOrientationTargetId] = useState<string | null>(
        step.orientation.state === 'known' ? step.orientation.value.partId : null,
    )
    const [connectionTargetIds, setConnectionTargetIds] = useState<ReadonlySet<string>>(() => knownConnectionIds(step))
    // The explicit selection, in the step's required-part order. Save always sends it, even when it is empty.
    const connectionSelection = step.parts
        .map((part) => part.partId)
        .filter((partId) => connectionTargetIds.has(partId))
    const quantityOf = (partId: string): string | null => {
        const requirement = step.parts.find((part) => part.partId === partId)
        return requirement?.quantity.state === 'known' ? String(requirement.quantity.value) : null
    }

    return (
        <Panel>
            <View style={styles.headerRow}>
                <Text style={styles.stepNumber}>Step {step.order}</Text>
                <Tag
                    tone={session.reviewStatus === 'reviewed' ? 'reviewed' : 'unreviewed'}
                    text={session.reviewStatus === 'reviewed' ? 'Reviewed' : 'Unreviewed'}
                />
            </View>
            <TextDraft
                key={`title-${session.revision}-${step.stepId}`}
                label="Step title"
                initialValue={step.title}
                actionLabel="Save title"
                onSubmit={(title) => onEdit({ kind: 'set-step-title', stepId: step.stepId, title })}
            />

            <SectionTitle>Required parts</SectionTitle>
            {step.parts.length === 0 ? <Text style={styles.empty}>No parts required yet.</Text> : null}
            {step.parts.map((requirement) => {
                const name = partDisplayName(session, requirement.partId)

                return (
                    <View key={requirement.partId} style={styles.block}>
                        <FactDraft
                            testID={`fact-quantity-${requirement.partId}`}
                            label={`Quantity of ${name}`}
                            value={quantityOf(requirement.partId)}
                            keyboardType="number-pad"
                            placeholder="Whole number"
                            sourcePages={
                                requirement.quantity.state === 'known'
                                    ? citedPageNumbers(session, requirement.quantity.sourceRefs)
                                    : undefined
                            }
                            selectedPage={selectedPageNumber}
                            onSave={(text) =>
                                onEdit({
                                    kind: 'set-step-part-quantity',
                                    stepId: step.stepId,
                                    partId: requirement.partId,
                                    quantity: { state: 'known', quantity: Number(text.trim()), pageId: citePageId },
                                })
                            }
                            onMarkUnknown={() =>
                                onEdit({
                                    kind: 'set-step-part-quantity',
                                    stepId: step.stepId,
                                    partId: requirement.partId,
                                    quantity: { state: 'unknown' },
                                })
                            }
                        />
                        <ActionButton
                            label={`Stop requiring ${name}`}
                            tone="danger"
                            onPress={() =>
                                onEdit({ kind: 'remove-step-part', stepId: step.stepId, partId: requirement.partId })
                            }
                        />
                    </View>
                )
            })}
            {addable.length > 0 ? (
                <View style={styles.actions}>
                    {addable.map((part) => (
                        <ActionButton
                            key={part.partId}
                            label={`Require ${partDisplayName(session, part.partId)}`}
                            onPress={() =>
                                onEdit({
                                    kind: 'add-step-part',
                                    stepId: step.stepId,
                                    partId: part.partId,
                                    pageId: citePageId,
                                })
                            }
                        />
                    ))}
                </View>
            ) : null}

            <SectionTitle>Orientation</SectionTitle>
            {step.parts.length > 0 ? (
                <View style={styles.targetRow}>
                    <Text style={styles.targetLabel}>
                        {orientationTargetId
                            ? `Target part: ${partDisplayName(session, orientationTargetId)}`
                            : 'Select target part'}
                    </Text>
                    <View style={styles.targetSelection}>
                        {step.parts.map((part) => (
                            <ActionButton
                                key={part.partId}
                                label={partDisplayName(session, part.partId)}
                                onPress={() => setOrientationTargetId(part.partId)}
                            />
                        ))}
                    </View>
                </View>
            ) : (
                <Text style={styles.empty}>Add a part to this step before describing its orientation.</Text>
            )}
            <FactDraft
                testID="fact-orientation"
                label="Orientation description"
                value={knownText(step.orientation)}
                sourcePages={
                    step.orientation.state === 'known'
                        ? citedPageNumbers(session, step.orientation.sourceRefs)
                        : undefined
                }
                selectedPage={selectedPageNumber}
                onSave={(text) => {
                    onEdit({
                        kind: 'set-step-orientation',
                        stepId: step.stepId,
                        description: { state: 'known', text, pageId: citePageId },
                        ...(orientationTargetId ? { partId: orientationTargetId } : {}),
                    })
                }}
                onMarkUnknown={() => {
                    onEdit({ kind: 'set-step-orientation', stepId: step.stepId, description: { state: 'unknown' } })
                    setOrientationTargetId(null)
                }}
            />

            <SectionTitle>Connection</SectionTitle>
            {step.parts.length > 0 ? (
                <View style={styles.targetRow}>
                    <Text style={styles.targetLabel}>
                        {connectionSelection.length > 0
                            ? `Target parts: ${connectionSelection
                                  .map((partId) => partDisplayName(session, partId))
                                  .join(', ')}`
                            : 'Select at least one target part.'}
                    </Text>
                    <View style={styles.targetSelection}>
                        {step.parts.map((requirement) => {
                            const selected = connectionTargetIds.has(requirement.partId)
                            const name = partDisplayName(session, requirement.partId)

                            return (
                                <Pressable
                                    key={requirement.partId}
                                    accessibilityRole="checkbox"
                                    accessibilityLabel={name}
                                    aria-checked={selected}
                                    onPress={() =>
                                        setConnectionTargetIds(toggled(connectionTargetIds, requirement.partId))
                                    }
                                    style={[styles.toggle, selected && styles.toggleSelected]}
                                >
                                    <Text style={[styles.toggleText, selected && styles.toggleTextSelected]}>
                                        {selected ? `✓ ${name}` : name}
                                    </Text>
                                </Pressable>
                            )
                        })}
                    </View>
                </View>
            ) : (
                <Text style={styles.empty}>Add a part to this step before describing its connection.</Text>
            )}
            <FactDraft
                testID="fact-connection"
                label="Connection description"
                value={step.connection.state === 'known' ? step.connection.value.description : null}
                sourcePages={
                    step.connection.state === 'known'
                        ? citedPageNumbers(session, step.connection.sourceRefs)
                        : undefined
                }
                selectedPage={selectedPageNumber}
                onSave={(text) => {
                    onEdit({
                        kind: 'set-step-connection',
                        stepId: step.stepId,
                        description: { state: 'known', text, pageId: citePageId },
                        partIds: connectionSelection,
                    })
                }}
                onMarkUnknown={() => {
                    onEdit({ kind: 'set-step-connection', stepId: step.stepId, description: { state: 'unknown' } })
                    setConnectionTargetIds(new Set())
                }}
            />

            <SectionTitle>Visible checks</SectionTitle>
            {step.visibleChecks.length === 0 ? (
                <Text style={styles.empty}>No visible checks yet. A reviewed step needs at least one.</Text>
            ) : null}
            {step.visibleChecks.map((check, position) => (
                <View key={check.checkId} style={styles.block}>
                    <Text style={styles.checkText}>
                        {check.description.state === 'known' ? check.description.value : 'Unknown check wording'}
                    </Text>
                    <ActionButton
                        label={`Remove visible check ${position + 1}`}
                        tone="danger"
                        onPress={() =>
                            onEdit({ kind: 'remove-step-check', stepId: step.stepId, checkId: check.checkId })
                        }
                    />
                </View>
            ))}
            <TextDraft
                key={`check-${session.revision}-${step.stepId}`}
                label="New visible check"
                initialValue=""
                actionLabel="Add visible check"
                placeholder="For example: divider is fully seated"
                onSubmit={(text) =>
                    onEdit({
                        kind: 'add-step-check',
                        stepId: step.stepId,
                        description: { state: 'known', text, pageId: citePageId },
                    })
                }
            />

            <View style={styles.actions}>
                <ActionButton
                    label="Move step up"
                    disabled={isFirst}
                    onPress={() => onEdit({ kind: 'move-step', stepId: step.stepId, direction: -1 })}
                />
                <ActionButton
                    label="Move step down"
                    disabled={isLast}
                    onPress={() => onEdit({ kind: 'move-step', stepId: step.stepId, direction: 1 })}
                />
                <ActionButton
                    label="Remove step"
                    tone="danger"
                    onPress={() => onEdit({ kind: 'remove-step', stepId: step.stepId })}
                />
            </View>
            <CorrectionReview session={session} step={step} onEdit={onEdit} />
            <Notice text="Browsing this step never verifies assembly. A check needs a saved, reviewed manual and a fresh photo of the assembly." />
            {checkBlockedReason === null ? null : <Notice tone="caution" text={checkBlockedReason} />}
            <ActionButton label="Open step check" disabled={checkBlockedReason !== null} onPress={onOpenCheck} />
        </Panel>
    )
}

/**
 * Proposed corrections are never reviewed automatically. A model-proposed correction shows as proposed until a person
 * confirms it against the cited manual page, or discards it. A confirmed correction is the only one shown as reviewed.
 */
function CorrectionReview({
    session,
    step,
    onEdit,
}: {
    readonly session: ManualSession
    readonly step: ManualStep
    readonly onEdit: (edit: ManualEdit) => void
}): ReactElement | null {
    const correction = step.correction
    if (correction === null) {
        return null
    }
    const pages = [...new Set(correction.actions.flatMap((action) => action.sourceRefs.map((ref) => ref.pageId)))]
        .map((pageId) => pageNumberOf(session, pageId))
        .filter((page): page is number => page !== undefined)
    return (
        <View style={styles.correction}>
            <SectionTitle>
                {correction.reviewed ? 'Confirmed correction' : 'Proposed correction (not confirmed)'}
            </SectionTitle>
            {correction.actions.map((action) => (
                <Text key={action.actionId} style={styles.checkText}>
                    {action.instruction}
                </Text>
            ))}
            <Text style={styles.checkText}>
                Cited: {pages.length === 0 ? 'no page' : pages.map((page) => `page ${page}`).join(', ')}
            </Text>
            {correction.reviewed ? null : (
                <Notice
                    tone="caution"
                    text="Check this against the cited page before confirming. The manual cannot be marked reviewed while it is unconfirmed."
                />
            )}
            <View style={styles.actions}>
                {correction.reviewed ? null : (
                    <ActionButton
                        label="Confirm correction against manual"
                        tone="primary"
                        onPress={() => onEdit({ kind: 'confirm-correction', stepId: step.stepId })}
                    />
                )}
                <ActionButton
                    label="Discard correction proposal"
                    tone="danger"
                    onPress={() => onEdit({ kind: 'discard-correction', stepId: step.stepId })}
                />
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    headerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    stepNumber: {
        color: palette.signalInk,
        fontWeight: '700',
        fontSize: 16,
    },
    block: {
        gap: space.xs,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: palette.rule,
    },
    correction: {
        gap: 6,
        paddingTop: 10,
    },
    checkText: {
        color: palette.charcoal,
        fontSize: 15,
    },
    empty: {
        color: palette.graphite,
        fontStyle: 'italic',
    },
    targetRow: {
        gap: space.xs,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: palette.rule,
    },
    targetLabel: {
        color: palette.charcoal,
        fontSize: 15,
        fontWeight: '600',
    },
    targetSelection: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    toggle: {
        minHeight: touchTarget,
        justifyContent: 'center',
        paddingHorizontal: space.sm,
        borderWidth: 1,
        borderRadius: radius,
        borderColor: palette.rule,
        backgroundColor: palette.paperRaised,
    },
    toggleSelected: {
        backgroundColor: palette.charcoal,
        borderColor: palette.charcoal,
    },
    toggleText: {
        color: palette.charcoal,
        fontWeight: '600',
    },
    toggleTextSelected: {
        color: palette.paperRaised,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
})
