// okf-bundle.ts — the OKF working-document store as a portable zip (#1823).
//
// Bundle layout: one OKF file per document at its store path (`/projects/x/brief.md` →
// `projects/x/brief.md`), serialized with emitOkfDocument, plus `manifest.json` (written
// last) recording each document's version and updated_at so an import can tell whether
// the store has moved on since the export. Archived rows can share a path with each other
// and with a live row, so they live under `.archived/<row id>/<path>` instead.
//
// Reading treats the archive as hostile: names are checked before anything is inflated,
// entry count is capped before extraction, and every entry is inflated with an output cap
// so a zip bomb stops at the limit instead of after it.

import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { WorkingDocRow, WorkingDocSummary } from '../db/working-docs-repo.js';
import { normalizeDocPath, parseOkfDocument } from './okf.js';

const require = createRequire(import.meta.url);

export const BUNDLE_MANIFEST_NAME = 'manifest.json';
export const BUNDLE_ARCHIVED_DIR = '.archived';
export const BUNDLE_FORMAT = 'curia-okf-bundle';
export const BUNDLE_FORMAT_VERSION = 1;

export interface OkfBundleManifestEntry {
  /** Name of the zip entry holding this document. */
  entry: string;
  /** working_documents row id — versions restart at 1 per row, so identity needs this. */
  id: string;
  path: string;
  version: number;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OkfBundleManifest {
  format: typeof BUNDLE_FORMAT;
  formatVersion: typeof BUNDLE_FORMAT_VERSION;
  exportedAt: string;
  /** Path prefix exported (`/` for the whole workspace). */
  scope: string;
  includeArchived: boolean;
  documentCount: number;
  documents: OkfBundleManifestEntry[];
}

/** Zip entry name for a document row. */
export function bundleEntryName(doc: Pick<WorkingDocSummary, 'id' | 'path' | 'archivedAt'>): string {
  const relative = doc.path.replace(/^\/+/, '');
  return doc.archivedAt === null ? relative : `${BUNDLE_ARCHIVED_DIR}/${doc.id}/${relative}`;
}

// ── Writing ───────────────────────────────────────────────────────────────────

interface YazlZipFile {
  outputStream: Readable;
  addReadStreamLazy(
    metadataPath: string,
    options: { mtime?: Date; mode?: number; compress?: boolean },
    getReadStream: (cb: (err: Error | null, stream?: Readable) => void) => void,
  ): void;
  end(): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

interface YazlModule {
  ZipFile: new () => YazlZipFile;
}

const yazl = require('yazl') as YazlModule;

export interface WriteOkfBundleParams {
  /** The rows to export, as listed (no bodies). */
  documents: WorkingDocSummary[];
  /** Load one row's full content when the writer reaches it. */
  loadDocument: (id: string) => Promise<WorkingDocRow | null>;
  /** Serialize a row — WorkingDocsRepo.toOkf, so bundle entries match single-document downloads. */
  toOkf: (doc: WorkingDocRow) => string;
  scope: string;
  includeArchived: boolean;
  now?: Date;
}

/**
 * Stream a bundle. Each document is read from the store only when the zip writer reaches
 * its entry, so peak memory is one document plus compression buffers, not the archive.
 * The manifest records the version actually written, read in the same step as the body.
 */
export function writeOkfBundle(params: WriteOkfBundleParams): Readable {
  const zip = new yazl.ZipFile();
  const manifestEntries: OkfBundleManifestEntry[] = [];
  const exportedAt = (params.now ?? new Date()).toISOString();

  for (const summary of params.documents) {
    const entry = bundleEntryName(summary);
    zip.addReadStreamLazy(
      entry,
      { mtime: new Date(summary.updatedAt), mode: 0o100644, compress: true },
      (cb) => {
        params.loadDocument(summary.id).then(
          (doc) => {
            if (!doc) {
              cb(new Error(`document ${summary.path} (${summary.id}) disappeared during export`));
              return;
            }
            manifestEntries.push({
              entry,
              id: doc.id,
              path: doc.path,
              version: doc.version,
              updatedAt: doc.updatedAt,
              archivedAt: doc.archivedAt,
            });
            cb(null, Readable.from([Buffer.from(params.toOkf(doc), 'utf8')]));
          },
          (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
        );
      },
    );
  }

  // Lazy, so it is built only after every document entry above has been written.
  zip.addReadStreamLazy(BUNDLE_MANIFEST_NAME, { mtime: new Date(exportedAt), mode: 0o100644 }, (cb) => {
    const manifest: OkfBundleManifest = {
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      exportedAt,
      scope: params.scope,
      includeArchived: params.includeArchived,
      documentCount: manifestEntries.length,
      documents: manifestEntries,
    };
    cb(null, Readable.from([Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')]));
  });
  zip.end();

  // yazl emits errors on the ZipFile, not the output stream; surface them where the
  // consumer is listening so a failed read aborts the download instead of truncating it.
  zip.on('error', (err) => zip.outputStream.destroy(err));
  return zip.outputStream;
}

// ── Reading ───────────────────────────────────────────────────────────────────

export interface OkfBundleLimits {
  /** Most entries (files and directories) the archive may hold. */
  maxEntries: number;
  /** Largest single inflated entry. */
  maxEntryBytes: number;
  /** Total inflated bytes across all entries. */
  maxTotalBytes: number;
}

export const DEFAULT_BUNDLE_LIMITS: OkfBundleLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/** The whole bundle is unusable — nothing is imported. */
export class OkfBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfBundleError';
  }
}

export interface OkfBundleDocumentEntry {
  /** Zip entry name. */
  name: string;
  /** Store path it maps to. */
  path: string;
  /** Raw OKF text. */
  content: string;
  type: string;
  /** Frontmatter without `type` (the store keeps type in its own column). */
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface OkfBundleSkippedEntry {
  name: string;
  reason: string;
}

export interface OkfBundleContents {
  manifest: OkfBundleManifest | null;
  documents: OkfBundleDocumentEntry[];
  /** Entries left out, each with the reason. Never silently dropped. */
  skipped: OkfBundleSkippedEntry[];
}

interface YauzlExtraField { id: number; data: Buffer }

interface YauzlEntry {
  fileNameRaw: Buffer;
  extraFields: YauzlExtraField[];
  generalPurposeBitFlag: number;
  compressionMethod: number;
  versionMadeBy: number;
  externalFileAttributes: number;
  isEncrypted(): boolean;
}

interface YauzlZipFile {
  entryCount: number;
  eachEntry(): AsyncIterable<YauzlEntry>;
  openReadStreamPromise(entry: YauzlEntry, options: { decodeFileData: false }): Promise<Readable>;
  close(): void;
}

interface YauzlModule {
  fromBufferPromise(buffer: Buffer, options: { decodeStrings: false; validateEntrySizes: false }): Promise<YauzlZipFile>;
  getFileNameLowLevel(flag: number, raw: Buffer, extra: YauzlExtraField[], strictFileNames: false): string;
}

const yauzl = require('yauzl') as YauzlModule;

/**
 * Why an entry name cannot be a store path, or null when it is safe. Checked on the raw
 * name, before anything is inflated: absolute paths, drive letters, backslashes, control
 * characters and any `.`/`..`/empty segment are refused outright rather than normalized,
 * so nothing in the archive can resolve outside the workspace.
 */
export function unsafeEntryNameReason(name: string): string | null {
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return 'absolute path';
  if (name.includes('\\')) return 'backslash in path';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character in path';
  const segments = name.split('/');
  if (segments.some(s => s === '..')) return 'path traversal (..)';
  if (segments.some(s => s === '' || s === '.')) return 'empty or "." path segment';
  const path = `/${name}`;
  if (normalizeDocPath(path) !== path) return 'path does not normalize to itself';
  return null;
}

function entryKind(entry: YauzlEntry, rawName: string): 'file' | 'directory' | 'symlink' | 'special' {
  if (rawName.endsWith('/')) return 'directory';
  const host = entry.versionMadeBy >>> 8;
  // 3 = Unix, 19 = OS X (APPNOTE 4.4.2.2): Unix mode bits sit in the high word.
  if (host === 3 || host === 19) {
    const type = ((entry.externalFileAttributes >>> 16) & 0xffff) & 0o170000;
    if (type === 0o040000) return 'directory';
    if (type === 0o120000) return 'symlink';
    if (type !== 0 && type !== 0o100000) return 'special';
  }
  if ((entry.externalFileAttributes & 0x10) !== 0) return 'directory';
  return 'file';
}

async function readStream(stream: Readable, cap: number, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > cap) {
      stream.destroy();
      throw new OkfBundleError(`${what} exceeds the upload limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Inflate one entry, stopping at `cap` output bytes. */
function inflateCapped(entry: YauzlEntry, raw: Buffer, cap: number, name: string): Buffer {
  if (entry.compressionMethod === 0) {
    if (raw.length > cap) throw new OkfBundleError(`"${name}" exceeds the uncompressed size limit`);
    return raw;
  }
  if (entry.compressionMethod !== 8) throw new OkfBundleError(`"${name}" uses an unsupported compression method`);
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, cap) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new OkfBundleError(`"${name}" exceeds the uncompressed size limit`);
    }
    throw new OkfBundleError(`"${name}" is corrupt or not a deflate stream`);
  }
}

function parseManifest(raw: Buffer): OkfBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new OkfBundleError('manifest.json is not valid JSON');
  }
  const m = parsed as Partial<OkfBundleManifest> | null;
  if (!m || m.format !== BUNDLE_FORMAT || !Array.isArray(m.documents)) {
    throw new OkfBundleError(`manifest.json is not a ${BUNDLE_FORMAT} manifest`);
  }
  for (const d of m.documents) {
    const e = d as Partial<OkfBundleManifestEntry> | null;
    if (!e || typeof e.entry !== 'string' || typeof e.id !== 'string' || typeof e.path !== 'string' || !Number.isInteger(e.version)) {
      throw new OkfBundleError('manifest.json has a malformed document entry');
    }
  }
  // Shape checked field by field above.
  return m as unknown as OkfBundleManifest;
}

/** Parse one OKF file into store parts, or the reason it is not one. */
export function parseBundleDocument(content: string): Omit<OkfBundleDocumentEntry, 'name' | 'path' | 'content'> | { error: string } {
  try {
    const parsed = parseOkfDocument(content);
    const { type: _type, ...frontmatter } = parsed.frontmatter;
    void _type;
    return { type: parsed.type, frontmatter, body: parsed.body };
  } catch (err) {
    return { error: `invalid OKF: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Read a bundle. Throws OkfBundleError when the archive as a whole is unusable (not a zip,
 * too many entries, over the uncompressed budget, encrypted, bad manifest); otherwise
 * returns the valid documents plus every skipped entry with its reason.
 */
export async function readOkfBundle(archive: Buffer, limits: OkfBundleLimits = DEFAULT_BUNDLE_LIMITS): Promise<OkfBundleContents> {
  let zipfile: YauzlZipFile;
  try {
    // decodeStrings off: yauzl would reject `../` and absolute names itself; we want to
    // report them per entry. validateEntrySizes off: header sizes are not trusted — the
    // inflate cap is the limit.
    zipfile = await yauzl.fromBufferPromise(archive, { decodeStrings: false, validateEntrySizes: false });
  } catch (err) {
    throw new OkfBundleError(`not a valid zip file: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    if (zipfile.entryCount > limits.maxEntries) {
      throw new OkfBundleError(`bundle has ${zipfile.entryCount} entries — the limit is ${limits.maxEntries}`);
    }

    const skipped: OkfBundleSkippedEntry[] = [];
    const accepted: Array<{ entry: YauzlEntry; name: string; manifest: boolean }> = [];
    const seen = new Set<string>();
    for await (const entry of zipfile.eachEntry()) {
      const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
      if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x40) !== 0) {
        throw new OkfBundleError(`entry "${name}" is encrypted`);
      }
      const kind = entryKind(entry, name);
      if (kind === 'directory') continue; // directories are path prefixes, not documents
      if (kind !== 'file') {
        skipped.push({ name, reason: kind === 'symlink' ? 'symbolic link' : 'not a regular file' });
        continue;
      }
      if (name === BUNDLE_MANIFEST_NAME) {
        accepted.push({ entry, name, manifest: true });
        continue;
      }
      const unsafe = unsafeEntryNameReason(name);
      if (unsafe) {
        skipped.push({ name, reason: unsafe });
        continue;
      }
      if (!name.endsWith('.md')) {
        skipped.push({ name, reason: 'not a .md document' });
        continue;
      }
      if (name.startsWith(`${BUNDLE_ARCHIVED_DIR}/`)) {
        skipped.push({ name, reason: 'archived in the bundle — import brings in live documents only' });
        continue;
      }
      if (name === 'index.md' || name.endsWith('/index.md')) {
        skipped.push({ name, reason: 'index.md is a generated projection, not a stored document' });
        continue;
      }
      if (seen.has(name)) {
        skipped.push({ name, reason: 'duplicate entry' });
        continue;
      }
      seen.add(name);
      accepted.push({ entry, name, manifest: false });
    }

    let manifest: OkfBundleManifest | null = null;
    const documents: OkfBundleDocumentEntry[] = [];
    let remaining = limits.maxTotalBytes;
    for (const { entry, name, manifest: isManifest } of accepted) {
      const stream = await zipfile.openReadStreamPromise(entry, { decodeFileData: false });
      // Compressed data is never meaningfully larger than its inflated output, so the same
      // budget (plus slack for deflate's per-block overhead) bounds the raw read too.
      const raw = await readStream(stream, remaining + 64 * 1024, `"${name}"`);
      const cap = Math.min(limits.maxEntryBytes, remaining);
      if (cap <= 0) throw new OkfBundleError(`bundle exceeds ${limits.maxTotalBytes} bytes uncompressed`);
      const data = inflateCapped(entry, raw, cap, name);
      remaining -= data.length;

      if (isManifest) {
        manifest = parseManifest(data);
        continue;
      }
      let content: string;
      try {
        content = UTF8.decode(data);
      } catch {
        skipped.push({ name, reason: 'not valid UTF-8 text' });
        continue;
      }
      const parsed = parseBundleDocument(content);
      if ('error' in parsed) {
        skipped.push({ name, reason: parsed.error });
        continue;
      }
      documents.push({ name, path: `/${name}`, content, ...parsed });
    }
    return { manifest, documents, skipped };
  } finally {
    zipfile.close();
  }
}

/**
 * Base a single-document download carries in its name: `brief.v12.3f2a9c1d.md` →
 * version 12 of the row whose id starts 3f2a9c1d. The id fragment is optional so a
 * hand-named `brief.v12.md` still works, with a weaker identity check.
 */
export function baseFromDownloadName(filename: string): { version: number; idPrefix?: string } | null {
  const match = /\.v(\d{1,9})(?:\.([0-9a-f]{8}))?\.md$/i.exec(filename.trim());
  if (!match) return null;
  const version = Number.parseInt(match[1]!, 10);
  return match[2] ? { version, idPrefix: match[2].toLowerCase() } : { version };
}
