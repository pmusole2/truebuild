/** Explicit fixture builds only; ordinary release bundles keep the seam disabled. */
declare const __DEV__: boolean

export type ProofConfig = Readonly<{ runId: string; baseUrl: string }>

export type ProofConfigInputs = {
    readonly development: boolean
    readonly releaseFixture?: string | undefined
    readonly enabled: string | undefined
    readonly providerMode: string | undefined
    readonly baseUrl: string
    readonly runId?: string | undefined
}

export function resolveProofConfig(inputs: ProofConfigInputs): ProofConfig | null {
    const release = inputs.releaseFixture
    if (release !== undefined && release !== '' && release !== '0' && release !== '1') {
        throw new Error('Invalid release fixture build flag')
    }
    if (!inputs.development && release !== '1') return null
    if (release === '1' && (inputs.enabled !== '1' || inputs.runId === undefined)) {
        throw new Error('Release fixture requires explicit opt-in and namespace')
    }
    if (inputs.enabled === undefined || inputs.enabled === '' || inputs.enabled === '0') {
        return null
    }
    if (inputs.enabled !== '1' || inputs.providerMode !== 'fixture') {
        throw new Error('Native proof requires explicit fixture mode')
    }
    let url: URL
    try {
        url = new URL(inputs.baseUrl)
    } catch {
        throw new Error('Native proof requires the isolated loopback fixture API')
    }
    if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.port !== '3101' ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== ''
    ) {
        throw new Error('Native proof requires the isolated loopback fixture API')
    }
    const runId = inputs.runId ?? 'fixture-build-v1'
    if (!/^[A-Za-z0-9-]{1,48}$/u.test(runId)) throw new Error('Invalid native proof namespace')
    return Object.freeze({ runId, baseUrl: url.origin })
}

/** Static public build flags only. A fixture release is explicit and never uses the ordinary library. */
export function nativeProofConfig(baseUrl: string): ProofConfig | null {
    return resolveProofConfig({
        development: typeof __DEV__ !== 'undefined' && __DEV__,
        releaseFixture: process.env.EXPO_PUBLIC_RELEASE_FIXTURE,
        enabled: process.env.EXPO_PUBLIC_AI_EFFORT_PROOF,
        providerMode: process.env.EXPO_PUBLIC_PROVIDER_MODE,
        baseUrl,
        runId: process.env.EXPO_PUBLIC_AI_EFFORT_PROOF_RUN,
    })
}
