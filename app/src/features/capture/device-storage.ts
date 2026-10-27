import AsyncStorage from '@react-native-async-storage/async-storage'
import type { KeyValueStorage } from './library'

/** Web AsyncStorage uses origin-local storage. Quota failures preserve the previous committed manifest. */
export const deviceStorage: KeyValueStorage = AsyncStorage
