/** Уровень доверия аккаунта. */
export type Role = "owner" | "trusted" | "public";

/**
 * Через какую «дверь» пришёл запрос.
 * direct   - собственный интерфейс ENTINEQ_AGENT (владелец и доверенные);
 * internal - внутренний канал для публичного приложения ENTINEQ.
 */
export type Entry = "direct" | "internal";

/** Какие роли вообще допускаются через каждую дверь. Уровень доверия задаёт вход, а не клиент. */
export const ENTRY_ROLES: Record<Entry, readonly Role[]> = {
  direct: ["owner", "trusted"],
  internal: ["public"],
};

export interface Actor {
  userId: string;
  email: string;
  role: Role;
  entry: Entry;
}

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
}
