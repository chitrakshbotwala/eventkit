import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { GENESIS_HASH, LogEntrySchema, type LogEntry, type LogEntryData, type LogEventType } from '@eventkit/shared';
import { sealEntry } from '@eventkit/shared/node';
import { readJson, writeJson } from '../store';

export interface LogMeta {
  logId: string;
  nextSeq: number;
  lastHash: string;
  scheduleVersion: number;
  openedAt: number;
  closed: boolean;
  /** Highest seq acknowledged by /api/connectivity/events. */
  sentSeq: number;
  /** Highest seq included in a successful full log upload. */
  uploadedSeq: number;
}

function endsWithNewline(file: string): boolean {
  if (!existsSync(file)) return true;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Monotonic clock (ms since boot on all desktop OSes). */
export const monoNow = () => Number(process.hrtime.bigint() / 1_000_000n);

function computeBootId(): string {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (id) return id.slice(0, 64);
  } catch {
    // not Linux
  }
  // Boot time rounded to the minute; computed once per process so a later
  // wall-clock change cannot alter it mid-run.
  return `b${Math.round((Date.now() - uptime() * 1000) / 60_000)}`;
}
export const BOOT_ID = computeBootId();

/**
 * Append-only, hash-chained, HMAC-signed connectivity log (JSONL on disk).
 * Every entry links to the previous hash, so deleting or editing entries is
 * detectable; the HMAC uses the server-issued device key.
 */
export class LocalLog {
  private meta: LogMeta | null;
  private tailChecked = false;

  constructor(
    private readonly dir: string,
    private readonly deviceKey: () => Buffer | null,
    private readonly offsetMs: () => number,
  ) {
    mkdirSync(dir, { recursive: true });
    this.meta = readJson<LogMeta | null>(this.metaFile, null);
  }

  private get metaFile() {
    return join(this.dir, 'current.json');
  }

  private file(logId: string) {
    return join(this.dir, `${logId}.jsonl`);
  }

  get current(): LogMeta | null {
    return this.meta;
  }

  get isOpen() {
    return Boolean(this.meta && !this.meta.closed);
  }

  /** Open a new log unless one is already open. Returns true if newly opened. */
  open(scheduleVersion: number): boolean {
    if (this.meta && !this.meta.closed) return false;
    this.tailChecked = false;
    this.meta = {
      logId: randomUUID(),
      nextSeq: 0,
      lastHash: GENESIS_HASH,
      scheduleVersion,
      openedAt: Date.now(),
      closed: false,
      sentSeq: -1,
      uploadedSeq: -1,
    };
    this.save();
    return true;
  }

  close() {
    if (!this.meta) return;
    this.meta.closed = true;
    this.save();
  }

  /** A closed, fully uploaded log can be discarded (a new phase starts fresh). */
  get finished() {
    return Boolean(this.meta?.closed && this.meta.uploadedSeq >= this.meta.nextSeq - 1);
  }

  append(type: LogEventType, data: LogEntryData = {}): LogEntry | null {
    const key = this.deviceKey();
    if (!this.meta || this.meta.closed || !key) return null;
    const entry = sealEntry(
      {
        logId: this.meta.logId,
        seq: this.meta.nextSeq,
        wallTime: Date.now(),
        monoMs: monoNow(),
        bootId: BOOT_ID,
        offsetMs: Math.round(this.offsetMs()),
        type,
        data,
        prevHash: this.meta.lastHash,
      },
      key,
    );
    // Synchronous append: survives crashes and runs inside before-quit handlers.
    const file = this.file(entry.logId);
    if (!this.tailChecked) {
      this.tailChecked = true;
      // Isolate a line torn by a crash so the new entry starts on its own line.
      if (!endsWithNewline(file)) appendFileSync(file, '\n');
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    this.meta.nextSeq++;
    this.meta.lastHash = entry.hash;
    this.save();
    return entry;
  }

  entries(): LogEntry[] {
    if (!this.meta) return [];
    const f = this.file(this.meta.logId);
    if (!existsSync(f)) return [];
    const out: LogEntry[] = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = LogEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // torn last line after a crash
      }
    }
    return out;
  }

  unsent(): LogEntry[] {
    const sent = this.meta?.sentSeq ?? -1;
    return this.entries().filter((e) => e.seq > sent);
  }

  markSent(seq: number) {
    if (!this.meta) return;
    this.meta.sentSeq = Math.max(this.meta.sentSeq, seq);
    this.save();
  }

  markUploaded(seq: number) {
    if (!this.meta) return;
    this.meta.uploadedSeq = Math.max(this.meta.uploadedSeq, seq);
    this.meta.sentSeq = Math.max(this.meta.sentSeq, seq);
    this.save();
  }

  get pendingUpload(): number {
    if (!this.meta) return 0;
    return Math.max(0, this.meta.nextSeq - 1 - this.meta.uploadedSeq);
  }

  private save() {
    writeJson(this.metaFile, this.meta);
  }
}
