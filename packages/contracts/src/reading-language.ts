import { z } from 'zod'

/** The reading languages the app offers: the codes the reader takes and the English names the person sees. */
export const READING_LANGUAGES = [
    { code: 'en', label: 'English', motionCopy: { approximate: 'Approximate', loading: 'Showing how it moves' } },
    { code: 'es', label: 'Spanish', motionCopy: { approximate: 'Aproximado', loading: 'Mostrando cómo se mueve' } },
    { code: 'fr', label: 'French', motionCopy: { approximate: 'Approximatif', loading: 'Visualisation du mouvement' } },
    { code: 'de', label: 'German', motionCopy: { approximate: 'Ungefähr', loading: 'So bewegt es sich' } },
    {
        code: 'pt-BR',
        label: 'Portuguese',
        motionCopy: { approximate: 'Aproximado', loading: 'Mostrando como se move' },
    },
] as const

export function stepMotionCopy(language: string): { readonly approximate: string; readonly loading: string } {
    const code = language.toLowerCase()
    return (
        READING_LANGUAGES.find((entry) => entry.code.toLowerCase() === code) ??
        READING_LANGUAGES.find((entry) => entry.code.split('-')[0] === code.split('-')[0]) ??
        READING_LANGUAGES[0]
    ).motionCopy
}

export const READING_LANGUAGE_CODES = READING_LANGUAGES.map((language) => language.code)

export const parseLanguageSchema = z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
    .max(16)
