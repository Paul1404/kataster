#!/usr/bin/env python3
"""Fail for fixable HIGH/CRITICAL image CVEs; retain and summarize all findings."""
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    report = json.load(source)
findings = [v for result in report.get("Results", []) for v in result.get("Vulnerabilities", []) or []]
blocking = [v for v in findings if v.get("Severity") in ("HIGH", "CRITICAL") and v.get("FixedVersion")]
unfixed = [v for v in findings if v.get("Severity") in ("HIGH", "CRITICAL") and not v.get("FixedVersion")]
print(f"Image findings: {len(findings)} total, {len(blocking)} fixable HIGH/CRITICAL, {len(unfixed)} HIGH/CRITICAL without a listed distribution fix")
for v in blocking + unfixed:
    print(f"{v.get('VulnerabilityID')} {v.get('PkgName')} {v.get('InstalledVersion')} -> {v.get('FixedVersion') or 'no fixed version listed for this distribution'}")
if unfixed:
    print("::warning::HIGH/CRITICAL findings without a listed distribution fix remain in the retained image report.")
sys.exit(1 if blocking else 0)
