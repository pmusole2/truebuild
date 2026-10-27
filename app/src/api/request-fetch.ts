import type { ModelFetch } from './model-client'

export const requestFetch: ModelFetch = (url, init): Promise<Response> => fetch(url, init)
