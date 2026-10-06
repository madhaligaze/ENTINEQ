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

/**
 * Чем ведётся диалог (см. conversations.engine в db/schema.ts):
 * agent - Claude Agent SDK в контейнере ядра, chat - обычный чат без инструментов, managed - терминал в песочнице Anthropic.
 */
export type Engine = "agent" | "chat" | "managed";

export interface Actor {
  userId: string;
  /** null - гость: аккаунт без входа. */
  email: string | null;
  role: Role;
  entry: Entry;
  guest: boolean;
}

export interface PublicUser {
  id: string;
  email: string | null;
  role: Role;
  guest: boolean;
}
