// Type-checking and web fallback. Metro selects local-store.native.ts on iOS and Android.
export { webManualStore as localStore } from '../../storage/manual-store.web'
