#!/usr/bin/env python3
"""ChatGPT account promo / eligibility checker.

GET https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27
Used to inspect monthly promo eligibility for a given access token.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Optional
from urllib.parse import quote, unquote, urlparse

# Dependencies are installed in V2's own Python environment.
try:
    from curl_cffi import requests as cffi_requests
except Exception:
    cffi_requests = None
try:
    import requests
except Exception:  # pragma: no cover
    requests = None

try:
    from integrations.common import decode_jwt_payload, first_non_empty
except Exception:  # allow CLI from tools/ without package path
    import base64
    import json as _json

    def decode_jwt_payload(token: str):
        try:
            part = token.split('.')[1]
            part += '=' * ((4 - len(part) % 4) % 4)
            return _json.loads(base64.urlsafe_b64decode(part.encode()))
        except Exception:
            return {}

    def first_non_empty(*vals):
        for v in vals:
            if v not in (None, ''):
                return v
        return None

# 备注：Plus 挽留期应从只读订阅接口
# GET /backend-api/subscriptions?account_id=<chatgpt_account_id> 的 active_until 读取；
# 当前 /accounts/check 探查只读取资格与套餐，不调用订阅接口。
CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
DEFAULT_TIMEOUT = 30

PROMO_HINT_KEYS = (
    "promo",
    "promotion",
    "promotions",
    "discount",
    "discounts",
    "eligible",
    "eligibility",
    "offer",
    "offers",
    "trial",
    "coupon",
    "campaign",
    "intro",
    "monthly",
    "plus_monthly",
    "subscription",
    "entitlement",
    "features",
    "is_eligible",
    "can_purchase",
)

TARGET_MONTHLY_PROMO_CAMPAIGN = "plus-1-month-free"


def build_check_headers(token: str, account_id: str, device_id: str) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
        "OAI-Device-Id": device_id,
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.6778.86 Safari/537.36"
        ),
    }
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
    return headers


def normalize_proxy_url(value: Any) -> str:
    """Normalize common proxy notations without echoing credentials in errors."""
    raw = str(value or "").strip().strip("\"'")
    if not raw:
        return ""
    raw = re.sub(r"^(?:proxy|https?_proxy)\s*[:=]\s*", "", raw, flags=re.I).strip()
    if "," in raw and ":" not in raw:
        raw = ":".join(part.strip() for part in raw.split(","))
    if "://" not in raw:
        if "@" in raw:
            raw = f"http://{raw}"
        else:
            parts = raw.split(":")
            if len(parts) >= 4 and parts[1].isdigit():
                host, port, username = parts[0], parts[1], parts[2]
                password = ":".join(parts[3:])
                raw = (
                    f"http://{quote(username, safe='')}:"
                    f"{quote(password, safe='')}@{host}:{port}"
                )
            elif len(parts) == 2 and parts[1].isdigit():
                raw = f"http://{raw}"
            else:
                raise ValueError(
                    "代理格式不完整；请填写 host:port、host:port:user:pass 或 user:pass@host:port"
                )
    parsed = urlparse(raw)
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("代理端口格式不正确") from error
    scheme = str(parsed.scheme or "").lower()
    if scheme not in {"http", "https", "socks5", "socks5h"} or not parsed.hostname or not port:
        raise ValueError(
            "代理格式不正确；请填写 host:port、host:port:user:pass 或 user:pass@host:port"
        )
    auth = ""
    if parsed.username is not None or parsed.password is not None:
        auth = (
            f"{quote(unquote(parsed.username or ''), safe='')}:"
            f"{quote(unquote(parsed.password or ''), safe='')}@"
        )
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    return f"{scheme}://{auth}{host}:{port}"


def transport_error_message(error: Exception, *, proxy_used: bool) -> str:
    """Return a useful transport error without leaking proxy credentials."""
    message = str(error or "").lower()
    if proxy_used:
        if "407" in message or "proxy authentication" in message:
            return "代理认证失败，请检查代理用户名和密码"
        if "failed to parse" in message or "invalid proxy" in message or "bad proxy" in message:
            return "代理地址解析失败，请检查代理格式和端口"
        if "could not resolve" in message or "name or service not known" in message:
            return "代理主机无法解析，请检查代理域名"
        if "timeout" in message or "timed out" in message:
            return "代理连接超时"
        if "connect" in message or "connection" in message:
            return "代理连接失败，请检查地址、端口和可用性"
        return f"代理请求失败（{type(error).__name__}）"
    if "timeout" in message or "timed out" in message:
        return "直连请求超时"
    return f"请求失败（{type(error).__name__}）"


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def extract_credentials(payload: Any) -> dict[str, str]:
    """Extract accessToken / accountId / deviceId / email from free-form input."""
    access = ""
    account_id = ""
    device_id = ""
    email = ""

    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            return {"accessToken": "", "accountId": "", "deviceId": "", "email": ""}
        if text.startswith("eyJ") and text.count(".") >= 2:
            access = text
        else:
            try:
                payload = json.loads(text)
            except Exception:
                # bare token-ish line
                m = re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", text)
                access = m.group(0) if m else text
    if isinstance(payload, dict):
        user = _as_dict(payload.get("user"))
        account = _as_dict(payload.get("account"))
        tokens = _as_dict(payload.get("tokens"))
        meta = _as_dict(payload.get("meta"))
        session = _as_dict(payload.get("session"))
        credentials = _as_dict(payload.get("credentials"))

        # Sub2API exports wrap credentials inside accounts[].credentials.
        # Select the first account carrying an access token, while preserving
        # the existing top-level ChatGPT/Codex input shapes.
        account_rows = payload.get("accounts") if isinstance(payload.get("accounts"), list) else []
        selected_account: dict[str, Any] = {}
        for row in account_rows:
            if not isinstance(row, dict):
                continue
            row_credentials = _as_dict(row.get("credentials"))
            if row_credentials.get("access_token") or row_credentials.get("accessToken"):
                selected_account = row
                break
        if not selected_account and account_rows and isinstance(account_rows[0], dict):
            selected_account = account_rows[0]
        if selected_account:
            account = {**selected_account, **account}
            credentials = {**_as_dict(selected_account.get("credentials")), **credentials}
            tokens = {**_as_dict(selected_account.get("tokens")), **tokens}
            meta = {**_as_dict(selected_account.get("extra")), **meta}
        access = first_non_empty(
            payload.get("accessToken"),
            payload.get("access_token"),
            tokens.get("access_token"),
            credentials.get("accessToken"),
            credentials.get("access_token"),
            session.get("accessToken"),
            "",
        ) or ""
        account_id = first_non_empty(
            account.get("id"),
            payload.get("accountId"),
            payload.get("account_id"),
            payload.get("chatgpt_account_id"),
            tokens.get("account_id"),
            credentials.get("chatgpt_account_id"),
            credentials.get("account_id"),
            meta.get("chatgpt_account_id"),
            session.get("accountId"),
            "",
        ) or ""
        device_id = first_non_empty(
            payload.get("deviceId"),
            payload.get("device_id"),
            payload.get("oai-did"),
            payload.get("oai_did"),
            credentials.get("deviceId"),
            credentials.get("device_id"),
            meta.get("device_id"),
            "",
        ) or ""
        email = first_non_empty(
            user.get("email"),
            payload.get("email"),
            credentials.get("email"),
            meta.get("email"),
            account.get("email"),
            "",
        ) or ""

    access = str(access or "").strip()
    account_id = str(account_id or "").strip()
    device_id = str(device_id or "").strip()
    email = str(email or "").strip()

    if access.startswith("eyJ"):
        claims = decode_jwt_payload(access) or {}
        auth = claims.get("https://api.openai.com/auth")
        if isinstance(auth, dict):
            if not account_id:
                account_id = str(auth.get("chatgpt_account_id") or auth.get("account_id") or "").strip()
            if not email:
                email = str(claims.get("email") or auth.get("email") or "").strip()
        if not email:
            email = str(claims.get("email") or "").strip()
        if not account_id:
            # rare fallbacks
            account_id = str(claims.get("chatgpt_account_id") or claims.get("account_id") or "").strip()

    if not device_id:
        device_id = str(uuid.uuid4())

    return {
        "accessToken": access,
        "accountId": account_id,
        "deviceId": device_id,
        "email": email,
    }


def _walk_promo_nodes(node: Any, path: str = "", out: Optional[list] = None, depth: int = 0) -> list[dict[str, Any]]:
    if out is None:
        out = []
    if depth > 8:
        return out
    if isinstance(node, dict):
        joined = "/".join(str(k).lower() for k in node.keys())
        interesting = any(h in joined for h in PROMO_HINT_KEYS) or any(h in path.lower() for h in PROMO_HINT_KEYS)
        if interesting:
            out.append({"path": path or "$", "value": node})
        for k, v in node.items():
            child = f"{path}.{k}" if path else str(k)
            if isinstance(v, (dict, list)):
                _walk_promo_nodes(v, child, out, depth + 1)
            else:
                key_l = str(k).lower()
                if any(h in key_l for h in PROMO_HINT_KEYS):
                    out.append({"path": child, "value": v})
    elif isinstance(node, list):
        for i, item in enumerate(node[:50]):
            _walk_promo_nodes(item, f"{path}[{i}]", out, depth + 1)
    return out


def summarize_check(data: Any, account_id: str = "") -> dict[str, Any]:
    """Summarize the actual /accounts/check response contract.

    The endpoint does not put eligibility booleans at the response root.  It
    returns account records under ``accounts[account_id]`` and puts the
    authoritative campaign in ``eligible_promo_campaigns``.  The old
    best-effort walker only saw that object as an opaque node, so the UI always
    showed an indeterminate result even when the one-month campaign was
    present.
    """
    root = data if isinstance(data, dict) else {"raw": data}
    accounts = _as_dict(root.get("accounts"))
    record = _as_dict(accounts.get(account_id)) if account_id else {}
    if not record and accounts:
        # Pick the first account record when the caller's id is absent or the
        # upstream uses the ``default`` key.
        for k, value in accounts.items():
            if isinstance(value, dict):
                record = value
                if not account_id:
                    account_id = str(k)
                break

    account = _as_dict(record.get("account"))
    entitlement = _as_dict(record.get("entitlement") or root.get("entitlement"))
    features = record.get("features") if isinstance(record.get("features"), list) else root.get("features")
    plan_type = first_non_empty(
        account.get("plan_type"),
        entitlement.get("subscription_plan"),
        entitlement.get("plan_type"),
        record.get("plan_type"),
        root.get("plan_type"),
        "",
    )

    eligible_campaigns = record.get("eligible_promo_campaigns")
    campaign = find_monthly_promo_campaign(eligible_campaigns)
    eligible_offers = record.get("eligible_offers")
    monthly_present = isinstance(eligible_campaigns, (dict, list))
    if campaign:
        monthly_guess = True
        monthly_evidence = f"eligible_promo_campaigns.{campaign.get('key', 'plus')}.id={campaign.get('id')}"
    elif monthly_present:
        monthly_guess = False
        monthly_evidence = f"eligible_promo_campaigns 中未匹配 {TARGET_MONTHLY_PROMO_CAMPAIGN}"
    else:
        monthly_guess = None
        monthly_evidence = "上游未返回 eligible_promo_campaigns"

    promo_nodes = _walk_promo_nodes(root)
    monthly_hits = []
    for item in promo_nodes:
        blob = json.dumps(item.get("value"), ensure_ascii=False).lower()
        path = str(item.get("path") or "").lower()
        if "month" in blob or "month" in path or "plus" in blob or "promo" in blob or "discount" in blob:
            monthly_hits.append(item)

    # common eligibility booleans if present
    flags: dict[str, Any] = {}
    for key in (
        "is_eligible",
        "eligible",
        "has_discount",
        "can_subscribe",
        "is_delinquent",
        "has_previously_paid_subscription",
    ):
        if key in root:
            flags[key] = root.get(key)
        if key in account:
            flags[key] = account.get(key)
        if key in record:
            flags[key] = record.get(key)
        if key in entitlement:
            flags[key] = entitlement.get(key)
    flags["monthly_promo_campaign_present"] = bool(campaign)
    flags["eligible_promo_campaigns_present"] = monthly_present

    return {
        "accountId": account_id,
        "planType": plan_type or "",
        "entitlement": entitlement,
        "features": features if features is not None else [],
        "flags": flags,
        "monthlyPromoGuess": monthly_guess,
        "monthlyPromoCampaign": campaign or {},
        "monthlyPromoEvidence": monthly_evidence,
        "eligiblePromoCampaigns": eligible_campaigns if eligible_campaigns is not None else {},
        "eligibleOffers": eligible_offers if eligible_offers is not None else {},
        "promoNodes": monthly_hits[:30],
        "accountKeys": sorted(list(account.keys())) if account else [],
        "recordKeys": sorted(list(record.keys())) if record else [],
        "topKeys": sorted(list(root.keys())) if isinstance(root, dict) else [],
    }


def find_monthly_promo_campaign(value: Any) -> dict[str, Any]:
    """Return the authoritative one-month campaign, if present."""
    candidates: list[tuple[str, Any]] = []
    if isinstance(value, dict):
        candidates.extend((str(key), item) for key, item in value.items())
    elif isinstance(value, list):
        candidates.extend((str(index), item) for index, item in enumerate(value))
    for key, item in candidates:
        if not isinstance(item, dict):
            continue
        campaign_id = str(item.get("id") or "").strip()
        metadata = _as_dict(item.get("metadata"))
        duration = _as_dict(metadata.get("duration"))
        period = str(duration.get("period") or "").lower()
        periods = duration.get("num_periods")
        is_target_id = campaign_id == TARGET_MONTHLY_PROMO_CAMPAIGN
        is_one_month = period == "month" and str(periods) == "1"
        is_plus = "plus" in str(metadata.get("plan_name") or "").lower()
        if is_target_id or (is_one_month and is_plus):
            return {"key": key, **item}
    return {}


def check_promo(
    *,
    access_token: str = "",
    account_id: str = "",
    device_id: str = "",
    email: str = "",
    proxy: str = "",
    raw_input: Any = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    proxy = normalize_proxy_url(proxy)
    creds = extract_credentials(raw_input) if raw_input not in (None, "") else {
        "accessToken": access_token,
        "accountId": account_id,
        "deviceId": device_id,
        "email": email,
    }
    # explicit args override extracted values when provided
    if access_token:
        creds["accessToken"] = access_token.strip()
    if account_id:
        creds["accountId"] = account_id.strip()
    if device_id:
        creds["deviceId"] = device_id.strip()
    if email:
        creds["email"] = email.strip()

    # re-extract account/email from token if still missing
    filled = extract_credentials(creds.get("accessToken") or "")
    if not creds.get("accountId"):
        creds["accountId"] = filled.get("accountId") or ""
    if not creds.get("email"):
        creds["email"] = filled.get("email") or ""
    if not creds.get("deviceId"):
        creds["deviceId"] = filled.get("deviceId") or str(uuid.uuid4())

    token = str(creds.get("accessToken") or "").strip()
    acc = str(creds.get("accountId") or "").strip()
    did = str(creds.get("deviceId") or "").strip() or str(uuid.uuid4())
    if not token:
        raise ValueError("月优惠检测需要 accessToken；纯 refresh_token/RT 只能转换，不能直接查询优惠资格")
    # Some legacy ATs omit chatgpt_account_id. The authoritative endpoint can
    # resolve them from the bearer token; callers must still require one unique
    # account record before persisting a positive or negative decision.
    headers = build_check_headers(token, acc, did)
    proxies = {"http": proxy, "https": proxy} if proxy else None
    # Prefer curl_cffi (TLS fingerprint) when available; fall back to requests.
    backend = "requests"
    resp = None
    last_err = None
    if cffi_requests is not None:
        try:
            sess = cffi_requests.Session(impersonate="chrome131", proxies=proxies, timeout=timeout)
            resp = sess.get(CHECK_URL, headers=headers)
            backend = "curl_cffi"
        except Exception as e:  # pragma: no cover
            last_err = str(e)
            resp = None
    if resp is None:
        if requests is None:
            raise RuntimeError("月优惠检测缺少可用的 HTTP 客户端")
        try:
            resp = requests.get(CHECK_URL, headers=headers, proxies=proxies, timeout=timeout)
        except Exception as error:
            raise RuntimeError(transport_error_message(error, proxy_used=bool(proxy))) from None
        backend = "requests" if last_err is None else f"requests(fallback after curl_cffi: {last_err[:120]})"
    text = resp.text or ""
    data: Any
    try:
        data = resp.json()
    except Exception:
        data = {"raw": text[:4000]}

    summary = summarize_check(data, account_id=acc)
    ok = 200 <= resp.status_code < 300
    err = None
    if not ok:
        if isinstance(data, dict) and data.get("detail"):
            err = data.get("detail")
        elif isinstance(data, dict) and data.get("error"):
            err = data.get("error")
        elif "Just a moment" in text or "cf-browser-verification" in text or resp.status_code in {403, 429, 503}:
            # distinguish CF/edge block vs auth failure when possible
            if "unauthorized" in text.lower() or "invalid_token" in text.lower():
                err = text[:300]
            elif "<html" in text.lower():
                err = f"HTTP {resp.status_code}: edge/CF blocked or proxy rejected (non-JSON HTML)"
            else:
                err = text[:300]
        else:
            err = text[:300]
    return {
        "ok": ok,
        "status": resp.status_code,
        "url": CHECK_URL,
        "email": creds.get("email") or "",
        "accountId": acc,
        "deviceId": did,
        "proxyUsed": bool(proxy),
        "backend": backend,
        "summary": summary,
        "data": data,
        "error": err,
    }


if __name__ == "__main__":
    import argparse
    import os
    import sys

    parser = argparse.ArgumentParser(description="Check ChatGPT monthly promo eligibility")
    parser.add_argument("--token", default="", help="access token")
    parser.add_argument("--account-id", default="", help="ChatGPT account id")
    parser.add_argument("--device-id", default="", help="OAI-Device-Id")
    parser.add_argument("--input-file", default="", help="session/auth json file")
    parser.add_argument("--proxy", default=os.environ.get("BROWSER_PROXY", ""))
    args = parser.parse_args()
    raw = None
    if args.input_file:
        raw = open(args.input_file, "r", encoding="utf-8").read()
    try:
        result = check_promo(
            access_token=args.token,
            account_id=args.account_id,
            device_id=args.device_id,
            proxy=args.proxy,
            raw_input=raw,
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result.get("ok") else 2)
