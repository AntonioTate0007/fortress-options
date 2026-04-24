#!/usr/bin/env python3
"""
Fortress Options — Google Play Auto-Deploy
Usage: python3 deploy-play.py [--track internal|alpha|beta|production]
Uploads the latest AAB and creates/updates a release on the specified track.
"""
import sys, os, json, time, argparse

try:
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    from google.oauth2 import service_account
except ImportError:
    print("Installing dependencies...")
    os.system(f"{sys.executable} -m pip install google-api-python-client google-auth -q")
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    from google.oauth2 import service_account

PACKAGE_NAME   = "com.fortress.options"
KEY_FILE       = os.path.join(os.path.dirname(__file__), "play-store-key.json")
AAB_PATH       = os.path.join(os.path.dirname(__file__),
                     "android", "app", "build", "outputs", "bundle", "release", "app-release.aab")
SCOPES         = ["https://www.googleapis.com/auth/androidpublisher"]

def get_version_name():
    gradle = os.path.join(os.path.dirname(__file__), "android", "app", "build.gradle")
    with open(gradle) as f:
        for line in f:
            if "versionName" in line:
                return line.strip().split('"')[1]
    return "unknown"

def deploy(track="internal"):
    print(f"\n[DEPLOY] Deploying to Google Play [{track} track]")
    print(f"   AAB: {AAB_PATH}")

    if not os.path.exists(KEY_FILE):
        print(f"[ERROR] Service account key not found: {KEY_FILE}")
        sys.exit(1)
    if not os.path.exists(AAB_PATH):
        print(f"[ERROR] AAB not found: {AAB_PATH}")
        print("   Run: cd android && ./gradlew bundleRelease")
        sys.exit(1)

    creds = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)
    edits = service.edits()

    # 1. Open edit
    print("   Opening edit...")
    edit = edits.insert(packageName=PACKAGE_NAME, body={}).execute()
    edit_id = edit["id"]
    print(f"   Edit ID: {edit_id}")

    try:
        # 2. Upload AAB
        print("   Uploading AAB...")
        media = MediaFileUpload(AAB_PATH, mimetype="application/octet-stream", resumable=True)
        bundle = edits.bundles().upload(
            packageName=PACKAGE_NAME,
            editId=edit_id,
            media_body=media
        ).execute()
        version_code = bundle["versionCode"]
        version_name = get_version_name()
        print(f"   OK Uploaded versionCode={version_code} versionName={version_name}")

        # 3. Create release on track
        release_notes = f"v{version_name} — Morning routine notifications · Key recovery · Postgres persistence · Google Play distribution"
        track_body = {
            "releases": [{
                "name": f"v{version_name}",
                "versionCodes": [str(version_code)],
                "status": "completed" if track == "production" else "draft",
                "releaseNotes": [{"language": "en-US", "text": f"<en-US>{release_notes}</en-US>"}]
            }]
        }
        print(f"   Setting track release...")
        edits.tracks().update(
            packageName=PACKAGE_NAME,
            editId=edit_id,
            track=track,
            body=track_body
        ).execute()
        print(f"   OK Release set on {track} track")

        # 4. Upload store listing images (best-effort, won't fail the deploy)
        WEBSITE = os.path.join(os.path.dirname(__file__), "website")
        IMAGES = [
            ("icon",             os.path.join(WEBSITE, "icon-512.png")),
            ("featureGraphic",   os.path.join(WEBSITE, "feature-graphic.png")),
            ("phoneScreenshots", os.path.join(WEBSITE, "screenshots", "screenshot1.png")),
            ("phoneScreenshots", os.path.join(WEBSITE, "screenshots", "screenshot2.png")),
            ("phoneScreenshots", os.path.join(WEBSITE, "screenshots", "screenshot3.png")),
            ("phoneScreenshots", os.path.join(WEBSITE, "screenshots", "screenshot4.png")),
            ("phoneScreenshots", os.path.join(WEBSITE, "screenshots", "screenshot5.png")),
        ]
        try:
            edits.images().deleteall(packageName=PACKAGE_NAME, editId=edit_id,
                                     language="en-US", imageType="phoneScreenshots").execute()
        except Exception:
            pass
        for img_type, img_path in IMAGES:
            if not os.path.exists(img_path):
                continue
            try:
                edits.images().upload(
                    packageName=PACKAGE_NAME, editId=edit_id,
                    language="en-US", imageType=img_type,
                    media_body=MediaFileUpload(img_path, mimetype="image/png", resumable=False)
                ).execute()
                print(f"   OK Image: {img_type} ({os.path.basename(img_path)})")
            except Exception as e:
                print(f"   ! Image skip {img_type}: {e}")

        # 5. Commit edit
        print("   Committing edit...")
        result = edits.commit(packageName=PACKAGE_NAME, editId=edit_id).execute()
        print(f"\n[SUCCESS] Deployed! Edit committed: {result.get('id')}")
        print(f"   Track: {track}")
        print(f"   Version: {version_name} ({version_code})")
        print(f"   Play Console: https://play.google.com/console/developers/8631127217260026572/app/4973176502312998250/tracks/{track}-testing")

    except Exception as e:
        # Delete the edit on failure
        try:
            edits.delete(packageName=PACKAGE_NAME, editId=edit_id).execute()
        except:
            pass
        print(f"\n[ERROR] Deploy failed: {e}")
        if "401" in str(e) or "403" in str(e):
            print("\n   [WARN]  Permission error. Complete Play Console setup:")
            print("   1. Go to Play Console > Users and permissions")
            print("   2. Add play-store-publisher@fortress-options.iam.gserviceaccount.com")
            print("   3. Grant: Release to production + Release apps to testing tracks")
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--track", default="internal", choices=["internal", "alpha", "beta", "production"])
    args = parser.parse_args()
    deploy(args.track)
