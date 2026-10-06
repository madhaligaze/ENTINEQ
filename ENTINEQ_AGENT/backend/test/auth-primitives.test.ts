import { describe, expect, it } from "vitest";
import { PasswordHasher } from "../src/auth/password.js";
import { hashInviteCode, hashToken, newInviteCode, newSessionToken, normalizeInviteCode, safeEqual } from "../src/auth/tokens.js";

const hasher = new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 });

describe("PasswordHasher", () => {
  it("проверяет верный пароль и отвергает неверный", async () => {
    const stored = await hasher.hash("correct horse battery");
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await hasher.verify("correct horse battery", stored)).toBe(true);
    expect(await hasher.verify("correct horse batterz", stored)).toBe(false);
    expect(await hasher.verify("", stored)).toBe(false);
  });

  it("соль у каждого хеша своя", async () => {
    expect(await hasher.hash("same-password-1")).not.toBe(await hasher.hash("same-password-1"));
  });

  it("не падает на повреждённых и подозрительных значениях", async () => {
    for (const bad of ["", "plain", "scrypt$1$2$3", "scrypt$abc$8$1$AAAA$AAAA", "scrypt$1024$8$1$$", "bcrypt$1024$8$1$AAAA$AAAA"]) {
      expect(await hasher.verify("x", bad)).toBe(false);
    }
  });

  it("не принимает параметры, способные «подвесить» сервер", async () => {
    // N = 2^30 заняло бы гигабайты памяти: такие значения отвергаются до вычисления.
    expect(await hasher.verify("x", `scrypt$${2 ** 30}$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(32).toString("base64")}`)).toBe(false);
    expect(await hasher.verify("x", `scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(32).toString("base64")}`)).toBe(false);
  });

  it("одинаково считает визуально одинаковые строки (NFKC)", async () => {
    const stored = await hasher.hash("пароль-1234567");
    expect(await hasher.verify("пароль-1234567".normalize("NFD"), stored)).toBe(true);
  });

  it("заранее готовит «пустышку» для выравнивания времени", async () => {
    expect(await hasher.dummy).toMatch(/^scrypt\$/);
  });
});

describe("токены и приглашения", () => {
  it("токен сессии длинный, уникальный и хранится только хешем", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });

  it("код приглашения имеет вид ENT-XXXX-XXXX-XXXX без путаемых символов", () => {
    for (let i = 0; i < 200; i++) {
      expect(newInviteCode()).toMatch(/^ENT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
    expect(new Set(Array.from({ length: 500 }, newInviteCode)).size).toBe(500);
  });

  it("регистр, дефисы и пробелы в коде не важны; префикс можно опустить", () => {
    const code = "ENT-ABCD-1234-WXYZ";
    const variants = ["ent-abcd-1234-wxyz", "ENTABCD1234WXYZ", "  ENT ABCD 1234 WXYZ ", "abcd-1234-wxyz", "ABCD1234WXYZ"];
    for (const variant of variants) expect(hashInviteCode(variant)).toBe(hashInviteCode(code));
    expect(normalizeInviteCode(code)).toBe("ENTABCD1234WXYZ");
    expect(hashInviteCode("ENT-ABCD-1234-WXYA")).not.toBe(hashInviteCode(code));
  });

  it("safeEqual сравнивает строки разной длины без ошибок", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
