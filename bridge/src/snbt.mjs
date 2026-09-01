/**
 * SNBT (stringified NBT) reader.
 *
 * `data get` hands back the game's own text form, not JSON:
 *
 *   [{count: 64, Slot: 0b, id: "minecraft:stone"}]
 *   {Health: 20.0f, foodLevel: 20, Inventory: [...]}
 *
 * which differs from JSON in every way that matters: keys are unquoted, numbers carry a
 * type suffix (`0b`, `12s`, `3L`, `1.5f`, `2.0d`), strings may be single-quoted, and there
 * are typed array forms (`[B; 1b, 2b]`, `[I; 1, 2]`, `[L; 1L]`).
 *
 * Written out rather than pulled in because the alternatives are full NBT libraries that
 * bring a binary codec we do not need, and because the failure mode of a sloppy regex
 * here is an inventory that silently reads as empty.
 *
 * Numbers lose their type on the way out: `0b` and `0` both become `0`. Nothing
 * downstream needs the distinction — the browser draws item counts, not NBT — and keeping
 * it would mean boxing every number.
 */

class Reader {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }

  error(msg) {
    return new Error(`SNBT at ${this.i}: ${msg} (in ${JSON.stringify(this.s.slice(0, 80))})`);
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  peek() {
    return this.s[this.i];
  }

  expect(ch) {
    if (this.s[this.i] !== ch) throw this.error(`expected ${ch}, found ${this.s[this.i] ?? 'EOF'}`);
    this.i++;
  }

  value() {
    this.ws();
    const c = this.peek();
    if (c === '{') return this.compound();
    if (c === '[') return this.list();
    if (c === '"' || c === "'") return this.quoted();
    return this.scalar();
  }

  compound() {
    this.expect('{');
    const out = {};
    this.ws();
    if (this.peek() === '}') { this.i++; return out; }
    for (;;) {
      this.ws();
      const key = this.peek() === '"' || this.peek() === "'" ? this.quoted() : this.bareKey();
      this.ws();
      this.expect(':');
      out[key] = this.value();
      this.ws();
      if (this.peek() === ',') { this.i++; continue; }
      this.expect('}');
      return out;
    }
  }

  /**
   * Lists and typed arrays. `[B; 1b, 2b]` is a byte array; the prefix is dropped because
   * the elements carry the same information and nothing here round-trips back to NBT.
   */
  list() {
    this.expect('[');
    this.ws();
    if (/^[BIL];/.test(this.s.slice(this.i, this.i + 2))) this.i += 2;
    const out = [];
    this.ws();
    if (this.peek() === ']') { this.i++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      if (this.peek() === ',') { this.i++; continue; }
      this.expect(']');
      return out;
    }
  }

  quoted() {
    const quote = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === '\\') {
        out += this.s[this.i++] ?? '';
      } else if (c === quote) {
        return out;
      } else {
        out += c;
      }
    }
    throw this.error('unterminated string');
  }

  bareKey() {
    const start = this.i;
    while (this.i < this.s.length && /[A-Za-z0-9_.+-]/.test(this.s[this.i])) this.i++;
    if (this.i === start) throw this.error('empty key');
    return this.s.slice(start, this.i);
  }

  /** A number with an optional type suffix, or a bare word (`true`, `minecraft:stone`). */
  scalar() {
    const start = this.i;
    while (this.i < this.s.length && !/[,\]}\s]/.test(this.s[this.i])) this.i++;
    const raw = this.s.slice(start, this.i);
    if (raw === '') throw this.error('empty value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const num = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[bBsSlLfFdD]?$/.exec(raw);
    if (num) {
      const n = Number(num[1]);
      if (Number.isFinite(n)) return n;
    }
    return raw;
  }
}

/** Parse SNBT. Throws on malformed input; callers decide whether that is fatal. */
export function parseSnbt(text) {
  const r = new Reader(String(text));
  const v = r.value();
  return v;
}

/**
 * The payload of a `data get` reply.
 *
 * Replies look like `webviewer has the following entity data: <SNBT>` or
 * `-480, 64, 64 has the following block data: <SNBT>`. Returns null for "No entity was
 * found", an unparseable body, or a TRUNCATED one.
 *
 * Truncation matters: vanilla RCON caps a reply at 4096 bytes and simply cuts it off
 * rather than splitting across packets, so a large inventory arrives as invalid SNBT.
 * Returning null there — instead of a half-parsed inventory — is what lets the caller
 * fall back to reading slot by slot.
 */
export function parseDataGet(reply) {
  if (typeof reply !== 'string') return null;
  const marker = ' data: ';
  const at = reply.indexOf(marker);
  if (at < 0) return null;
  const body = reply.slice(at + marker.length).trim();
  if (!body) return null;
  try {
    return parseSnbt(body);
  } catch {
    return null;
  }
}

/** Vanilla RCON truncates rather than splitting; a reply at the cap is not trustworthy. */
export const RCON_REPLY_LIMIT = 4096;

export function looksTruncated(reply) {
  return typeof reply === 'string' && reply.length >= RCON_REPLY_LIMIT;
}
