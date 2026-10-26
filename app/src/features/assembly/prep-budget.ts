import { awaitStopped, createCallGuard, type CallGuard } from '../../api/transport'

export type PrepStopReason = 'caller' | 'timeout' | 'invalid_input'
export type PrepOutcome<T> =
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: PrepStopReason }

/**
 * Owns one absolute action budget. The callback carries this guard through preparation and client publication,
 * rather than starting another action budget after preparing. Ignored promises cannot delay cancellation settlement.
 */
export async function beforeDispatch<T>(
    caller: AbortSignal | undefined,
    budgetMs: number,
    prepare: (guard: CallGuard) => Promise<T>,
): Promise<PrepOutcome<T>> {
    const guard = createCallGuard(budgetMs, caller)

    try {
        guard.checkpoint()
        const value = await awaitStopped(prepare(guard), guard.signal)
        guard.checkpoint()

        return { ok: true, value }
    } catch {
        return { ok: false, reason: guard.callerAborted() ? 'caller' : guard.timedOut() ? 'timeout' : 'invalid_input' }
    } finally {
        guard.dispose()
    }
}
