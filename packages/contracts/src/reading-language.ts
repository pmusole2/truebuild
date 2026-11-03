import { z } from 'zod'

/** The reading languages the app offers: the codes the reader takes and the English names the person sees. */
export const READING_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'pt-BR', label: 'Portuguese' },
] as const

export const READING_LANGUAGE_CODES = READING_LANGUAGES.map((language) => language.code)

export const parseLanguageSchema = z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
    .max(16)
