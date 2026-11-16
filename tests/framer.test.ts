import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  buildEncodeVideoArgs,
  buildExtractFramesArgs,
} from '../src/lib/ffmpegArgs'
import {
  clampFps,
  computeEvenDimension,
  computeScaledDimensions,
  formatBytes,
  formatDuration,
  formatErrorMessage,
  isSupportedImageFile,
  naturalCompare,
  parseFpsFromFfmpegLog,
  parseFpsFromFilename,
  sanitizeBaseName,
} from '../src/lib/format'
import {
  inspectFramesDimensions,
  parseImageDimensionsFromBytes,
} from '../src/lib/imageNormalize'
import { createFramesZip, extractFramesFromZip } from '../src/lib/zipFrames'

function makePngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes[16] = (width >>> 24) & 0xff
  bytes[17] = (width >>> 16) & 0xff
  bytes[18] = (width >>> 8) & 0xff
  bytes[19] = width & 0xff
  bytes[20] = (height >>> 24) & 0xff
  bytes[21] = (height >>> 16) & 0xff
  bytes[22] = (height >>> 8) & 0xff
  bytes[23] = height & 0xff
  return bytes
}

function makeJpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ])
}

describe('format utilities', () => {
  it('sorts filenames naturally across numbers', () => {
    const input = ['frame_10.png', 'frame_2.png', 'frame_1.png', 'frame_100.png']
    expect([...input].sort(naturalCompare)).toEqual([
      'frame_1.png',
      'frame_2.png',
      'frame_10.png',
      'frame_100.png',
    ])
  })

  it('filters supported image files and skips metadata entries', () => {
    expect(isSupportedImageFile('frames/frame_001.png')).toBe(true)
    expect(isSupportedImageFile('frame_002.JPEG')).toBe(true)
    expect(isSupportedImageFile('__MACOSX/._frame_001.png')).toBe(false)
    expect(isSupportedImageFile('.DS_Store')).toBe(false)
    expect(isSupportedImageFile('frames/')).toBe(false)
    expect(isSupportedImageFile('notes.txt')).toBe(false)
  })

  it('parses FPS hints from filenames and ffmpeg logs', () => {
    expect(parseFpsFromFilename('clip_frames_24fps.zip')).toBe(24)
    expect(parseFpsFromFilename('sample-29.97fps.zip')).toBe(29.97)
    expect(parseFpsFromFilename('frames_only.zip')).toBeNull()

    const ffmpegLog =
      'Stream #0:0(und): Video: h264, yuv420p, 1280x720, 1200 kb/s, 30 fps, 30 tbr'
    expect(parseFpsFromFfmpegLog(ffmpegLog)).toBe(30)
  })

  it('formats sizes, durations, base names, and even dimensions', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatDuration(12.5)).toBe('00:12.5')
    expect(sanitizeBaseName('my clip (final).mp4')).toBe('my_clip_final')
    expect(computeEvenDimension(853)).toBe(854)
    expect(computeEvenDimension(1920)).toBe(1920)
    expect(computeScaledDimensions(1920, 1080, '720p')).toEqual({
      width: 1280,
      height: 720,
    })
    expect(computeScaledDimensions(320, 240, '720p')).toEqual({
      width: 960,
      height: 720,
    })
    expect(computeScaledDimensions(1080, 1920, '720p')).toEqual({
      width: 720,
      height: 1280,
    })
    expect(clampFps(0)).toBe(24)
    expect(clampFps(300)).toBe(120)
    expect(formatErrorMessage('RuntimeError: memory access out of bounds', 'fallback')).toBe(
      'RuntimeError: memory access out of bounds',
    )
    expect(formatErrorMessage(new Error('Boom'), 'fallback')).toBe('Boom')
    expect(formatErrorMessage('', 'fallback')).toBe('fallback')
  })
})

describe('zipFrames', () => {
  it('packages frames into a zip and unpacks them in natural order', async () => {
    const rawZip = await createFramesZip([
      { name: 'frame_10.png', data: makePngHeader(640, 360) },
      { name: 'frame_2.png', data: makePngHeader(640, 360) },
      { name: 'frame_1.png', data: makePngHeader(640, 360) },
    ])

    const unpacked = await extractFramesFromZip(rawZip)
    expect(unpacked.map((f) => f.name)).toEqual([
      'frame_1.png',
      'frame_2.png',
      'frame_10.png',
    ])
  })

  it('ignores __MACOSX, dotfiles, and non-image entries when unpacking', async () => {
    const zipBytes = zipSync({
      '__MACOSX/._frame_1.png': new Uint8Array([1, 2, 3]),
      'frames/.DS_Store': new Uint8Array([1, 2, 3]),
      'frames/readme.txt': new Uint8Array([65, 66]),
      'frames/shot_2.jpg': makeJpegHeader(800, 600),
      'frames/shot_1.jpg': makeJpegHeader(800, 600),
    })

    const unpacked = await extractFramesFromZip(zipBytes)
    expect(unpacked.map((f) => f.name)).toEqual(['shot_1.jpg', 'shot_2.jpg'])
  })

  it('throws a clear error when zip has no valid images', async () => {
    const emptyZip = zipSync({
      'notes.txt': new Uint8Array([72, 105]),
    })
    await expect(extractFramesFromZip(emptyZip)).rejects.toThrow(
      /No supported image frames/,
    )
  })
})

