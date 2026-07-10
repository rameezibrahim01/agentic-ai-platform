import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseEvent } from "@platform/core";
import type { RunEvent } from "@platform/core";

// The storage codec boundary (ticket 035): what a stored row LOOKS like is
// pluggable — plaintext today, AES-256-GCM with a client-provided key when
// PLATFORM_DATA_KEY is set. Both adapters run every event through the codec,
// so encryption wraps the storage boundary without either adapter knowing
// what a key is. Decode failures are TYPED — unreadable, never garbage.

export interface EventCodecContext {
  runId: string;
  seq: number;
}

export type DecodeResult =
  | { ok: true; event: RunEvent }
  | { ok: false; reason: string };

export interface EventCodec {
  name: string;
  encode(event: RunEvent, context: EventCodecContext): unknown;
  decode(raw: unknown, context: EventCodecContext): DecodeResult;
}

/**
 * A stored row failed decoding — tampering, a missing/wrong data key, or a
 * broken writer. Named error so callers can catch it specifically.
 */
export class CorruptEventLogError extends Error {
  constructor(
    readonly runId: string,
    readonly seq: number,
    detail: string,
  ) {
    super(`corrupt event log for run ${runId} at seq ${seq}: ${detail}`);
    this.name = "CorruptEventLogError";
  }
}

/** Today's default: events stored as themselves, validated on the way out. */
export const plaintextCodec: EventCodec = {
  name: "plaintext",
  encode: (event) => event,
  decode: (raw) => {
    const parsed = parseEvent(raw);
    return parsed.ok
      ? { ok: true, event: parsed.event }
      : { ok: false, reason: JSON.stringify(parsed.issues) };
  },
};

interface Envelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function isEnvelope(raw: unknown): raw is Envelope {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Envelope).v === 1 &&
    (raw as Envelope).alg === "aes-256-gcm" &&
    typeof (raw as Envelope).iv === "string" &&
    typeof (raw as Envelope).tag === "string" &&
    typeof (raw as Envelope).data === "string"
  );
}

/**
 * AES-256-GCM per event, AAD-bound to `runId:seq` — a ciphertext lifted to
 * another position (or another run) fails authentication instead of
 * decrypting somewhere it doesn't belong. The key is held in closure only:
 * never persisted, never serialized, never logged.
 */
export function makeEncryptedEventCodec(keyHex: string): EventCodec {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("PLATFORM_DATA_KEY must be 64 hex characters (a 32-byte AES-256 key)");
  }
  const key = Buffer.from(keyHex, "hex");
  const aad = (context: EventCodecContext): Buffer =>
    Buffer.from(`${context.runId}:${context.seq}`, "utf8");

  return {
    name: "aes-256-gcm",
    encode(event, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(context));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(event), "utf8"),
        cipher.final(),
      ]);
      const envelope: Envelope = {
        v: 1,
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      };
      return envelope;
    },
    decode(raw, context) {
      if (!isEnvelope(raw)) {
        return { ok: false, reason: "decryption_failed: stored row is not an encrypted envelope" };
      }
      let plaintext: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(raw.iv, "base64"));
        decipher.setAAD(aad(context));
        decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
        plaintext = Buffer.concat([
          decipher.update(Buffer.from(raw.data, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // wrong key, tampered ciphertext, or an envelope moved to another
        // (runId, seq) — GCM authentication rejects them identically
        return { ok: false, reason: "decryption_failed: authentication failed" };
      }
      try {
        return plaintextCodec.decode(JSON.parse(plaintext), context);
      } catch {
        return { ok: false, reason: "decryption_failed: plaintext is not JSON" };
      }
    },
  };
}
