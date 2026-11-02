import type { ComponentType } from 'react'
import type { GLViewProps } from 'expo-gl'

/** The lazy external GL boundary keeps ordinary documents and unavailable devices independent of the native module. */
export async function loadPieceGL(): Promise<{ default: ComponentType<GLViewProps> }> {
    const module = await import('expo-gl')
    return { default: module.GLView }
}
