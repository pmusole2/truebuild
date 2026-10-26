import { useRef, useState, type ReactElement } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { contentMaxWidth, palette, space } from '../../components/theme'
import { ActionButton, Notice, Panel, SectionTitle, TextField } from '../../components/ui'
import { ModelApiClient, type SessionStatus } from '../../api/model-client'
import { modelConnectionStore, useModelConnection } from './connection-store'

export const DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:3001'

type ConnectionScreenProps = {
    readonly onBack?: () => void
}

function sessionText(status: SessionStatus): string {
    if (status.status === 'verified') {
        return status.model === 'configured'
            ? `The backend reports a model key is configured. That means a key is present, not that the model has been tested. No model call was made. Session expires at ${new Date(status.expiresAt).toLocaleTimeString()}.`
            : 'The backend reports model calls are not configured. Live checks will report unconfigured. No model call was made.'
    }
    if (status.status === 'unavailable' && status.code === 'unconfigured') {
        return 'The backend has model calls turned off. No request was sent to a model.'
    }
    return 'Could not reach the backend. Check that it is running on this device.'
}

// Owner token is typed here only once: it moves into the memory-only store and this field is emptied.
export function ConnectionScreen({ onBack }: ConnectionScreenProps): ReactElement {
    const connection = useModelConnection()
    const [origin, setOrigin] = useState(connection?.origin ?? DEFAULT_BACKEND_ORIGIN)
    const [token, setToken] = useState('')
    const [notice, setNotice] = useState<string | null>(null)
    const [checking, setChecking] = useState(false)
    const checkingRef = useRef(false)

    function connect(): void {
        try {
            // The constructor validates the origin and rejects an empty token. It performs no I/O.
            new ModelApiClient({ baseUrl: origin, token })
        } catch (error: unknown) {
            setNotice(
                error instanceof Error && error.message.includes('token')
                    ? 'Enter the owner session token from the backend terminal.'
                    : 'Use a plain local address such as http://127.0.0.1:3001, with no path or credentials.',
            )
            return
        }
        modelConnectionStore.connect(new URL(origin).origin, token)
        setToken('')
        setNotice(null)
    }

    async function check(): Promise<void> {
        const current = modelConnectionStore.get()
        if (current === null || checkingRef.current) {
            return
        }
        // The reply belongs to this connection only; a replaced or cleared connection ignores it.
        const startedGeneration = current.generation
        checkingRef.current = true
        setChecking(true)
        try {
            const status = await new ModelApiClient({ baseUrl: current.origin, token: current.token }).session()
            if (modelConnectionStore.currentGeneration() !== startedGeneration) {
                return
            }
            if (status.status === 'unauthorized') {
                modelConnectionStore.clearIfCurrent(startedGeneration)
                setNotice('The owner token was rejected, so the connection was cleared. Enter a current token.')
                return
            }
            if (status.status === 'verified') {
                modelConnectionStore.recordSession(startedGeneration, {
                    model: status.model,
                    expiresAt: status.expiresAt,
                })
                setNotice(null)
                return
            }
            setNotice(sessionText(status))
        } finally {
            checkingRef.current = false
            setChecking(false)
        }
    }

    function disconnect(): void {
        modelConnectionStore.clear()
        setToken('')
        setNotice(null)
    }

    const connected = connection !== null
    const verified = connection?.session ?? null

    return (
        <ScrollView contentContainerStyle={styles.page}>
            <View style={styles.inner}>
                {onBack === undefined ? null : <ActionButton label="Back to manuals" onPress={onBack} />}
                <Text accessibilityRole="header" style={styles.title}>
                    Live backend connection
                </Text>
                <Notice text="Fixture mode is the default. Without a connection this app sends no requests and calls no model." />

                <Panel>
                    <SectionTitle>Connect</SectionTitle>
                    <TextField
                        label="Local backend address"
                        value={origin}
                        onChangeText={setOrigin}
                        placeholder={DEFAULT_BACKEND_ORIGIN}
                    />
                    <TextField
                        label="Owner session token"
                        value={token}
                        onChangeText={setToken}
                        placeholder="Paste from the backend terminal"
                        secure
                    />
                    <View style={styles.actions}>
                        <ActionButton label="Connect" tone="primary" disabled={token.length === 0} onPress={connect} />
                        <ActionButton
                            label={checking ? 'Checking…' : 'Check session'}
                            disabled={!connected || checking}
                            onPress={() => void check()}
                        />
                        <ActionButton label="Disconnect" tone="danger" disabled={!connected} onPress={disconnect} />
                    </View>
                    <Text style={styles.body}>
                        {connected
                            ? verified === null
                                ? 'Connected. Not checked yet. Check session makes one authenticated status request and no model call.'
                                : sessionText({
                                      status: 'verified',
                                      model: verified.model,
                                      expiresAt: verified.expiresAt,
                                  })
                            : 'Not connected. The token is not stored anywhere; it is lost when the app reloads.'}
                    </Text>
                </Panel>

                {notice === null ? null : <Notice tone="error" text={notice} />}
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
    title: {
        color: palette.charcoal,
        fontSize: 22,
        fontWeight: '700',
    },
    body: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 22,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
})
