import { AiConsentStore } from './consent-store'
import { consentStorage } from './consent-storage'
import { developmentConsent } from './consent-development'

/** Metro selects native storage/launch URLs; the shared API graph never imports native ambient types. */
export const aiConsent = new AiConsentStore(consentStorage, developmentConsent)
