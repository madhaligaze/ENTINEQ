import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/** Разворачивает IPv6-адрес (допустимый по isIP) в восемь 16-битных групп. Встроенный IPv4 в конце учитывается. */
function expandIpv6(ip: string): number[] {
  let body = ip;
  let tail: number[] = [];
  if (ip.includes(".")) {
    const cut = ip.lastIndexOf(":");
    const octets = ip.slice(cut + 1).split(".").map(Number);
    tail = [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
    // Вместо IPv4 временно две пустые группы, настоящие значения подставим в конце.
    body = `${ip.slice(0, cut + 1)}0:0`;
  }
  const [head = "", rest] = body.split("::");
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

/**
 * Приводит адрес посетителя к «корзине» для пределов: IPv4 как есть, IPv4 внутри IPv6 - его IPv4,
 * остальные IPv6 - сеть /64 (владелец одной сети /64 иначе мог бы менять адрес внутри неё без конца).
 * Нераспознанное значение - "unknown": все такие запросы делят одну корзину, а не получают обход предела.
 */
export function ipBucket(raw: string | undefined): string {
  if (!raw) return "unknown";
  let ip = raw.trim();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return "unknown";
  const groups = expandIpv6(ip);
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group))) return "unknown";
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/** Хеш корзины с секретом сервиса: в БД остаётся не адрес посетителя, а необратимый отпечаток. */
export function hashIpBucket(secret: string, bucket: string): string {
  return createHmac("sha256", secret).update(`ip:${bucket}`).digest("hex");
}
