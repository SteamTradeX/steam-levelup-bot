import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A value that must never be printed.
 *
 * A Steam password, a shared secret and an identity secret together are
 * complete unattended control of an account and everything in its inventory.
 * The most likely way one escapes is not an attacker: it is somebody logging
 * the config object while chasing an unrelated bug, and never noticing.
 *
 * So secrets are not stored as strings. They are wrapped in this, which
 * refuses to render itself through every route a value can reach a log:
 * string interpolation, `JSON.stringify`, `console.log` (which uses the
 * inspect hook), and template literals. Reading the real value takes a
 * deliberate `.reveal()` that is easy to search for in review.
 */

const REDACTED = "[redacted]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /**
   * The only way out. Named so that `grep reveal(` finds every place a secret
   * is unwrapped, which should be a short list.
   */
  reveal(): string {
    return this.#value;
  }

  get isEmpty(): boolean {
    return this.#value.length === 0;
  }

  /**
   * A short, stable fingerprint, safe to show and safe to log.
   *
   * This is what is shown instead of the value. It lets somebody
   * answer "did this change since yesterday" without ever seeing the secret.
   * Truncated to 12 hex characters: enough that two different secrets will
   * not collide in practice, far too little to attack the original.
   *
   * Deliberately not "the last four characters", which is the usual choice
   * and is wrong here. A shared secret is base32, so four characters is 20
   * bits of a value that only has 160, given away to anyone glancing at the
   * screen.
   */
  fingerprint(): string {
    if (this.isEmpty) return "";
    return createHash("sha256").update(this.#value, "utf8").digest("hex").slice(0, 12);
  }

  /** Constant time, so comparing does not leak the value one byte at a time. */
  equals(other: Secret): boolean {
    const a = Buffer.from(this.#value, "utf8");
    const b = Buffer.from(other.#value, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /* Node calls this for console.log and util.inspect. Without it, a secret
     inside an object logged for debugging prints in full. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }

  /* Covers `${secret}` and `secret + ""`, which do not go through toString
     when a Symbol.toPrimitive is present. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

export function secret(value: string | undefined | null): Secret {
  return new Secret(value ?? "");
}
