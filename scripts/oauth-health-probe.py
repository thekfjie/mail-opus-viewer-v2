#!/usr/bin/env python3
"""V1 AT-first probe, owned by V2; credentials travel only through pipes."""
import base64
import json
import sys
from urllib.parse import quote


def proxy_url(raw):
    raw = str(raw or "").strip()
    if not raw or "://" in raw:
        return raw
    parts = raw.split(":")
    if len(parts) >= 4 and parts[1].isdigit():
        host, port, user = parts[:3]
        return "http://%s:%s@%s:%s" % (quote(user, safe="-._~"), quote(":".join(parts[3:]), safe="-._~"), host, port)
    return "http://" + raw


def claims(token):
    try:
        part = str(token or "").split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (ValueError, IndexError):
        return {}


def result(status, access_status, refresh_status, detail, rotated=None):
    value = {"status": status, "accessStatus": access_status, "refreshStatus": refresh_status, "detail": detail}
    if rotated:
        value["rotatedTokens"] = rotated
    return value


def probe(payload, session):
    access = str(payload.get("accessToken") or "").strip()
    refresh = str(payload.get("refreshToken") or "").strip()
    identity = str(payload.get("idToken") or "").strip()
    access_status = "unknown" if access else "missing"
    refresh_status = "unused" if refresh else "missing"
    timeout = min(35, max(1, int(payload.get("timeout") or 35)))
    me_url = payload.get("meUrl") or "https://chatgpt.com/backend-api/me"
    headers = {"Accept": "application/json", "Authorization": "Bearer " + access,
               "Content-Type": "application/json", "Origin": "https://chatgpt.com", "Referer": "https://chatgpt.com/"}
    try:
        if access:
            response = session.get(me_url, headers=headers, timeout=timeout, allow_redirects=False)
            if response.status_code == 200:
                return result("alive", "alive", refresh_status, "stored_at_verified")
            if response.status_code != 401:
                return result("error", "unknown", refresh_status, "at_http_%s" % response.status_code)
            access_status = "invalid"
        if not refresh:
            return result("dead", access_status, "missing", "no_usable_at_or_rt")
        token_claims = claims(access or identity)
        client_id = str(token_claims.get("client_id") or token_claims.get("azp") or payload.get("clientId") or "app_EMoamEEZ73f0CkXaXp7hrann")
        response = session.post(payload.get("tokenUrl") or "https://auth.openai.com/oauth/token",
                                headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
                                         "Origin": "https://auth.openai.com", "Referer": "https://auth.openai.com/"},
                                data={"grant_type": "refresh_token", "client_id": client_id, "refresh_token": refresh},
                                timeout=timeout, allow_redirects=False)
        try:
            data = response.json()
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        if response.status_code != 200 or not data.get("access_token"):
            reason = str(data.get("error_description") or data.get("error") or data.get("message") or "").lower()
            invalid = any(value in reason for value in ("invalid_grant", "invalid refresh", "refresh_token_invalidated", "session has ended", "expired", "revoked"))
            return result("dead" if invalid else "error", access_status, "invalid" if invalid else "unknown", "rt_http_%s" % response.status_code)
        access = str(data["access_token"])
        refresh = str(data.get("refresh_token") or refresh)
        identity = str(data.get("id_token") or identity)
        headers["Authorization"] = "Bearer " + access
        verified = session.get(me_url, headers=headers, timeout=timeout, allow_redirects=False)
        if verified.status_code == 200:
            return result("alive", "alive", "alive", "refreshed_at_verified",
                          {"accessToken": access, "refreshToken": refresh, "idToken": identity})
        return result("dead" if verified.status_code == 401 else "error", "invalid" if verified.status_code == 401 else "unknown", "alive", "refreshed_at_http_%s" % verified.status_code)
    except Exception:
        # Exception strings can contain request headers, proxy passwords or tokens.
        return result("error", access_status, refresh_status, "oauth_transport_error")


def main():
    from curl_cffi import requests
    payload = json.load(sys.stdin)
    session = requests.Session(impersonate="chrome136")
    session.trust_env = False
    proxy = proxy_url(payload.get("proxy"))
    session.proxies = {"http": proxy, "https": proxy} if proxy else {}
    try:
        print(json.dumps(probe(payload, session)))
    finally:
        session.close()


if __name__ == "__main__":
    main()
