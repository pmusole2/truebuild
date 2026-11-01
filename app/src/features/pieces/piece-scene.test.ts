import { describe, expect, it } from 'vitest'
import { Mesh } from 'three'
import type { PieceSpec } from '@truebuild/contracts'
import { createPieceObject, disposePieceObject } from './piece-scene'

const common: { position: [number, number, number]; rotation: [number, number, number] } = {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const piece: PieceSpec = {
    id: 'test-primitives',
    name: 'Assembly primitives',
    color: '#5978A5',
    parts: [
        { type: 'box', dimensions: { width: 1, height: 1, depth: 1 }, ...common },
        { type: 'cylinder', dimensions: { radius: 0.5, height: 1 }, ...common },
        { type: 'sphere', dimensions: { radius: 0.5 }, ...common },
        { type: 'cone', dimensions: { radius: 0.5, height: 1 }, ...common },
        { type: 'torus', dimensions: { radius: 0.5, tube: 0.1 }, ...common },
        { type: 'capsule', dimensions: { radius: 0.25, length: 1 }, ...common },
    ],
}

describe('piece resource ownership', () => {
    it('releases every real primitive geometry and material once and detaches the objects', () => {
        const object = createPieceObject(piece)
        let geometries = 0,
            materials = 0,
            meshes = 0
        object.traverse((child) => {
            if (!(child instanceof Mesh)) return
            meshes++
            child.geometry.addEventListener('dispose', () => {
                geometries++
            })
            child.material.addEventListener('dispose', () => {
                materials++
            })
        })
        expect(meshes).toBe(6)
        disposePieceObject(object)
        expect(geometries).toBe(6)
        expect(materials).toBe(6)
        expect(object.children).toEqual([])
        disposePieceObject(object)
        expect(geometries).toBe(6)
        expect(materials).toBe(6)
    })
})
