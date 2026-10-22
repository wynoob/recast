import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export class InstanceLock {
  private connection: Database.Database | null = null;

  constructor(private readonly path: string) {}

  async acquire(): Promise<void> {
    if (this.connection !== null) throw new Error("当前实例已持有锁");
    await mkdir(dirname(this.path), { recursive: true });
    const connection = new Database(`${this.path}.sqlite`, { timeout: 0 });
    try {
      connection.exec("BEGIN EXCLUSIVE");
      this.connection = connection;
    } catch (error) {
      connection.close();
      if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
        throw new Error("工作台已有运行实例", { cause: error });
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }
}
