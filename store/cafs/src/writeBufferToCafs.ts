import { existsSync, promises as fs, type Stats } from 'fs'
import path from 'path'
import renameOverwrite from 'rename-overwrite'
import type ssri from 'ssri'
import { verifyFileIntegrity } from './checkPkgFilesIntegrity'
import { writeFile } from './writeFile'

export async function writeBufferToCafs (
  locker: Map<string, Promise<number>>,
  cafsDir: string,
  buffer: Buffer,
  fileDest: string,
  mode: number | undefined,
  integrity: ssri.IntegrityLike
): Promise<number> {
  fileDest = path.join(cafsDir, fileDest)
  if (locker.has(fileDest)) {
    return locker.get(fileDest)!
  }
  const p = (async () => {
    // This part is a bit redundant.
    // When a file is already used by another package,
    // we probably have validated its content already.
    // However, there is no way to find which package index file references
    // the given file. So we should revalidate the content of the file again.
    if (await existsSame(fileDest, integrity)) {
      return Date.now()
    }

    // This might be too cautious.
    // The write is atomic, so in case pnpm crashes, no broken file
    // will be added to the store.
    // It might be a redundant step though, as we verify the contents of the
    // files before linking
    //
    // If we don't allow --no-verify-store-integrity then we probably can write
    // to the final file directly.
    const temp = pathTemp(fileDest)
    await writeFile(temp, buffer, mode)
    // Unfortunately, "birth time" (time of file creation) is available not on all filesystems.
    // We log the creation time ourselves and save it in the package index file.
    // Having this information allows us to skip content checks for files that were not modified since "birth time".
    const birthtimeMs = Date.now()
    await optimisticRenameOverwrite(temp, fileDest)
    return birthtimeMs
  })()
  locker.set(fileDest, p)
  return p
}

export async function optimisticRenameOverwrite (temp: string, fileDest: string) {
  try {
    await renameOverwrite(temp, fileDest)
  } catch (err: any) { // eslint-disable-line
    if (err.code !== 'ENOENT' || !existsSync(fileDest)) throw err
    // The temporary file path is created by appending the process ID to the target file name.
    // This is done to avoid lots of random crypto number generations.
    //   PR with related performance optimization: https://github.com/pnpm/pnpm/pull/6817
    //
    // Probably the only scenario in which the temp directory will dissappear
    // before being renamed is when two containers use the same mounted directory
    // for their content-addressable store. In this case there's a chance that the process ID
    // will be the same in both containers.
    //
    // As a workaround, if the temp file doesn't exist but the target file does,
    // we just ignore the issue and assume that the target file is correct.
  }
}

/**
 * The process ID is appended to the file name to create a temporary file.
 * If the process fails, on rerun the new temp file may get a filename the got left over.
 * That is fine, the file will be overriden.
 */
export function pathTemp (file: string): string {
  const basename = removeSuffix(path.basename(file))
  return path.join(path.dirname(file), `${basename}${process.pid}`)
}

function removeSuffix (filePath: string): string {
  const dashPosition = filePath.indexOf('-')
  if (dashPosition === -1) return filePath
  const withoutSuffix = filePath.substring(0, dashPosition)
  if (filePath.substring(dashPosition) === '-exec') {
    return `${withoutSuffix}x`
  }
  return withoutSuffix
}

async function existsSame (filename: string, integrity: ssri.IntegrityLike) {
  let existingFile: Stats | undefined
  try {
    existingFile = await fs.stat(filename)
  } catch (err) {
    return false
  }
  return verifyFileIntegrity(filename, {
    size: existingFile.size,
    integrity,
  })
}
