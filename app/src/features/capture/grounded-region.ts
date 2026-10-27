import { normalizedBoxSchema, type NormalizedBox } from '@truebuild/contracts'

/** Optional question grounding is accepted after the API track merge; checks retain their existing observedRegion. */
export function groundedRegion(result: unknown): NormalizedBox | null {
    if (typeof result !== 'object' || result === null) {
        return null
    }
    const region = normalizedBoxSchema.safeParse(Reflect.get(result, 'observedRegion'))
    return region.success ? region.data : null
}
