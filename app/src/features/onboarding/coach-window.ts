import { Dimensions, Platform, useWindowDimensions } from 'react-native'

/** Both Android coach hosts cover the status/navigation areas; targets use that same full-screen space. */
export function useCoachWindow(): ReturnType<typeof useWindowDimensions> {
    const window = useWindowDimensions()
    return Platform.OS === 'android' ? { ...window, height: Dimensions.get('screen').height } : window
}
