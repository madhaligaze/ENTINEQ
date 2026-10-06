import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { Config } from "./config.js";
import { coreErrorSchema, conversationsSchema, grantSchema, meSchema, messagesSchema, pingSchema } from "./contract.js";
import { AppError, errors } from "./errors.js";

type Log = Pick<FastifyBaseLogger, "error" | "warn">;

/**
 * Клиент внутреннего API ядра. Секрет добавляется здесь и нигде больше; токен пользователя
 * передаётся отдельным заголовком. Любые сбои ядра превращаются в понятные ошибки для пользователя,
 * а подробности остаются в логах.
 */
export class CoreClient {
  constructor(
    private readonly cfg: Pick<Config, "agentHttpUrl" | "internalApiSecret" | "agentTimeoutMs">,
    private readonly log: Log,
  ) {}

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S | null,
    options: { token?: string; body?: unknown } = {},
  ): Promise<z.infer<S> | null> {
    let response: Response;
    try {
      response = await fetch(`${this.cfg.agentHttpUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.internalApiSecret}`,
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.token ? { "x-user-token": options.token } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.cfg.agentTimeoutMs),
      });
    } catch (error) {
      this.log.error({ err: error, path }, "ядро ENTINEQ_AGENT недоступно");
      throw errors.unavailable();
    }

    if (response.status === 204) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const failure = coreErrorSchema.safeParse(payload);
      if (failure.success && failure.data.error.code === "internal_unauthorized") {
        // Ядро не приняло наш секрет - это ошибка настройки, а не «пользователь не вошёл».
        this.log.error({ path }, "ядро отклонило INTERNAL_API_SECRET: секреты в двух проектах Railway не совпадают");
        throw errors.misconfigured();
      }
      if (response.status >= 500 || !failure.success) {
        this.log.error({ path, status: response.status }, "неожиданный ответ ядра");
        throw errors.unavailable();
      }
      const { code, message, resetsAt } = failure.data.error;
      throw new AppError(code, message, response.status, resetsAt);
    }

    if (!schema) return null;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.log.error({ path, issues: parsed.error.issues.slice(0, 3) }, "ответ ядра не соответствует контракту");
      throw errors.invalidUpstream();
    }
    return parsed.data;
  }

  /** Проверка связки: секрет принят, версия контракта совпадает. */
  async ping() {
    return (await this.request("GET", "/ping", pingSchema))!;
  }

  async register(body: { email: string; password: string; inviteCode: string }) {
    return (await this.request("POST", "/auth/register", grantSchema, { body }))!;
  }

  async login(body: { email: string; password: string }) {
    return (await this.request("POST", "/auth/login", grantSchema, { body }))!;
  }

  async logout(token: string) {
    await this.request("POST", "/auth/logout", null, { token, body: {} });
  }

  async me(token: string) {
    return (await this.request("GET", "/me", meSchema, { token }))!;
  }

  async conversations(token: string) {
    return (await this.request("GET", "/conversations", conversationsSchema, { token }))!;
  }

  async messages(token: string, id: string) {
    return (await this.request("GET", `/conversations/${id}/messages`, messagesSchema, { token }))!;
  }
}
