import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { listen } from "../src/listen.js";

describe("listen - запасной адрес для систем без IPv6", () => {
  const fakeApp = (behaviour: (host: string) => Error | undefined) => {
    const attempts: string[] = [];
    const app = {
      listen: async ({ host }: { host: string }) => {
        attempts.push(host);
        const error = behaviour(host);
        if (error) throw error;
      },
    } as unknown as FastifyInstance;
    return { app, attempts };
  };
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("сначала `::`, при отсутствии IPv6 - `0.0.0.0`", async () => {
    const { app, attempts } = fakeApp((host) => (host === "::" ? errno("EAFNOSUPPORT") : undefined));
    expect(await listen(app, 8080)).toBe("0.0.0.0");
    expect(attempts).toEqual(["::", "0.0.0.0"]);
  });

  it("если `::` доступен - другие адреса не пробуются", async () => {
    const { app, attempts } = fakeApp(() => undefined);
    expect(await listen(app, 8080)).toBe("::");
    expect(attempts).toEqual(["::"]);
  });

  it("занятый порт - настоящая ошибка, запасной адрес её не маскирует", async () => {
    const { app, attempts } = fakeApp(() => errno("EADDRINUSE"));
    await expect(listen(app, 8080)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(attempts).toEqual(["::"]);
  });

  it("явно заданный адрес используется как есть", async () => {
    const { app, attempts } = fakeApp(() => undefined);
    expect(await listen(app, 8080, "127.0.0.1")).toBe("127.0.0.1");
    expect(attempts).toEqual(["127.0.0.1"]);
  });
});
