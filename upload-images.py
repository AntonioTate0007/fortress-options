#!/usr/bin/env python3
"""
Upload store listing graphics to Google Play via API.
Uploads: icon, feature graphic, phone screenshots.
"""
import sys, os

try:
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    from google.oauth2 import service_account
except ImportError:
    os.system(f"{sys.executable} -m pip install google-api-python-client google-auth -q")
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    from google.oauth2 import service_account

PACKAGE_NAME = "com.fortress.options"
KEY_FILE     = os.path.join(os.path.dirname(__file__), "play-store-key.json")
SCOPES       = ["https://www.googleapis.com/auth/androidpublisher"]

BASE = os.path.join(os.path.dirname(__file__), "website")
ASSETS = [
    ("icon",           os.path.join(BASE, "icon-512.png"),            "image/png"),
    ("featureGraphic", os.path.join(BASE, "feature-graphic.png"),     "image/png"),
    ("phoneScreenshots", os.path.join(BASE, "screenshots", "screenshot1.png"), "image/png"),
    ("phoneScreenshots", os.path.join(BASE, "screenshots", "screenshot2.png"), "image/png"),
    ("phoneScreenshots", os.path.join(BASE, "screenshots", "screenshot3.png"), "image/png"),
    ("phoneScreenshots", os.path.join(BASE, "screenshots", "screenshot4.png"), "image/png"),
    ("phoneScreenshots", os.path.join(BASE, "screenshots", "screenshot5.png"), "image/png"),
]

def main():
    print("\nUploading store listing graphics to Google Play...")
    creds   = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)
    edits   = service.edits()

    print("  Opening edit...")
    edit    = edits.insert(packageName=PACKAGE_NAME, body={}).execute()
    edit_id = edit["id"]
    print(f"  Edit ID: {edit_id}")

    try:
        # Clear existing screenshots first to avoid duplicates
        print("  Clearing existing phoneScreenshots...")
        try:
            edits.images().deleteall(
                packageName=PACKAGE_NAME, editId=edit_id,
                language="en-US", imageType="phoneScreenshots"
            ).execute()
        except Exception as e:
            print(f"  (no existing screenshots to clear: {e})")

        for image_type, path, mime in ASSETS:
            fname = os.path.basename(path)
            print(f"  Uploading {image_type}: {fname}...", end=" ")
            media = MediaFileUpload(path, mimetype=mime, resumable=False)
            result = edits.images().upload(
                packageName=PACKAGE_NAME,
                editId=edit_id,
                language="en-US",
                imageType=image_type,
                media_body=media
            ).execute()
            img = result.get("image", {})
            print(f"OK (id={img.get('id','?')[:12]}...)")

        print("  Committing edit...")
        edits.commit(packageName=PACKAGE_NAME, editId=edit_id).execute()
        print("\nAll graphics uploaded successfully!")

    except Exception as e:
        try:
            edits.delete(packageName=PACKAGE_NAME, editId=edit_id).execute()
        except:
            pass
        print(f"\nFailed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
