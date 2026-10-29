import type { ManualStep } from '@truebuild/contracts'

// The app's own reading of "this sentence is a safety statement", applied to the manual's known facts. It exists so a
// step's safety wording is on screen whether or not a composed document kept it: a composed screen can reorder and
// reword, but it can never be the only place a warning lives. It mirrors the server's rule on purpose and does not
// depend on it; a sentence this finds is shown as written in the manual.
const SAFETY =
    /\b(warning|caution|danger|hazard|careful(?:ly)?|sharp|hot|heavy|two people|2 people|tip(?:s|ped)? over|tipping|topple|pinch|crush|electric(?:al)?|shock|unplug|anchor(?:ed|ing)?|fall(?:s|ing)?|injur(?:y|ies)|eye protection|gloves|do not|don't|never)\b/iu
const MAX_NOTES = 3
const MAX_CHARS = 160

function sentences(text: string): string[] {
    return (text.match(/[^.!?]+[.!?]*/gu) ?? []).map((part) => part.trim()).filter((part) => part !== '')
}

function knownText<T>(fact: { state: 'known'; value: T } | { state: 'unknown' }, read: (value: T) => string): string[] {
    return fact.state === 'known' ? [read(fact.value)] : []
}

function clip(text: string): string {
    const characters = Array.from(text.replace(/\s+/gu, ' ').trim())
    return characters.length <= MAX_CHARS
        ? characters.join('')
        : `${characters
              .slice(0, MAX_CHARS - 1)
              .join('')
              .trimEnd()}…`
}

/** Normalized form used to tell whether two safety sentences say the same thing. */
export function safetyKey(text: string): string {
    return text.toLowerCase().replace(/\s+/gu, ' ').trim().replace(/\.$/u, '')
}

/** The safety sentences of one step, in manual order, as written. Never invented, at most a few. */
export function stepSafetyNotes(step: ManualStep | undefined): string[] {
    if (step === undefined) return []
    const texts = [
        step.title,
        ...knownText(step.orientation, (value) => value.description),
        ...knownText(step.connection, (value) => value.description),
        ...step.visibleChecks.flatMap((check) => knownText(check.description, (value) => value)),
        ...(step.alternatives?.map((alternative) => `${alternative.title}. ${alternative.description}`) ?? []),
        ...(step.correction?.reviewed === true ? step.correction.actions.map((action) => action.instruction) : []),
    ]
    const found = new Map<string, string>()
    for (const text of texts) {
        for (const sentence of sentences(text)) {
            if (SAFETY.test(sentence) && !found.has(safetyKey(sentence))) found.set(safetyKey(sentence), clip(sentence))
        }
    }
    return [...found.values()].slice(0, MAX_NOTES)
}