describe('image dimension inspection', () => {
  it('reads PNG and JPEG dimensions from binary headers', () => {
    expect(parseImageDimensionsFromBytes(makePngHeader(1280, 720))).toEqual({
      width: 1280,
      height: 720,
    })
    expect(parseImageDimensionsFromBytes(makeJpegHeader(640, 480))).toEqual({
      width: 640,
      height: 480,
    })

    // JPEG with an APP0 segment preceding SOF0 (like FFmpeg/JFIF outputs)
    const jfifWithApp0 = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      ...makeJpegHeader(1280, 720).slice(2),
    ])
    expect(parseImageDimensionsFromBytes(jfifWithApp0)).toEqual({
      width: 1280,
      height: 720,
    })
  })

  it('detects mixed sizes and odd dimensions across frames', async () => {
    const summary = await inspectFramesDimensions([
      {
        id: '1',
        name: 'f1.png',
        data: makePngHeader(853, 480),
        size: 24,
      },
      {
        id: '2',
        name: 'f2.png',
        data: makePngHeader(854, 480),
        size: 24,
      },
    ])

    expect(summary.width).toBe(853)
    expect(summary.height).toBe(480)
    expect(summary.hasMixedSizes).toBe(true)
    expect(summary.hasOddDimensions).toBe(true)
    expect(summary.formatsFound).toEqual(['PNG'])
  })
})

describe('ffmpegArgs', () => {
  it('builds extraction args for original and custom fps', () => {
    expect(
      buildExtractFramesArgs({
        inputPath: '/job/input.mp4',
        outputPattern: '/job/out/frame_%05d.png',
        fpsMode: 'original',
        customFps: 24,
        format: 'png',
        jpegQuality: 'high',
      }),
    ).toEqual([
      '-i',
      '/job/input.mp4',
      '-fps_mode',
      'passthrough',
      '/job/out/frame_%05d.png',
    ])

    expect(
      buildExtractFramesArgs({
        inputPath: '/job/input.mp4',
        outputPattern: '/job/out/frame_%05d.jpg',
        fpsMode: 'custom',
        customFps: 12,
        format: 'jpg',
        jpegQuality: 'balanced',
      }),
    ).toEqual([
      '-i',
      '/job/input.mp4',
      '-vf',
      'fps=12',
      '-huffman',
      'default',
      '-strict',
      'unofficial',
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      '5',
      '/job/out/frame_%05d.jpg',
    ])
  })

  it('builds mp4 and webm encode args with yuv420p and even dimension pad', () => {
    const mp4Args = buildEncodeVideoArgs({
      inputPattern: '/job/in/frame_%05d.png',
      outputPath: '/job/output.mp4',
      fps: 24,
      format: 'mp4',
      quality: 'high',
    })
    expect(mp4Args).toContain('libx264')
    expect(mp4Args).toContain('yuv420p')
    expect(mp4Args).toContain('+faststart')

    const webmArgs = buildEncodeVideoArgs({
      inputPattern: '/job/in/frame_%05d.png',
      outputPath: '/job/output.webm',
      fps: 30,
      format: 'webm',
      quality: 'compact',
    })
    expect(webmArgs).toContain('libvpx')
    expect(webmArgs).toContain('realtime')

    const hd720Args = buildEncodeVideoArgs({
      inputPattern: '/job/in/frame_%05d.png',
      outputPath: '/job/output.mp4',
      fps: 24,
      format: 'mp4',
      quality: 'high',
      resolution: '720p',
      targetWidth: 1280,
      targetHeight: 720,
    })
    expect(hd720Args).toContain('scale=1280:720:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2')
    expect(hd720Args).toContain('16')

    const extract720Args = buildExtractFramesArgs({
      inputPath: '/job/input.mp4',
      outputPattern: '/job/out/frame_%05d.png',
      fpsMode: 'custom',
      customFps: 24,
      format: 'png',
      jpegQuality: 'high',
      resolution: '720p',
    })
    expect(extract720Args.join(' ')).toContain('fps=24,scale=')
    expect(extract720Args.join(' ')).toContain('flags=lanczos')

    const mp4WithAudio = buildEncodeVideoArgs({
      inputPattern: '/job/in/frame_%05d.png',
      outputPath: '/job/output.mp4',
      fps: 24,
      format: 'mp4',
      quality: 'high',
      audioInputPath: '/job/audio.wav',
    })
    expect(mp4WithAudio).toContain('/job/audio.wav')
    expect(mp4WithAudio).toContain('aac')
    expect(mp4WithAudio).toContain('-shortest')

    const webmWithAudio = buildEncodeVideoArgs({
      inputPattern: '/job/in/frame_%05d.png',
      outputPath: '/job/output.webm',
      fps: 24,
      format: 'webm',
      quality: 'balanced',
      audioInputPath: '/job/audio.mp3',
    })
    expect(webmWithAudio).toContain('libopus')
    expect(webmWithAudio).toContain('-shortest')
  })
})
