import { spawn } from 'node:child_process'

import { z } from 'zod'

import type { Deadline } from './deadline'

const MAX_CLIP_BYTES = 20 * 1_024 * 1_024
const FFPROBE = '/opt/homebrew/bin/ffprobe'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'

export class ClipError extends Error {
    constructor(readonly code: 'invalid_input' | 'unavailable') {
        super(code)
        this.name = 'ClipError'
    }
}

export interface NormalizedClip {
    bytes: Uint8Array
    mimeType: 'video/mp4'
    width: number
    height: number
    frameCount: number
    durationSeconds: number
}

async function codec(
    executable: string,
    args: readonly string[],
    bytes: Uint8Array,
    outputLimit: number,
    deadline: Deadline,
): Promise<Uint8Array> {
    deadline.checkpoint()
    return new Promise((resolve, reject): void => {
        const child = spawn(executable, [...args], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' },
        })
        const chunks: Buffer[] = []
        let outputBytes = 0
        let errorBytes = 0
        let stopped = false
        let unavailable = false
        function stop(): void {
            stopped = true
            child.kill('SIGKILL')
        }
        deadline.signal.addEventListener('abort', stop, { once: true })
        if (deadline.signal.aborted) {
            stop()
        }
        child.stdout.on('data', (chunk: Buffer): void => {
            outputBytes += chunk.length
            if (outputBytes > outputLimit) {
                stop()
            } else {
                chunks.push(Buffer.from(chunk))
            }
        })
        child.stderr.on('data', (chunk: Buffer): void => {
            errorBytes += chunk.length
            if (errorBytes > 16_384) {
                stop()
            }
        })
        child.stdin.on('error', (): void => {
            stop()
        })
        child.on('error', (): void => {
            unavailable = true
        })
        child.on('close', (code): void => {
            deadline.signal.removeEventListener('abort', stop)
            try {
                deadline.checkpoint()
                if (unavailable) {
                    throw new ClipError('unavailable')
                }
                if (stopped || code !== 0 || errorBytes > 0) {
                    throw new ClipError('invalid_input')
                }
                resolve(new Uint8Array(Buffer.concat(chunks)))
            } catch (error) {
                reject(error)
            }
        })
        child.stdin.end(bytes)
    })
}

const streamSchema = z.object({
    codec_type: z.string(),
    codec_name: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    duration: z.string().optional(),
    nb_read_frames: z.string().optional(),
    avg_frame_rate: z.string().optional(),
    sample_aspect_ratio: z.string().optional(),
    tags: z.object({ rotate: z.string().optional() }).optional(),
    side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
})
const probeSchema = z.object({
    frames: z
        .array(
            z.object({
                media_type: z.string(),
                width: z.number().int().positive().optional(),
                height: z.number().int().positive().optional(),
                sample_aspect_ratio: z.string().optional(),
                best_effort_timestamp_time: z.string().optional(),
                duration_time: z.string().optional(),
                side_data_list: z.array(z.object({ side_data_type: z.string() })).optional(),
            }),
        )
        .max(1_000),
    streams: z.array(streamSchema).min(1).max(8),
    format: z.object({
        format_name: z.string(),
        duration: z.string().optional(),
        tags: z.object({ major_brand: z.string().optional() }).optional(),
    }),
})

type Probe = Omit<NormalizedClip, 'bytes' | 'mimeType'> & { streams: number; frameOffsets: number[] }

