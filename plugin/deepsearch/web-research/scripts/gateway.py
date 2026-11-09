"""Gateway client: healthz precheck (C1) + POST + explicit failure."""
import json
import urllib.error
import urllib.request


class GatewayError(Exception):
    pass


def _post(url, token, payload, timeout):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Gateway-Token": token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def health_check(base_url, timeout=5):
    try:
        req = urllib.request.Request(base_url.rstrip("/") + "/healthz")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def call_gateway(base_url, token, payload, timeout=30):
    try:
        return _post(base_url.rstrip("/") + "/webhook/research-gateway",
                     token, payload, timeout)
    except urllib.error.HTTPError as e:
        raise GatewayError("gateway http %s" % e.code) from e
    except Exception as e:
        raise GatewayError("gateway unreachable: %s" % e) from e
