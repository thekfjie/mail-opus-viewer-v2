# OpenAI subscription read-only contract

The read-only subscription endpoint used by compatible diagnostics is:

```text
GET https://chatgpt.com/backend-api/subscriptions?account_id=<chatgpt_account_id>
```

The response fields used by Opus Mail integrations retain their upstream
meaning:

- `active_until`: the Plus retention period 截止时间.
- `active_start`: the beginning of the current entitlement period.
- `plan_type`: the current plan type.
- `will_renew`: whether renewal is currently expected.
- `grace_period_end_timestamp`: the payment grace-period deadline; it is not
  interchangeable with `active_until`.

This document records the upstream response contract only. It does not enable
an upstream call or require these fields to be persisted.
