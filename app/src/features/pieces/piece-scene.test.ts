import { describe, expect, it } from 'vitest'
import { Box3, ExtrudeGeometry, LatheGeometry, Mesh, PerspectiveCamera, Vector3 } from 'three'
import type { PieceSpec } from '@truebuild/contracts'
import { createPieceObject, disposePieceObject, framePieceCamera } from './piece-scene'

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
        {
            type: 'lathe',
            profile: [
                [0.2, 0.5],
                [0.6, 0.2],
                [0.4, -0.5],
            ],
            segments: 24,
            ...common,
        },
        {
            type: 'extrude',
            outline: [
                [-1, 0],
                [0, -0.3],
                [1, 0],
                [0.7, 0.5],
                [-0.7, 0.5],
            ],
            depth: 0.2,
            bevel: 0.02,
            ...common,
        },
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
            const positions = child.geometry.getAttribute('position')
            const normals = child.geometry.getAttribute('normal')
            expect(positions.count).toBeGreaterThan(0)
            expect(normals.count).toBe(positions.count)
            for (const value of [...positions.array, ...normals.array]) expect(Number.isFinite(value)).toBe(true)
            if (child.geometry.type === 'LatheGeometry') {
                let outward = false,
                    lowerCap = false,
                    upperCap = false
                for (let index = 0; index < positions.count; index++) {
                    const point = new Vector3().fromBufferAttribute(positions, index)
                    const normal = new Vector3().fromBufferAttribute(normals, index)
                    const radial = Math.hypot(point.x, point.z)
                    if (radial > 0.59 && point.x * normal.x + point.z * normal.z > 0) outward = true
                    if (radial < 1e-8 && point.y === -0.5) lowerCap = true
                    if (radial < 1e-8 && point.y === 0.5) upperCap = true
                }
                expect({ outward, lowerCap, upperCap }).toEqual({ outward: true, lowerCap: true, upperCap: true })
            }
            child.geometry.addEventListener('dispose', () => {
                geometries++
            })
            child.material.addEventListener('dispose', () => {
                materials++
            })
        })
        const objects = object.children[0]!.children
        expect((objects[6] as Mesh).geometry).toBeInstanceOf(LatheGeometry)
        expect((objects[7] as Mesh).geometry).toBeInstanceOf(ExtrudeGeometry)
        expect(meshes).toBe(8)
        disposePieceObject(object)
        expect(geometries).toBe(8)
        expect(materials).toBe(8)
        expect(object.children).toEqual([])
        disposePieceObject(object)
        expect(geometries).toBe(8)
        expect(materials).toBe(8)
    })

    it('frames every vertex of a wide multi-part piece with margin in each viewport and current rotated pose', () => {
        const object = createPieceObject({
            ...piece,
            parts: [
                {
                    type: 'box',
                    dimensions: { width: 18, height: 0.5, depth: 5 },
                    position: [4, -2, 0],
                    rotation: [0, 0.2, 0],
                },
                {
                    type: 'box',
                    dimensions: { width: 0.5, height: 6, depth: 0.5 },
                    position: [-5, 0, -1.5],
                    rotation: [0, 0, 0],
                },
                piece.parts[6]!,
                piece.parts[7]!,
            ],
        })
        const camera = new PerspectiveCamera(35, 1, 0.001, 10000)
        try {
            for (const [width, height] of [
                [1200, 240],
                [320, 600],
                [688, 240],
            ]) {
                for (const [pitch, yaw] of [
                    [-0.24, 0.48],
                    [0.6, 1.9],
                    [-1, -0.7],
                ]) {
                    object.rotation.set(pitch!, yaw!, 0)
                    framePieceCamera(camera, object, width!, height!, 1)
                    object.traverse((child) => {
                        if (!(child instanceof Mesh)) return
                        const positions = child.geometry.getAttribute('position')
                        for (let index = 0; index < positions.count; index++) {
                            const projected = new Vector3()
                                .fromBufferAttribute(positions, index)
                                .applyMatrix4(child.matrixWorld)
                                .project(camera)
                            expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.800001)
                            expect(Math.abs(projected.y)).toBeLessThanOrEqual(0.800001)
                            expect(Math.abs(projected.z)).toBeLessThan(1)
                        }
                    })
                    framePieceCamera(camera, object, width!, height!, 3)
                    const bounds = new Box3().setFromObject(object)
                    expect(camera.position.distanceTo(bounds.getCenter(new Vector3()))).toBeGreaterThanOrEqual(
                        bounds.getSize(new Vector3()).length() * 0.6 - 1e-8,
                    )
                }
            }
        } finally {
            disposePieceObject(object)
        }
    })
})
