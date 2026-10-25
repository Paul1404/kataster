#!/usr/bin/env python3
"""Export a whitelisted infrastructure snapshot. Never export secrets or mail content."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import urllib.request


def command(argv):
    result = subprocess.run(argv, cwd="/", capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Inventory command failed: " + argv[0])
    return result.stdout


def stalwart_accounts(secret_file):
    body = {"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": [["x:Account/get", {"properties": ["name", "description", "emailAddress", "usedDiskQuota"]}, "inventory"]]}
    req = urllib.request.Request("http://127.0.0.1:8080/jmap/", json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + Path(secret_file).read_text().strip()})
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.load(response)
    method, result, _ = data["methodResponses"][0]
    if method != "x:Account/get" or "list" not in result or result.get("notFound"):
        raise RuntimeError("Stalwart inventory incomplete")
    return result["list"]


def collect(config):
    accounts = stalwart_accounts(config["stalwartSecretFile"])
    mailboxes = []
    for account in accounts:
        if account.get("name") in config.get("excludedAccounts", ["admin"]):
            continue
        address = account.get("emailAddress")
        if not address or "@" not in address:
            raise RuntimeError("Mailbox address missing")
        mailboxes.append({"address": address.lower(), "name": account.get("description") or address, "usedBytes": int(account.get("usedDiskQuota", 0))})
    containers = []
    for site in config["sites"]:
        user = pwd.getpwnam(site["user"])
        rows = json.loads(command(["runuser", "-u", user.pw_name, "--", "env", "HOME=" + user.pw_dir, "XDG_RUNTIME_DIR=/run/user/" + str(user.pw_uid), "podman", "ps", "--all", "--format", "json"]))
        # An empty list may be legitimate, but must never be mistaken for a
        # failed read. command() raises on permission/transport failures.
        for row in rows:
            names = row.get("Names") or []
            if len(names) != 1:
                raise RuntimeError("Unexpected container identity")
            state = row.get("State")
            container = {"name": names[0], "site": site["user"], "state": state if state in ["running", "stopped", "paused"] else "unknown", "image": row["Image"]}
            if site.get("domain"):
                container["domain"] = site["domain"]
            containers.append(container)
    backup_path = Path(config["backupStatusFile"])
    backup = json.loads(backup_path.read_text()) if backup_path.exists() else {}
    os_release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    result = {"hostname": socket.getfqdn().lower(), "observedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "os": os_release.get("PRETTY_NAME", "Linux").strip('"'), "mailboxes": mailboxes, "containers": containers, "backup": {"lastSuccessAt": backup.get("finished_at"), "snapshotId": backup.get("snapshot_id"), "accountCount": len(backup.get("accounts", {})), "packedBytes": int(backup.get("data_added_packed", 0))}}
    for name in ["hostMonthlyCents", "backupMonthlyCents"]:
        if name in config:
            result[name] = config[name]
    if result["hostname"] != config["hostname"]:
        raise RuntimeError("Host identity mismatch")
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/kataster-exporter.json")
    parser.add_argument("--collect-only", action="store_true")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    snapshot = collect(config)
    if args.collect_only:
        print(json.dumps(snapshot))
        return
    endpoint = config["endpoint"]
    if not endpoint.startswith("https://"):
        raise RuntimeError("HTTPS required")
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "sync_host_inventory", "arguments": {"snapshot": snapshot}}}
    request = urllib.request.Request(endpoint, json.dumps(body).encode(), {"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + config["token"]})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
        answer = json.load(response)
    if answer.get("error") or answer.get("result", {}).get("isError"):
        raise RuntimeError("Kataster inventory update rejected")
    # Counts only: journal must not contain the credential, mailbox addresses,
    # site data, provider responses or the full snapshot.
    status = {"observedAt": snapshot["observedAt"], "mailboxes": len(snapshot["mailboxes"]), "containers": len(snapshot["containers"])}
    state = Path("/var/lib/kataster-exporter")
    state.mkdir(mode=0o700, exist_ok=True)
    tmp = state / "last-success.tmp"
    tmp.write_text(json.dumps(status))
    tmp.chmod(0o600)
    os.replace(tmp, state / "last-success.json")
    print(json.dumps(status))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("Host inventory export failed: " + type(error).__name__)
