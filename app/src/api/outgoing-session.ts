import { withoutUnreviewedCorrections, type ManualSession, type ScreenContextInputsV2 } from '@truebuild/contracts'

/**
 * The session a model request may carry: the shared projection that leaves an unreviewed correction as `null`, in the
 * reviewed steps and in the raw extraction. The saved session is never changed; every identity or hash of a request is
 * computed from this projection, so the context still matches what is sent.
 */
export const outgoingManualSession: (session: ManualSession) => ManualSession = withoutUnreviewedCorrections

/** The inputs of one screen request with its session projected. Inputs without a session pass through unchanged. */
export function outgoingInputs(inputs: ScreenContextInputsV2): ScreenContextInputsV2 {
    return inputs.session === null ? inputs : { ...inputs, session: outgoingManualSession(inputs.session) }
}
