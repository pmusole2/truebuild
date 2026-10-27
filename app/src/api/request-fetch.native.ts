import { fetch as expoFetch } from 'expo/fetch'
import type { ModelFetch } from './model-client'

/** Streaming native bodies preserve the client's bounded reader and absolute deadline during response consumption. */
export const requestFetch: ModelFetch = (url, init): Promise<Response> => expoFetch(url, init) as Promise<Response>
