/** Compare complete texts without erasing signs, units, ratios or internal punctuation that may change a fact. */
export const normalize = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim().replace(/\.$/u, '')

const characters = (text: string): number => Array.from(text).length
const words = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/u).length)

/**
 * Sentences of a text, keeping their punctuation. A terminator splits only before whitespace, so a decimal
 * ("2.5 turns") or a dotted token never separates a quantity or condition from the sentence it belongs to.
 */
export function sentencesOf(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+/u)
        .map((part) => part.trim())
        .filter((part) => part !== '')
}

const CONTINUATION = /^(?:unless|except|otherwise|if|when|only|and|but|however|or|then|until|before|after)\b/iu

/**
 * Sentences with a continuation ("Unless the panel is flat.") attached to the sentence it qualifies, so a condition or
 * exception can never be separated from the instruction it limits.
 */
export function clauses(text: string): string[] {
    const result: string[] = []
    for (const sentence of sentencesOf(text)) {
        const last = result.length - 1
        if (last >= 0 && CONTINUATION.test(sentence)) result[last] = `${result[last]} ${sentence}`
        else result.push(sentence)
    }
    return result
}

/**
 * Splits a complete text into consecutive display chunks that each fit the limits and together contain every word of
 * the original, in order (`chunks.join(' ')` equals the whitespace-normalized text). Nothing is clipped or elided:
 * boundaries prefer sentences, then clauses, then single words.
 */
export function splitLossless(text: string, maxCharacters: number, maxWords = Number.POSITIVE_INFINITY): string[] {
    const normalized = text.replace(/\s+/gu, ' ').trim()
    const fits = (candidate: string): boolean =>
        characters(candidate.trim()) <= maxCharacters && words(candidate) <= maxWords
    if (normalized === '') return []
    if (fits(normalized)) return [normalized]
    const patterns = [/(?<=[.!?])\s+/u, /(?<=[;:])\s+/u, /(?<=,)\s+/u, /\s+/u]
    for (const pattern of patterns) {
        const pieces = normalized.split(pattern).filter((piece) => piece !== '')
        if (pieces.length < 2) continue
        const chunks: string[] = []
        let current = ''
        for (const piece of pieces) {
            const candidate = current === '' ? piece : `${current} ${piece}`
            if (fits(candidate)) {
                current = candidate
                continue
            }
            if (current !== '') chunks.push(current)
            current = piece
        }
        if (current !== '') chunks.push(current)
        // A piece that still does not fit is split by the next, finer boundary.
        return chunks.flatMap((chunk) => (fits(chunk) ? [chunk] : splitLossless(chunk, maxCharacters, maxWords)))
    }
    // One unbroken token longer than the limit: hard split, still lossless.
    const long = Array.from(normalized)
    const out: string[] = []
    for (let at = 0; at < long.length; at += maxCharacters) out.push(long.slice(at, at + maxCharacters).join(''))
    return out
}
