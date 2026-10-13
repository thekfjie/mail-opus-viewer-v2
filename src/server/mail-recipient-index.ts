import type { Database } from "./storage/types.js";
import { emailHash, normalizeEmail } from "./association.js";
import { decryptSecret } from "./crypto.js";
import { isVerificationMail } from "./mail-classification.js";

/** 仅记录收件人哈希与邮件 ID，供未注册邮箱按地址查询本地索引。 */
export async function indexMailRecipients(database: Database, messageId: string, recipients: string[]): Promise<void> {
  const insert = database.prepare("INSERT OR IGNORE INTO mail_recipient_index(email_hash,message_id) VALUES(?,?)");
  for (const email of new Set(recipients.map(normalizeEmail))) {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) (await insert.run(emailHash(email), messageId));
  }
}

/** 一次性补齐已有轻量索引和漏识别的验证码分类，不读取上游邮件正文。 */
export async function applyMailRecipientIndex(database: Database): Promise<void> {
  (await database.exec(`CREATE TABLE IF NOT EXISTS mail_recipient_index (
    email_hash TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    PRIMARY KEY(email_hash,message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mail_recipient_message ON mail_recipient_index(message_id)`));
  const columns = new Set(((await database.prepare("PRAGMA table_info(mail_messages)").all()) as any[]).map((row) => row.name));
  if (columns.has("recipient_enc")) {
    for (const row of (await database.prepare("SELECT id,recipient_enc FROM mail_messages").all()) as any[]) {
      if (row.recipient_enc) (await indexMailRecipients(database, row.id, [decryptSecret(row.recipient_enc)]));
    }
  }
  (await repairVerificationCategories(database));
}

/** 将历史本地化验证码从普通邮件纠正为安全邮件，保留其他业务分类。 */
export async function repairVerificationCategories(database: Database): Promise<void> {
  const columns = new Set(((await database.prepare("PRAGMA table_info(mail_messages)").all()) as any[]).map((row) => row.name));
  if (["subject", "sender", "category", "is_security"].every((name) => columns.has(name))) {
    const update = database.prepare("UPDATE mail_messages SET category='security',is_security=1 WHERE id=?");
    for (const row of (await database.prepare("SELECT id,subject,sender FROM mail_messages WHERE category IN ('general','unknown','')").all()) as any[]) {
      if (isVerificationMail(row.subject, row.sender)) (await update.run(row.id));
    }
  }
}
