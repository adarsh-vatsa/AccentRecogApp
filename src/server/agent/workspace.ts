import fs from "node:fs/promises";
import path from "node:path";
import { LIMITS, isValidHousePath } from "../validate.ts";

export class ToolError extends Error {}

/**
 * The agent's view of a house: a run's worktree, confined by path validation, a
 * realpath check, and size limits. There is no shell and no network here.
 */
export class Workspace {
  constructor(private readonly root: string) {}

  private resolve(p: string): string {
    if (!isValidHousePath(p)) {
      throw new ToolError(
        `Invalid path "${p}". Use relative paths like "app.js" or "games/chess.js": letters, digits, ".", "-", "_", each segment starting with a letter or digit.`,
      );
    }
    const full = path.resolve(this.root, p);
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ToolError("Path escapes the house");
    return full;
  }

  /** Reject any symlink on the way to target (none should exist; defence in depth). */
  private async assertNoSymlinks(full: string): Promise<void> {
    const rel = path.relative(this.root, full).split(path.sep);
    let cur = this.root;
    for (const seg of rel) {
      cur = path.join(cur, seg);
      try {
        const st = await fs.lstat(cur);
        if (st.isSymbolicLink()) throw new ToolError("Symlinks aren't allowed in houses");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    }
  }

  async list(): Promise<Array<{ path: string; size: number }>> {
    const out: Array<{ path: string; size: number }> = [];
    const walk = async (dir: string, prefix: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (prefix === "" && entry.name === ".git") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, rel);
        else if (entry.isFile()) out.push({ path: rel, size: (await fs.stat(full)).size });
      }
    };
    await walk(this.root, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(p: string): Promise<string> {
    const full = this.resolve(p);
    await this.assertNoSymlinks(full);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      throw new ToolError(`No such file: ${p}`);
    }
    if (!st.isFile()) throw new ToolError(`${p} is not a file`);
    if (st.size > LIMITS.houseFileBytes) throw new ToolError(`${p} is too large to read (${st.size} bytes)`);
    return fs.readFile(full, "utf8");
  }

  async write(p: string, content: string): Promise<{ bytes: number; created: boolean }> {
    const full = this.resolve(p);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > LIMITS.houseFileBytes) throw new ToolError(`Files are limited to ${LIMITS.houseFileBytes} bytes; split it up`);
    await this.assertNoSymlinks(full);
    const files = await this.list();
    const existing = files.find((f) => f.path === p);
    const total = files.reduce((n, f) => n + f.size, 0) - (existing?.size ?? 0) + bytes;
    if (!existing && files.length >= LIMITS.houseFilesMax) throw new ToolError(`Houses are limited to ${LIMITS.houseFilesMax} files`);
    if (total > LIMITS.houseTotalBytes) throw new ToolError(`Houses are limited to ${LIMITS.houseTotalBytes} bytes in total`);
    if (files.some((f) => f.path.startsWith(`${p}/`))) throw new ToolError(`${p} is a directory`);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return { bytes, created: !existing };
  }

  async edit(p: string, oldText: string, newText: string): Promise<{ bytes: number }> {
    const current = await this.read(p);
    if (oldText.length === 0) throw new ToolError("old_text must not be empty");
    const first = current.indexOf(oldText);
    if (first < 0) throw new ToolError(`old_text was not found in ${p}. Read the file again and copy the exact text.`);
    if (current.indexOf(oldText, first + 1) >= 0) throw new ToolError(`old_text appears more than once in ${p}; include more surrounding text`);
    const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
    const { bytes } = await this.write(p, next);
    return { bytes };
  }

  async remove(p: string): Promise<void> {
    const full = this.resolve(p);
    await this.assertNoSymlinks(full);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) throw new ToolError(`${p} is not a file`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`No such file: ${p}`);
    }
    await fs.rm(full);
  }
}
