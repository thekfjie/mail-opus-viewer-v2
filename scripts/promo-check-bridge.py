#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import uuid
from typing import Any
from urllib.parse import urlencode

from chatgpt_promo_check import (  # noqa: E402
    build_check_headers,
    cffi_requests,
    check_promo,
    normalize_proxy_url,
    requests,
    transport_error_message,
)


COUPON_URL = "https://chatgpt.com/backend-api/promo_campaign/check_coupon"
INELIGIBLE_STATES = {"ineligible", "not_eligible", "invalid", "expired", "redeemed", "offline"}


def _coupon_check(
    *,
    access_token: str,
    account_id: str,
    device_id: str,
    campaign: str,
    proxy: str,
    timeout: int,
) -> dict[str, Any]:
    referer = f"https://chatgpt.com/?promo_campaign={campaign}"
    headers = build_check_headers(access_token, account_id, device_id)
    headers.update({
        "Accept": "*/*",
        "Referer": referer,
        "oai-language": "en-US",
        "oai-session-id": str(uuid.uuid4()),
        "oai-client-version": "prod-protocol-bootstrap",
        "oai-client-build-number": "9114028",
    })
    url = f"{COUPON_URL}?{urlencode({'coupon': campaign, 'is_coupon_from_query_param': 'true'})}"
    proxies = {"http": proxy, "https": proxy} if proxy else None
    response = None
    backend = "requests"
    try:
        if cffi_requests is not None:
            session = cffi_requests.Session(impersonate="chrome131", proxies=proxies, timeout=timeout)
            response = session.get(url, headers=headers)
            backend = "curl_cffi"
        elif requests is not None:
            response = requests.get(url, headers=headers, proxies=proxies, timeout=timeout)
        else:
            raise RuntimeError("优惠 coupon 检测缺少可用的 HTTP 客户端")
    except Exception as error:
        return {
            "campaign": campaign,
            "status": 0,
            "state": "",
            "eligible": None,
            "errorClass": "transport_error",
            "detail": transport_error_message(error, proxy_used=bool(proxy)),
            "backend": backend,
        }

    status = int(getattr(response, "status_code", 0) or 0)
    raw_text = str(getattr(response, "text", "") or "")
    try:
        body = response.json()
    except Exception:
        body = {}
    body = body if isinstance(body, dict) else {}
    state = str(body.get("state") or body.get("coupon_state") or "").strip().lower()
    redemption = body.get("redemption") if isinstance(body.get("redemption"), dict) else {}
    redeemed = bool(
        body.get("redeemed")
        or body.get("redeemed_by_user")
        or redemption.get("redeemed")
        or redemption.get("redeemed_by_user")
    )
    explicit_eligible = body.get("eligible") is True or state == "eligible"
    explicit_ineligible = body.get("eligible") is False or state in INELIGIBLE_STATES or redeemed
    eligible: bool | None = None
    if status == 200 and explicit_eligible and not redeemed:
        eligible = True
    elif status == 200 and explicit_ineligible:
        eligible = False
    lower = raw_text.lower()
    error_class = ""
    if status == 401 and ("unauthor" in lower or "invalid" in lower or "expired" in lower):
        error_class = "credential_invalid"
    elif eligible is None:
        error_class = "coupon_unknown" if status == 200 else "coupon_http"
    detail = str(body.get("reason") or body.get("detail") or body.get("message") or "").strip()[:300]
    if not detail:
        detail = f"check_coupon state={state or 'unknown'} HTTP {status}"
    return {
        "campaign": str(body.get("promo_id") or body.get("campaign_id") or campaign).strip(),
        "requestedCampaign": campaign,
        "status": status,
        "state": state,
        "eligible": eligible,
        "redeemed": redeemed,
        "errorClass": error_class,
        "detail": detail,
        "backend": backend,
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = check_promo(
            access_token=str(payload.get("accessToken") or ""),
            account_id=str(payload.get("accountId") or ""),
            email=str(payload.get("email") or ""),
            proxy=str(payload.get("proxy") or ""),
            timeout=max(10, min(120, int(payload.get("timeout") or 30))),
        )
        candidates = []
        seen = set()
        for value in payload.get("campaigns") or []:
            campaign = str(value or "").strip()
            if campaign and campaign not in seen:
                seen.add(campaign)
                candidates.append(campaign)
        summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
        catalog = summary.get("eligiblePromoCampaigns")
        if isinstance(catalog, dict):
            catalog_values = catalog.values()
        elif isinstance(catalog, list):
            catalog_values = catalog
        else:
            catalog_values = []
        for value in catalog_values:
            if isinstance(value, dict):
                campaign = str(value.get("id") or value.get("campaign_id") or "").strip()
            else:
                campaign = str(value or "").strip()
            if campaign and campaign not in seen:
                seen.add(campaign)
                candidates.append(campaign)
        candidates = candidates[:50]
        proxy = normalize_proxy_url(str(payload.get("proxy") or ""))
        timeout = max(5, min(15, int(payload.get("timeout") or 30)))
        device_id = str(result.get("deviceId") or uuid.uuid4())
        coupon_checks = []
        # Account jobs already run concurrently in the Node queue. Keep the
        # coupon checks inside one account serial so a four-account batch does
        # not fan out into sixteen simultaneous requests through one JP exit.
        for campaign in candidates:
            coupon_checks.append(_coupon_check(
                    access_token=str(payload.get("accessToken") or ""),
                    account_id=str(payload.get("accountId") or ""),
                    device_id=device_id,
                    campaign=campaign,
                    proxy=proxy,
                    timeout=timeout,
                ))
        result["couponChecks"] = sorted(coupon_checks, key=lambda item: str(item.get("requestedCampaign") or ""))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "status": 0, "error": str(error)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
