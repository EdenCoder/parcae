/**
 * The account's waiting changes and their one sender: stored under storage's account, sent oldest
 * first with their key, settled only by an answer with a status, reported at each step. Its state
 * is live only in the host's copy; page files reach it through `page()`, never by import.
 *
 * The engine is the only writer of the waiting list, so after it reads storage's list at start and
 * when the session settles, its own list is the truth.
 */

import type { ParcaeClient } from "@parcae/sdk";
import {
  NOT_RUN,
  isNotFoundError,
  pointerSegments,
  IDEMPOTENCY_TTL_MS,
  type PatchOp,
  type TransportError,
} from "@parcae/model";

import { storedRow, STORAGE_FORMAT, type RowBatch, type ServerRow, type RowStorage, type StoredWrite } from "./rows";
import { listCreated } from "./reads";

/** The server's refusal of the last change kept for a record in this page, until another is kept. `status` is absent when the phone refused it itself. */
export interface WriteRefusal {
  method  : StoredWrite["method"];
  status? : number;
  code?   : string;
  message : string;
}

/** What happened to a stored change, emitted on the client as "write" for the app to report. */
export interface WriteMoment {
  moment  : "sent" | "retried" | "refused";
  type    : string;
  method  : StoredWrite["method"];
  /** Since it was kept. */
  ms      : number;
  /** The server's status, when it answered. */
  status? : number;
  /** The server's code for a refusal, when it gave one. */
  code?   : string;
}

/** The server's word on a change: its row (null for a delete), or its refusal. */
export type WriteOutcome =
  | { write: StoredWrite; answer: ServerRow | null }
  | { write: StoredWrite; refusal: WriteRefusal };

const SEND_BACKOFF_FLOOR_MS = 1_000;
const SEND_BACKOFF_CAP_MS   = 60_000;

let client  : ParcaeClient;
let storage : RowStorage | null = null;
/** Tells every page the waiting changes moved, with the server's word when one settled. */
let tell    : (outcome: WriteOutcome | null) => void;

let waiting: StoredWrite[] = [];
/** The account storage keeps the list for. */
let account: string | null = null;
const storing = new Set<string>();

let epoch   = 0;
let backoff = 0;
let sending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function startQueue(
  engineClient  : ParcaeClient,
  engineStorage : RowStorage | null,
  engineTell    : (outcome: WriteOutcome | null) => void,
): void {
  client  = engineClient;
  storage = engineStorage;
  tell    = engineTell;
}

/** The account's waiting changes, oldest first. */
export function waitingWrites(): readonly StoredWrite[] {
  return waiting;
}

/** Resolves once the change can't be lost: stored, or with no storage, answered. */
export async function keepWrite(write: StoredWrite): Promise<void> {
  waiting = [...waiting, write];
  tell(null);
  if (!storage) return settleNow(write);
  storing.add(write.key);
  try {
    // Storage knows the signed-in account offline; the session learns it only from the server.
    const user = account ?? (await storage.waiting({ format: STORAGE_FORMAT })).user;
    if (!user) throw new Error("Not signed in");
    await storage.write({ format: STORAGE_FORMAT, user, rows: [], lists: [], writes: [write] });
    account ??= user;
  } catch (cause) {
    refuse(write, { message: (cause as Error).message });
    throw cause;
  } finally {
    storing.delete(write.key);
  }
  sendWrites();
}

/** With no storage, a change is sent once and answers its caller; a lost line refuses it. */
async function settleNow(write: StoredWrite): Promise<void> {
  try {
    settle(write, (await send(write)) as ServerRow | null);
  } catch (cause) {
    refuse(write, cause as TransportError);
    throw cause;
  }
}

/**
 * The session settled or changed: the send in flight is dropped and storage's list is read again.
 * Storage answers only for the account the phone is signed in as, so the same account keeps its
 * changes and another's leave.
 */
export function readWaiting(): void {
  epoch++;
  sending = false;
  backoff = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  if (!storage) return;
  const at = epoch;
  void storage.waiting({ format: STORAGE_FORMAT }).then(({ user, writes }) => {
    if (at !== epoch) return;
    const listed = new Set(writes.map((write) => write.key));
    account = user;
    waiting = [...writes, ...waiting.filter((write) => storing.has(write.key) && !listed.has(write.key))];
    tell(null);
    sendWrites();
  });
}

