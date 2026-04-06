# Fortress Options — Google Play Store Submission Checklist

Use this checklist in order. Each section must be completed before moving to the next.

---

## Phase 1: Google Play Console Setup

- [ ] **1. Create a Google Play Console account**
  - Go to [play.google.com/console](https://play.google.com/console)
  - Sign in with a Google account (use a dedicated developer account, not personal)
  - Pay the one-time **$25 USD registration fee** (credit/debit card required)
  - Complete identity verification if prompted (may take up to 48 hours)

---

## Phase 2: Create the App

- [ ] **2. Create a new app in Play Console**
  - Click **"Create app"** in the Play Console dashboard
  - **App name:** `Fortress Options`
  - **Default language:** English (United States)
  - **App or game:** App
  - **Free or paid:** Free
  - Check the declarations (developer program policies, US export laws)
  - Click **"Create app"**

---

## Phase 3: Store Listing

- [ ] **3. Fill in the store listing** (use `listing.md` for all copy)
  - Navigate to: **Grow > Store presence > Main store listing**
  - **App name:** Fortress Options
  - **Short description:** `Institutional-grade options plays scored for high-probability setups.`
  - **Full description:** Copy from `listing.md` (full description section)
  - **App icon:** Upload `website/icon-512.png` (512x512 PNG)
  - **Feature graphic:** Upload the 1024x500 PNG (see `screenshots-needed.md` for design spec)
  - **Phone screenshots:** Upload all 6 screenshots (see `screenshots-needed.md`)
  - **Category:** Finance
  - **Tags:** options trading, stock options, bull put spread, options scanner, trading signals, earnings plays
  - **Email address:** `support@fortress-options.com`
  - **Website:** `https://fortress-options.com`
  - **Privacy policy URL:** `https://fortress-options.com/privacy.html`
  - Save the store listing

---

## Phase 4: Upload the APK

- [ ] **4. Upload the signed APK**
  - Navigate to: **Release > Testing > Internal testing** (recommended for first upload) OR **Release > Production**
  - Click **"Create new release"**
  - Upload: `website/fortress-options-v1.7.0.apk`
    - This APK is already signed with the release keystore (`android/fortress-release.keystore`)
    - Version name: `1.6.0` | Version code: `8`
  - Enter release notes (what's new):
    ```
    - AI-scored options plays with 0-10 probability rating
    - Bull put spread recommendations with defined risk
    - Earnings calendar integration
    - Real-time position tracking
    - Push notification alerts for new high-score plays
    - Biometric (fingerprint) login security
    ```
  - Click **"Review release"** then **"Start rollout"**

  > Note: Play Console may prompt you to switch to AAB (Android App Bundle) format. The current APK is accepted but Google prefers AAB for new submissions. The existing signed APK will work for v1.7.0.

---

## Phase 5: Content Rating

- [ ] **5. Complete the content rating questionnaire**
  - Navigate to: **Policy > App content > Content rating**
  - Click **"Start questionnaire"**
  - **Category:** Finance
  - Answer all questions honestly:
    - Violence: No
    - Sexual content: No
    - Profanity: No
    - Controlled substances: No
    - User-generated content: No
    - Location sharing: No
    - Financial transactions in-app: No (subscriptions handled externally via website)
  - **Expected result:** "Everyone" rating (no restrictions)
  - Save and apply the rating

---

## Phase 6: Pricing and Distribution

- [ ] **6. Set up pricing and distribution**
  - Navigate to: **Monetize > Pricing & distribution** (or found under app settings)
  - **Price:** Free
  - **Countries:** Select all countries OR start with United States only for initial launch
  - **Ads:** Does the app contain ads? — No
  - **In-app purchases:** No (subscriptions are purchased externally on the website, not through Google Play Billing)

  > Important: Because Fortress Options links to an external website for subscriptions and does not collect payment inside the app itself, this is compliant with Play Store policies. Do not add any in-app purchase flow through Google Play Billing unless you intend to pay Google's 15–30% commission. The current model (external web subscription) is allowed.

---

## Phase 7: App Content Declarations

- [ ] **7. Complete app content declarations**
  - Navigate to: **Policy > App content**
  - Complete each required section:
    - **Privacy policy:** `https://fortress-options.com/privacy.html`
    - **Ads:** No ads
    - **App access:** App requires login (provide a test account if needed — create a test user on the website for reviewers)
    - **Target audience:** 18+ (Finance app for adult traders)
    - **News app:** No
    - **COVID-19 contact tracing:** No
    - **Data safety:** Complete the data safety form (see note below)

  > Data Safety Form — Answers for Fortress Options:
  > - Data collected: Email address (for authentication), device token (for push notifications)
  > - Data shared with third parties: Firebase (push notifications via FCM)
  > - Data encrypted in transit: Yes
  > - Users can request data deletion: Yes (via support@fortress-options.com)

---

## Phase 8: Target API Level Verification

- [ ] **8. Confirm API level meets Play Store requirements**
  - Play Store currently requires **targetSdkVersion 34** (API 34) for new apps (as of August 2024)
  - Fortress Options build configuration (`android/variables.gradle`):
    - `compileSdkVersion = 34` ✓
    - `targetSdkVersion = 34` ✓
    - `minSdkVersion = 23` (Android 6.0+) ✓
  - **Status: Meets current Play Store requirements.** No changes needed.

  > Watch for: Google will likely raise the requirement to API 35 in late 2025. When that happens, update `targetSdkVersion` in `android/variables.gradle`, rebuild, and re-sign the APK.

---

## Phase 9: Final Review and Submit

- [ ] **9. Review the complete listing**
  - Preview the store listing using the "Preview on device" option in Play Console
  - Verify all text is correct (app name, descriptions, contact info)
  - Verify all graphics are uploaded (icon, feature graphic, screenshots)
  - Check that no required sections show a warning or incomplete status
  - All sections in the left sidebar should show green checkmarks

- [ ] **10. Submit for review**
  - Navigate to the release you created in Phase 4
  - Click **"Submit for review"** (for Production) or promote from Internal Testing to Production
  - Google will review the app — **typical review time: 1–3 business days** for new apps
  - You will receive an email at the developer account address when the review is complete

---

## Phase 10: Post-Submission

- [ ] **11. Monitor review status**
  - Check Play Console dashboard daily for status updates
  - If rejected, read the policy violation reason carefully, fix the issue, and resubmit
  - Common rejection reasons for finance apps:
    - Missing or inaccessible privacy policy page
    - Test account credentials not provided for locked apps
    - Misleading financial claims in the description (ensure disclaimer is present — it is)

- [ ] **12. After approval — verify the live listing**
  - Search "Fortress Options" on the Play Store from a real Android device
  - Download and install the app from the store to confirm it installs correctly
  - Test push notifications, biometric login, and play scoring end-to-end on a fresh install
  - Update the website (fortress-options.com) with a "Download on Google Play" badge and link

---

## Quick Reference

| Item                    | Value                                          |
|-------------------------|------------------------------------------------|
| App name                | Fortress Options                               |
| Package ID              | com.fortress.options                           |
| Version name            | 1.6.0                                          |
| Version code            | 8                                              |
| APK file                | website/fortress-options-v1.7.0.apk           |
| Keystore                | android/fortress-release.keystore              |
| compileSdkVersion       | 34 (API 34)                                    |
| targetSdkVersion        | 34 (API 34) — meets Play requirement           |
| minSdkVersion           | 23 (Android 6.0+)                              |
| Icon file               | website/icon-512.png (512x512 PNG, ready)      |
| Privacy policy          | https://fortress-options.com/privacy.html      |
| Website                 | https://fortress-options.com                   |
| Support email           | support@fortress-options.com                   |
| Revenue model           | Free app, external web subscriptions           |
| Registration fee        | $25 USD (one-time, Google Play Console)        |
| Expected review time    | 1–3 business days                              |

---
