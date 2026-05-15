import type { FileSystemPort } from "../ports";

/**
 * Bun-backed filesystem adapter.
 * Satisfies FileSystemPort using Bun.file() and Bun.write().
 * Hosts attach this to make file-reading resolvers available.
 */
export class BunFileSystemAdapter implements FileSystemPort {
  async read(path: string): Promise<string> {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      throw new Error(`File not found: ${path}`);
    }
    return file.text();
  }

  async write(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  }
}