// =============================================================================
// Send
// =============================================================================

/** Sends the oldest waiting change while the session is signed in and the line up. */
export function sendWrites(): void {
  if (!storage || sending) return;
  if (client.session.state.status !== "authenticated" || !client.isConnected) return;
  if (timer) clearTimeout(timer);
  timer = null;
  sending = true;
  const at = epoch;
  drain(storage, at)
    .catch(() => retryLater())
    .finally(() => {
      if (at === epoch) sending = false;
    });
}

async function drain(storage: RowStorage, at: number): Promise<void> {
  for (;;) {
    const write = waiting[0];
    const user = account;
    // The oldest goes first, so one still being stored holds the rest; its keep sends once stored.
    if (at !== epoch || !write || !user || storing.has(write.key)) return;
    let landed: Pick<RowBatch, "rows" | "removed"> = { rows: [] };
    if (write.sent !== null && Date.now() - write.sent > IDEMPOTENCY_TTL_MS) {
      // The server may have forgotten its key, so a resend could run it twice.
      refuse(write, { message: "Kept longer than the server remembers it" });
    } else {
      if (write.sent === null) {
        write.sent = Date.now();
        await storage.write({ format: STORAGE_FORMAT, user, rows: [], lists: [], writes: [write] });
      }
      let answer: unknown;
      try {
        answer = await send(write);
      } catch (cause) {
        if (at !== epoch) return;
        if (again(cause as TransportError)) return retryLater(write);
        refuse(write, cause as TransportError);
      }
      if (at !== epoch) return;
      if (waiting.includes(write)) {
        settle(write, answer as ServerRow | null);
        landed = landedRows(write, answer);
      }
    }
    backoff = 0;
    await storage.write({ format: STORAGE_FORMAT, user, lists: [], ...landed, settled: [write.key] });
  }
}

function send(write: StoredWrite): Promise<unknown> {
  return client.adapter.send(write, { idempotencyKey: write.key }).catch((cause: unknown) => {
    if (write.method === "DELETE" && isNotFoundError(cause)) return null;
    throw cause;
  });
}

/**
 * What storage keeps of a change's answer, so a row it draws is never older than what the page did:
 * a delete drops the row, a patch's answer rewrites the fields it changed, a save's the whole row.
 */
function landedRows(write: StoredWrite, answer: unknown): Pick<RowBatch, "rows" | "removed"> {
  if (write.method === "DELETE") return { rows: [], removed: [{ type: write.type, id: write.id }] };
  if (!answer || typeof answer !== "object") return { rows: [] };
  const ops = write.method === "PATCH" ? (write.body.ops as PatchOp[]) : null;
  const fields = ops && new Set(["id", ...ops.map((op) => pointerSegments(op.path)[0]!)]);
  return { rows: [storedRow(write.type, answer as ServerRow, fields)] };
}

/** Not run, try again: the line (no status), or the server's NOT_RUN. */
function again({ status, code }: TransportError): boolean {
  return status === undefined || code === NOT_RUN;
}

function retryLater(write?: StoredWrite): void {
  if (write) report("retried", write);
  backoff = Math.min(Math.max(backoff * 2, SEND_BACKOFF_FLOOR_MS), SEND_BACKOFF_CAP_MS);
  timer = setTimeout(() => {
    timer = null;
    sendWrites();
  }, backoff);
}

// =============================================================================
// Settle
// =============================================================================

function settle(write: StoredWrite, answer: ServerRow | null): void {
  waiting = waiting.filter((each) => each !== write);
  report("sent", write);
  if (answer) listCreated(write.lists, answer);
  tell({ write, answer });
}

function refuse(write: StoredWrite, { status, code, message }: Partial<TransportError> & { message: string }): void {
  waiting = waiting.filter((each) => each !== write);
  report("refused", write, { status, code });
  tell({ write, refusal: { method: write.method, status, code, message } });
}

/** The server's status and code go with a refusal; JSON leaves out the ones it didn't give. */
function report(moment: WriteMoment["moment"], write: StoredWrite, answer: Pick<WriteMoment, "status" | "code"> = {}): void {
  if (!storage) return;
  const payload: WriteMoment = { moment, type: write.type, method: write.method, ms: Date.now() - write.kept, ...answer };
  client._emitDiagnostic?.("write", { ...payload });
}
