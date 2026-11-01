import type { PieceSpec } from '@truebuild/contracts'

/** TEST ONLY: hand-written assembly shapes, never an extraction or a live model result. */
export const VIEWER_FIXTURE_PIECES: readonly PieceSpec[] = [
    {
        id: 'fixture-corner-bracket',
        name: 'Corner bracket',
        color: '#427FBD',
        parts: [
            {
                type: 'box',
                dimensions: { width: 2.5, height: 0.24, depth: 1.5 },
                position: [0, -0.65, 0],
                rotation: [0, 0, 0],
            },
            {
                type: 'box',
                dimensions: { width: 0.24, height: 1.7, depth: 1.5 },
                position: [-1.13, 0.08, 0],
                rotation: [0, 0, 0],
            },
            {
                type: 'cylinder',
                dimensions: { radius: 0.28, height: 0.3 },
                position: [0.5, -0.4, 0],
                rotation: [0, 0, 0],
            },
        ],
    },
    {
        id: 'fixture-retaining-pin',
        name: 'Retaining pin',
        color: '#BD7042',
        parts: [
            {
                type: 'cylinder',
                dimensions: { radius: 0.22, height: 1.9 },
                position: [0, 0, 0],
                rotation: [0, 0, 0],
            },
            {
                type: 'sphere',
                dimensions: { radius: 0.4 },
                position: [0, 1.05, 0],
                rotation: [0, 0, 0],
            },
            {
                type: 'cone',
                dimensions: { radius: 0.22, height: 0.5 },
                position: [0, -1.2, 0],
                rotation: [Math.PI, 0, 0],
            },
            {
                type: 'torus',
                dimensions: { radius: 0.45, tube: 0.09 },
                position: [0, 0.7, 0],
                rotation: [Math.PI / 2, 0, 0],
            },
        ],
    },
    {
        id: 'fixture-handle-grip',
        name: 'Handle grip',
        color: '#568A69',
        parts: [
            {
                type: 'capsule',
                dimensions: { radius: 0.34, length: 1.8 },
                position: [0, 0, 0],
                rotation: [0, 0, Math.PI / 2],
            },
            {
                type: 'box',
                dimensions: { width: 0.5, height: 0.6, depth: 0.5 },
                position: [0, -0.45, 0],
                rotation: [0, 0, 0],
            },
        ],
    },
]
