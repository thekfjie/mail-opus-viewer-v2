// Shared by the API and administrator UI. A GPT ban is independent from the
// mailbox permission lifecycle; retirement and identity quarantine are not.
export function customerGrantBlockReason(account: {
  lifecycleStatus: string;
  retiredAt?: string;
  quarantineReason?: string;
  identityStatus?: string;
}): string {
  if (account.retiredAt || account.lifecycleStatus === "retired") return "该邮箱身份已回收";
  if (account.identityStatus === "conflict") return "OpenAI身份冲突";
  if (account.quarantineReason || account.lifecycleStatus === "quarantined") return "归属待核对";
  if (!["active", "third_party_registered", "deactivated"].includes(account.lifecycleStatus)) return "非可授权账号";
  return "";
}
