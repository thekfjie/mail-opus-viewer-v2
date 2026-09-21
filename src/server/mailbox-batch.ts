import { normalizeEmail, splitEmail } from "./association.js";

/** A mailbox batch is the physical delivery pool. Controlled iCloud +oai
 * aliases are labels inside that pool, not customer-isolation boundaries. */
export function mailboxBatchKey(emailInput: string): string {
  const { localPart, domain } = splitEmail(normalizeEmail(emailInput));
  if (!localPart || !domain) return "";
  const batchLocalPart = domain === "icloud.com" || domain.endsWith(".icloud.com")
    ? localPart.replace(/\+oai[a-z0-9]+$/i, "") : localPart;
  return `${batchLocalPart}@${domain}`;
}

export function mailboxBindingBatchSql(alias: string): string {
  return `lower(CASE
    WHEN (${alias}.domain='icloud.com' OR ${alias}.domain LIKE '%.icloud.com')
      AND instr(lower(${alias}.local_part),'+oai')>0
    THEN substr(${alias}.local_part,1,instr(lower(${alias}.local_part),'+oai')-1)
    ELSE ${alias}.local_part END || '@' || ${alias}.domain)`;
}
