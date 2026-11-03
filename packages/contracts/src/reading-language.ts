import { z } from 'zod'

export const parseLanguageSchema = z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
    .max(16)
