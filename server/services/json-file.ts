// JSON files under the data folder: read one that may not be there yet, write one so a reader never sees half of it.
import * as path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/** The file's JSON, null when there is no such file (any other error, a parse error too, is thrown). */
export async function readJsonOrNull<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    }
}

/** Write `text` to `file` (its folder made first) through a temporary file next to it and a rename. */
export async function writeAtomic(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
}
