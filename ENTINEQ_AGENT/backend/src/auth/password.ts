import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;

/** Параметры по рекомендациям OWASP для scrypt (N=2^15, r=8, p=3). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

function derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const options: ScryptOptions = { N, r, p, maxmem: MAX_MEMORY };
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Хеш хранится вместе со своими параметрами: формат scrypt$N$r$p$соль$хеш. */
export class PasswordHasher {
  /** Заранее посчитанный хеш: его проверяют, когда email не найден, чтобы время ответа не выдавало отсутствие аккаунта. */
  readonly dummy: Promise<string>;

  constructor(private readonly params: ScryptParams = DEFAULT_SCRYPT) {
    this.dummy = this.hash(randomBytes(16).toString("hex"));
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, this.params);
    const { N, r, p } = this.params;
    return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const valid =
      Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 17 && (N & (N - 1)) === 0 &&
      Number.isInteger(r) && r >= 1 && r <= 16 &&
      Number.isInteger(p) && p >= 1 && p <= 8;
    if (!valid) return false;
    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
    const actual = await derive(password, salt, { N, r, p });
    return timingSafeEqual(actual, expected);
  }
}
