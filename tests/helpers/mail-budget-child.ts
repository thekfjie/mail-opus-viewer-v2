import { SqliteTestDatabase as Database } from "../../src/server/storage/sqlite-test.js";
import { D1MailReader } from "../../src/server/cf-mail.js";

const database = new Database(process.argv[2]);
database.pragma("busy_timeout = 2000");
const reader = new D1MailReader(database, {
  accountId: "fake-account", databaseId: "fake-database", readToken: "fake-token",
  transport: async () => {
    process.send?.({ status: "request" });
    await new Promise<void>((resolve) => process.once("message", () => resolve()));
    return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [], meta: { rows_read: 0 } }] }));
  },
});
try {
  await reader.byId(process.argv[3]);
  process.send?.({ status: "done" });
} catch (error: any) {
  process.send?.({ status: "error", code: error.code });
} finally {
  (await database.close());
  process.disconnect?.();
}
