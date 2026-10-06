import type { AuthService } from "../auth/service.js";
import type { ChatService } from "../chat/service.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

export interface AppContext {
  cfg: Config;
  db: Db;
  auth: AuthService;
  chat: ChatService;
}