async function probe(bytes: Uint8Array, deadline: Deadline, normalized: boolean): Promise<Probe> {
    const output = await codec(
        FFPROBE,
        [
            '-v',
            'error',
            '-max_alloc',
            '33554432',
            '-threads',
            '1',
            '-protocol_whitelist',
            'pipe',
            '-format_whitelist',
            'mov',
            '-count_frames',
            '-show_frames',
            '-show_entries',
            'frame=media_type,width,height,sample_aspect_ratio,best_effort_timestamp_time,duration_time:frame_side_data=side_data_type:stream=codec_type,codec_name,width,height,duration,nb_read_frames,avg_frame_rate,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration:format_tags=major_brand',
            '-of',
            'json',
            '-i',
            'pipe:0',
        ],
        bytes,
        262_144,
        deadline,
    )
    deadline.checkpoint()
    let parsed: z.infer<typeof probeSchema>
    try {
        parsed = probeSchema.parse(JSON.parse(Buffer.from(output).toString('utf8')))
    } catch {
        throw new ClipError('invalid_input')
    }
    const videos = parsed.streams.filter((stream) => stream.codec_type === 'video')
    const video = videos[0]
    if (
        videos.length !== 1 ||
        !video ||
        !parsed.format.format_name.split(',').includes('mov') ||
        (normalized && parsed.streams.length !== 1)
    ) {
        throw new ClipError('invalid_input')
    }
    const brand = parsed.format.tags?.major_brand?.trim()
    if (!brand || !['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V', 'qt'].includes(brand)) {
        throw new ClipError('unavailable')
    }
    if (!['h264', 'hevc', 'mpeg4'].includes(video.codec_name)) {
        throw new ClipError('invalid_input')
    }
    if (
        video.codec_name !== 'h264' ||
        (video.tags?.rotate !== undefined && Number(video.tags.rotate) !== 0) ||
        (video.side_data_list?.length ?? 0) > 0 ||
        video.sample_aspect_ratio !== '1:1'
    ) {
        throw new ClipError('unavailable')
    }
    const width = video.width
    const height = video.height
    const durationSeconds = Number(video.duration)
    const containerDuration = Number(parsed.format.duration)
    const frameCount = Number(video.nb_read_frames)
    const rate = /^(\d+)\/(\d+)$/u.exec(video.avg_frame_rate ?? '')
    const fps = Number(rate?.[1]) / Number(rate?.[2])
    if (
        width === undefined ||
        height === undefined ||
        width * height > 24_000_000 ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > 5 ||
        !Number.isFinite(containerDuration) ||
        containerDuration <= 0 ||
        containerDuration > 5 ||
        !Number.isSafeInteger(frameCount) ||
        frameCount <= 0 ||
        frameCount > 150 ||
        !Number.isFinite(fps) ||
        fps <= 0 ||
        frameCount / fps > 5 ||
        Math.abs(frameCount / fps - durationSeconds) > 1 / fps
    ) {
        throw new ClipError('invalid_input')
    }
    const frames = parsed.frames.filter((frame) => frame.media_type === 'video')
    if (frames.length !== frameCount) {
        throw new ClipError('invalid_input')
    }
    const times = frames.map((frame) => Number(frame.best_effort_timestamp_time))
    const firstTime = times[0]
    const lastTime = times.at(-1)
    const lastDuration = Number(frames.at(-1)?.duration_time)
    if (
        firstTime === undefined ||
        lastTime === undefined ||
        !times.every(Number.isFinite) ||
        !Number.isFinite(lastDuration) ||
        lastDuration <= 0 ||
        lastTime + lastDuration - firstTime > 5 ||
        times.some((time, index) => index > 0 && time <= (times[index - 1] ?? time))
    ) {
        throw new ClipError('invalid_input')
    }
    if (
        frames.some(
            (frame) =>
                frame.width !== width ||
                frame.height !== height ||
                frame.sample_aspect_ratio !== '1:1' ||
                frame.side_data_list?.some(
                    (side) => side.side_data_type !== 'H.26[45] User Data Unregistered SEI message',
                ),
        )
    ) {
        throw new ClipError('unavailable')
    }
    return {
        width,
        height,
        durationSeconds,
        frameCount,
        streams: parsed.streams.length,
        frameOffsets: times.map((time) => time - firstTime),
    }
}

/** Qualified subset: nonrotated H.264 only. Unsupported orientations/codecs fail explicitly unavailable. */
export async function normalizeClip(
    input: { bytes: Uint8Array; mimeType: 'video/mp4' | 'video/quicktime' },
    deadline: Deadline,
): Promise<NormalizedClip> {
    deadline.checkpoint()
    if (
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.length === 0 ||
        input.bytes.length > MAX_CLIP_BYTES ||
        !['video/mp4', 'video/quicktime'].includes(input.mimeType)
    ) {
        throw new ClipError('invalid_input')
    }
    const owned = new Uint8Array(input.bytes)
    for (const [executable, name] of [
        [FFPROBE, 'ffprobe'],
        [FFMPEG, 'ffmpeg'],
    ] as const) {
        const version = await codec(executable, ['-version'], new Uint8Array(), 16_384, deadline)
        deadline.checkpoint()
        if (!Buffer.from(version).toString('utf8').startsWith(`${name} version 8.0.1 `)) {
            throw new ClipError('unavailable')
        }
    }
    const source = await probe(owned, deadline, false)
    deadline.checkpoint()
    const bytes = await codec(
        FFMPEG,
        [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-max_alloc',
            '33554432',
            '-threads',
            '1',
            '-protocol_whitelist',
            'pipe',
            '-format_whitelist',
            'mov',
            '-i',
            'pipe:0',
            '-map',
            '0:v:0',
            '-an',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-c:v',
            'copy',
            '-bsf:v',
            'filter_units=remove_types=6',
            '-fflags',
            '+bitexact',
            '-movflags',
            '+frag_keyframe+empty_moov',
            '-f',
            'mp4',
            'pipe:1',
        ],
        owned,
        MAX_CLIP_BYTES,
        deadline,
    )
    deadline.checkpoint()
    const final = await probe(bytes, deadline, true)
    deadline.checkpoint()
    if (
        source.width !== final.width ||
        source.height !== final.height ||
        source.frameCount !== final.frameCount ||
        Math.abs(source.durationSeconds - final.durationSeconds) > 0.001 ||
        source.frameOffsets.some((offset, index) => Math.abs(offset - (final.frameOffsets[index] ?? Infinity)) > 0.001)
    ) {
        throw new ClipError('unavailable')
    }
    return {
        bytes,
        mimeType: 'video/mp4',
        width: final.width,
        height: final.height,
        frameCount: final.frameCount,
        durationSeconds: final.durationSeconds,
    }
}
