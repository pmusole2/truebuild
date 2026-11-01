import { Stack as RouterStack } from 'expo-router'
import type { ReactElement } from 'react'
import { Image, View } from 'react-native'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { Card, Screen, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Title } from '../../ui/text'
import { PieceViewer, PiecesGrid } from './piece-viewer'
import { manualPieceContentHash } from './piece-registry'

const clock = (ms: number | null | undefined): string => (ms == null ? '—' : new Date(ms).toISOString().slice(11, 23))
const elapsed = (from: number | null | undefined, to: number | null | undefined): string =>
    from == null || to == null ? '' : ` · ${Math.max(0, to - from)} ms from request`

/**
 * Development-only view of the live piece registry: the snapshot the workflow actually holds for the selected manual.
 * It imports only the real registry and viewer, never the viewer fixtures, so its data is what the app persisted.
 */
export default function PiecesTestScreen(): ReactElement {
    const workflow = useOptionalWorkflow()
    const snapshot = workflow?.piecesSnapshot
    const session =
        workflow?.entry?.session ??
        workflow?.state.entries.find((entry) => manualPieceContentHash(entry.session) === snapshot?.contentHash)
            ?.session
    const rows = [
        ...(snapshot?.pieces ?? []).map((piece) => ({
            id: piece.id,
            name: piece.name,
            status: 'ready',
            issues: '',
            cutout: snapshot?.cutouts[piece.id],
        })),
        ...(snapshot?.cards ?? []).map((card) => ({
            id: card.id,
            name: card.name,
            status: card.state,
            issues: card.issueCodes.join(', '),
            cutout: snapshot?.cardCutouts[card.id],
        })),
    ]
    return (
        <>
            <RouterStack.Screen options={{ headerShown: false }} />
            <Screen testID="pieces-test" header="hidden">
                <Stack gap="md">
                    <Caption>Development · live registry</Caption>
                    <Title>Manual pieces</Title>
                    <View testID="pieces-test-status">
                        <Body>{`Status ${snapshot?.status ?? 'unavailable'} · ${snapshot?.pieces.length ?? 0} ready · ${snapshot?.cards.length ?? 0} not ready`}</Body>
                    </View>
                    <Caption>{`Manual ${session?.manualId ?? 'none selected'} · content ${snapshot?.contentHash?.slice(0, 12) ?? 'none'}`}</Caption>
                    <View testID="pieces-test-timing">
                        <Caption>{`Requested ${clock(snapshot?.timing.requestedAt)} · Started ${clock(snapshot?.timing.startedAt)} · Ready ${clock(snapshot?.timing.readyAt)}${elapsed(snapshot?.timing.requestedAt, snapshot?.timing.readyAt)}`}</Caption>
                    </View>
                    {rows.map((row) => (
                        <Card key={row.id}>
                            <View testID={`pieces-test-row-${row.id}`} style={{ gap: 6 }}>
                                {row.cutout === undefined ? (
                                    <Heading>{row.name}</Heading>
                                ) : (
                                    <Image
                                        source={{ uri: row.cutout }}
                                        resizeMode="contain"
                                        accessibilityLabel={row.name}
                                        style={{ width: '100%', height: 120 }}
                                    />
                                )}
                                <Body>{`${row.name} · ${row.status}${row.issues === '' ? '' : ` · ${row.issues}`}`}</Body>
                                {(snapshot?.pieces.slice(0, 3) ?? []).find((piece) => piece.id === row.id) ===
                                undefined ? null : (
                                    <PieceViewer
                                        piece={snapshot?.pieces.find((piece) => piece.id === row.id)}
                                        fallbackImageUri={row.cutout}
                                        height={240}
                                    />
                                )}
                            </View>
                        </Card>
                    ))}
                    <PiecesGrid pieces={snapshot?.pieces ?? []} cutouts={snapshot?.cutouts} />
                </Stack>
            </Screen>
        </>
    )
}
