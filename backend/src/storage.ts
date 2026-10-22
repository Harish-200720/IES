import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { MultipartFile } from '@fastify/multipart'

import type { Config } from './config.js'
import { ApiError } from './shared/errors.js'
import { id } from './shared/ids.js'

const EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff'])
const CONTENT_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
])

export interface StoredUpload {
  originalFilename: string
  storedFilename: string
  path: string
  sha256: string
  contentType: string
  sizeBytes: number
}

function safeFilename(value: string): string {
  const cleaned = basename(value || 'invoice').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || 'invoice').slice(0, 255)
}

function validMagic(prefix: Buffer, extension: string): boolean {
  if (extension === '.pdf') return prefix.subarray(0, 4).toString('ascii') === '%PDF'
  if (extension === '.png') return prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (extension === '.jpg' || extension === '.jpeg') return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff
  if (extension === '.tif' || extension === '.tiff') {
    return prefix.length >= 4 && ((prefix[0] === 0x49 && prefix[1] === 0x49) || (prefix[0] === 0x4d && prefix[1] === 0x4d))
  }
  return false
}

export function storagePath(config: Config, storedFilename: string): string {
  const root = resolve(config.IES_STORAGE_ROOT)
  const candidate = resolve(root, storedFilename)
  if (!candidate.startsWith(`${root}${sep}`)) throw new ApiError(400, 'Unsafe storage path', 'UNSAFE_PATH')
  return candidate
}

export function invoiceContentType(filename: string): string {
  return CONTENT_TYPES.get(extname(filename).toLowerCase()) ?? 'application/octet-stream'
}

export async function removeStored(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function storeUpload(part: MultipartFile, config: Config): Promise<StoredUpload> {
  const originalFilename = safeFilename(part.filename)
  const extension = extname(originalFilename).toLowerCase()
  if (!EXTENSIONS.has(extension)) throw new ApiError(415, 'Unsupported invoice file type', 'UNSUPPORTED_FILE_TYPE')

  const root = resolve(config.IES_STORAGE_ROOT)
  await mkdir(root, { recursive: true })
  const storedFilename = `${id()}${extension}`
  const destination = storagePath(config, storedFilename)
  const temporary = storagePath(config, `${storedFilename}.part`)
  const digest = createHash('sha256')
  const prefixChunks: Buffer[] = []
  let prefixBytes = 0
  let sizeBytes = 0

  const secured = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length
      if (sizeBytes > config.IES_MAX_FILE_BYTES) {
        callback(new ApiError(413, 'Invoice exceeds configured size limit', 'FILE_TOO_LARGE'))
        return
      }
      digest.update(chunk)
      if (prefixBytes < 8) {
        const slice = chunk.subarray(0, 8 - prefixBytes)
        prefixChunks.push(slice)
        prefixBytes += slice.length
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(part.file, secured, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    if (part.file.truncated) throw new ApiError(413, 'Invoice exceeds configured size limit', 'FILE_TOO_LARGE')
    if (!sizeBytes) throw new ApiError(400, 'Invoice file is empty', 'EMPTY_FILE')
    if (!validMagic(Buffer.concat(prefixChunks), extension)) {
      throw new ApiError(415, 'File signature does not match its extension', 'INVALID_FILE_SIGNATURE')
    }
    await rename(temporary, destination)
  } catch (error) {
    await removeStored(temporary)
    throw error
  }

  return {
    originalFilename,
    storedFilename,
    path: destination,
    sha256: digest.digest('hex'),
    contentType: invoiceContentType(originalFilename),
    sizeBytes,
  }
}
