import { READING_LANGUAGES } from '@truebuild/contracts'

export function languageName(code: string): string {
    return READING_LANGUAGES.find((language) => language.code === code)?.label ?? code
}
export function rereadPrompt(session: {
    readingLanguage?: string
    parsedLanguage?: string
    rawExtraction: unknown
}): string | null {
    const selected = session.readingLanguage ?? 'en'
    const parsed = session.parsedLanguage ?? 'en'
    return session.rawExtraction !== null && selected !== parsed
        ? `This manual was read in ${languageName(parsed)}. Re-read in ${languageName(selected)}? This resets your corrections and build progress.`
        : null
}
