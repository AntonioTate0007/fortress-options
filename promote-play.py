#!/usr/bin/env python3
"""Promote a release from internal track to production on Google Play."""
import sys, os

try:
    from googleapiclient.discovery import build
    from google.oauth2 import service_account
except ImportError:
    os.system(f"{sys.executable} -m pip install google-api-python-client google-auth -q")
    from googleapiclient.discovery import build
    from google.oauth2 import service_account

PACKAGE_NAME = "com.fortress.options"
KEY_FILE     = os.path.join(os.path.dirname(__file__), "play-store-key.json")
SCOPES       = ["https://www.googleapis.com/auth/androidpublisher"]

def promote(from_track="internal", to_track="production"):
    print(f"[PROMOTE] {from_track} -> {to_track}")
    creds   = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)
    edits   = service.edits()

    edit    = edits.insert(packageName=PACKAGE_NAME, body={}).execute()
    edit_id = edit["id"]
    print(f"   Edit ID: {edit_id}")

    try:
        # Get current internal track to find version codes
        src = edits.tracks().get(packageName=PACKAGE_NAME, editId=edit_id, track=from_track).execute()
        releases = src.get("releases", [])
        if not releases:
            print(f"[ERROR] No releases found on {from_track} track")
            sys.exit(1)

        latest = releases[0]
        version_codes = latest.get("versionCodes", [])
        version_name  = latest.get("name", "")
        print(f"   Found: {version_name} versionCodes={version_codes}")

        # Set on production track
        track_body = {
            "releases": [{
                "name": version_name,
                "versionCodes": version_codes,
                "status": "completed",
                "releaseNotes": latest.get("releaseNotes", [{"language": "en-US", "text": "Bug fixes and improvements."}])
            }]
        }
        edits.tracks().update(
            packageName=PACKAGE_NAME, editId=edit_id,
            track=to_track, body=track_body
        ).execute()
        print(f"   OK Set on {to_track} track")

        result = edits.commit(packageName=PACKAGE_NAME, editId=edit_id).execute()
        print(f"\n[SUCCESS] Promoted to {to_track}! Edit: {result.get('id')}")
        print(f"   Version: {version_name}")
        print(f"   Play Console: https://play.google.com/console")

    except Exception as e:
        try:
            edits.delete(packageName=PACKAGE_NAME, editId=edit_id).execute()
        except:
            pass
        print(f"\n[ERROR] Promote failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--from-track", default="internal")
    p.add_argument("--to-track",   default="production")
    args = p.parse_args()
    promote(args.from_track, args.to_track)
