// Stream a file one line at a time, holding only the current line in memory.
//
// The Claude metadata scan used to readFile() each transcript whole and split
// it; across a few hundred transcripts (the largest tens of MB) read
// concurrently, that held gigabytes resident for a one-shot `agendo status`.
// This yields exactly the lines `text.split("\n")` would, numbered the same, so
// a caller switching over keeps its semantics.
import { open, type FileHandle } from "fs/promises";

/** Bytes read per syscall. Lines longer than this are stitched across reads. */
const CHUNK_BYTES = 256 * 1024;

// Streaming bounds what is LIVE to one line, but every line still becomes a
// string and a parsed record, and the engine collects that garbage lazily:
// indexing ~1.5 GB of transcripts peaked near 300 MB on garbage alone. A full
// collection every so many bytes read keeps the peak near the live set, for
// about a tenth of a second across that whole corpus (a few ms a collection).
// Counted process-wide, so concurrent readers share one budget rather than each
// collecting on its own. In the TUI the rescan re-reads only transcripts that
// changed, so a tick collects only when it re-streamed 32 MB of them — and then
// the collection is small beside the parse that made the garbage.
const COLLECT_EVERY_BYTES = 32 * 1024 * 1024;
let bytesSinceCollect = 0;

function noteBytesRead(n: number): void {
  bytesSinceCollect += n;
  if (bytesSinceCollect < COLLECT_EVERY_BYTES) return;
  bytesSinceCollect = 0;
  // Bun-only; a Node importer of src/ (the Playwright side) just skips it.
  if (typeof Bun !== "undefined") Bun.gc(true);
}

/**
 * Called per line, 1-based. `isLast` marks a final line with no terminating
 * newline — the one place `split("\n")` puts a live writer's half-written
 * record. A file ending in "\n" has no such line (split's trailing "" is never
 * delivered: it would be blank, which every caller skips anyway).
 *
 * Return `true` to stop reading: nothing later in the file is wanted.
 */
export type LineSink = (text: string, lineNo: number, isLast: boolean) => boolean | void;

export interface LineOptions {
  /**
   * Read no further than this many bytes from the start. The lines delivered
   * are then exactly `head.split("\n")` of those bytes decoded whole — the cut
   * tail included, as the `isLast` line.
   */
  maxBytes?: number;
  chunkBytes?: number;
}

/** A line's bytes, decoded. `pending` holds the earlier pieces of a line that spans reads. */
function decodeLine(pending: Buffer[], piece: Buffer): string {
  if (!pending.length) return piece.toString("utf-8");
  pending.push(piece);
  const text = Buffer.concat(pending).toString("utf-8");
  pending.length = 0;
  return text;
}

/** Deliver every complete line in `chunk`; returns the offset past the last newline, or -1 if the sink stopped. */
function deliverLines(chunk: Buffer, pending: Buffer[], onLine: LineSink, lineNo: { n: number }): number {
  let start = 0;
  for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
    if (onLine(decodeLine(pending, chunk.subarray(start, nl)), ++lineNo.n, false) === true) return -1;
    start = nl + 1;
  }
  return start;
}

/** One read into `buf`, or null when the read fails. */
async function readChunk(fh: FileHandle, buf: Buffer, len: number): Promise<number | null> {
  try {
    return (await fh.read(buf, 0, len, null)).bytesRead;
  } catch {
    return null;
  }
}

/**
 * Feed every line of `path` to `onLine`, in order. Returns the number of bytes
 * read, or null when the file can't be opened or read (the same failures
 * readFile would throw for). Anything the sink throws propagates: only I/O
 * failures mean "unreadable".
 *
 * Splitting on the raw 0x0A byte before decoding is safe: in UTF-8 that byte
 * never occurs inside a multi-byte sequence, so each line decodes exactly as it
 * would have inside the whole-file string.
 */
export async function forEachLine(path: string, onLine: LineSink, opts: LineOptions = {}): Promise<number | null> {
  const { maxBytes = Infinity, chunkBytes = CHUNK_BYTES } = opts;
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(Math.min(chunkBytes, maxBytes));
    const pending: Buffer[] = [];
    const lineNo = { n: 0 };
    let total = 0;
    while (total < maxBytes) {
      const bytesRead = await readChunk(fh, buf, Math.min(buf.length, maxBytes - total));
      if (bytesRead === null) return null;
      if (bytesRead === 0) break;
      total += bytesRead;
      noteBytesRead(bytesRead);
      const chunk = buf.subarray(0, bytesRead);
      const start = deliverLines(chunk, pending, onLine, lineNo);
      if (start === -1) return total;
      // `buf` is reused by the next read, so a carried-over tail must be copied.
      if (start < bytesRead) pending.push(Buffer.from(chunk.subarray(start)));
    }
    if (pending.length) onLine(decodeLine(pending, Buffer.alloc(0)), ++lineNo.n, true);
    return total;
  } finally {
    await fh.close().catch(() => {});
  }
}
