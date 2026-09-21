import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("oauth_probe", pathlib.Path(__file__).parents[1] / "scripts" / "oauth-health-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Response:
    def __init__(self, status, payload=None):
        self.status_code = status
        self.payload = payload or {}

    def json(self):
        return self.payload


class Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)


class ProbeTest(unittest.TestCase):
    def payload(self):
        return {"accessToken": "fake-at", "refreshToken": "fake-rt", "idToken": "fake-id", "meUrl": "http://offline/me", "tokenUrl": "http://offline/token"}

    def test_healthy_at_never_uses_refresh(self):
        session = Session([Response(200)])
        result = probe.probe(self.payload(), session)
        self.assertEqual(result["status"], "alive")
        self.assertEqual(result["refreshStatus"], "unused")
        self.assertEqual(len(session.calls), 1)
        self.assertNotIn("rotatedTokens", result)

    def test_only_401_or_missing_at_can_refresh(self):
        for status in (403, 429, 500, 302):
            session = Session([Response(status)])
            self.assertEqual(probe.probe(self.payload(), session)["status"], "error")
            self.assertEqual(len(session.calls), 1)
        session = Session([Response(401), Response(200, {"access_token": "refreshed-at", "refresh_token": "refreshed-rt"}), Response(200)])
        result = probe.probe(self.payload(), session)
        self.assertEqual([call[0] for call in session.calls], ["GET", "POST", "GET"])
        self.assertEqual(result["rotatedTokens"], {"accessToken": "refreshed-at", "refreshToken": "refreshed-rt", "idToken": "fake-id"})
        self.assertTrue(all(call[2]["allow_redirects"] is False for call in session.calls))

    def test_unverified_refresh_not_returned(self):
        for status in (401, 403, 500):
            session = Session([Response(401), Response(200, {"access_token": "unverified-secret"}), Response(status)])
            result = probe.probe(self.payload(), session)
            self.assertNotIn("rotatedTokens", result)
            self.assertNotIn("unverified-secret", str(result))
            self.assertEqual(len(session.calls), 3)

    def test_explicit_invalid_refresh_does_not_echo_error_body(self):
        session = Session([Response(401), Response(400, {"error_description": "invalid_grant sensitive-secret"})])
        result = probe.probe(self.payload(), session)
        self.assertEqual(result["status"], "dead")
        self.assertEqual(result["refreshStatus"], "invalid")
        self.assertNotIn("sensitive-secret", str(result))
        self.assertEqual(len(session.calls), 2)

    def test_missing_at_and_network_failure_are_bounded(self):
        payload = self.payload()
        payload["accessToken"] = ""
        session = Session([Response(200, {"access_token": "refreshed"}), Response(200)])
        self.assertEqual(probe.probe(payload, session)["status"], "alive")
        self.assertEqual(len(session.calls), 2)
        session = Session([RuntimeError("proxy-password-and-token")])
        result = probe.probe(self.payload(), session)
        self.assertEqual(result["detail"], "oauth_transport_error")
        self.assertEqual(len(session.calls), 1)
        self.assertNotIn("password", str(result))


if __name__ == "__main__":
    unittest.main()
