# Getting JustAsk onto the App Store & Google Play

This covers what's already been set up, and exactly what's left for you to do.
Nothing here needed code changes to `server.js` or the main app logic — this
wraps the existing site in a real native app shell.

## What's already done

- **Capacitor installed and configured** (`capacitor.config.ts`) — app ID
  `com.justask.app`, app name "JustAsk"
- **Android project generated** (`android/` folder) — validated with
  `npx cap doctor`, reported healthy
- **iOS project generated** (`ios/` folder) — the project files are correct,
  but actually building/testing it needs Xcode, which only runs on a Mac.
  That part is genuinely untested from this environment — see below.
- **App icons and splash screens generated** for both platforms, using your
  existing navy/gold ring logo (from `public/icons/icon-512.png`)
- **The app correctly talks to your live server.** When running inside the
  native app, it automatically points API calls at
  `https://justask-com.onrender.com` instead of relying on relative URLs
  (which only work when the page is served from that same domain). This is
  handled automatically in `public/index.html` — no manual step needed.
- **Push notifications plugin installed** (`@capacitor/push-notifications`)
  and synced into both platforms, ready to wire up once you have real
  Firebase/Apple push credentials (see the "Push notifications" section below
  — this is the one piece intentionally left unfinished, since it needs
  accounts that don't exist yet).

## Android — steps for you

1. **Create a Google Play Developer account** — [play.google.com/console/signup](https://play.google.com/console/signup), one-time $25 fee, needs a real identity/business verification (this step has to be you, not me)
2. **Install [Android Studio](https://developer.android.com/studio)** on your computer (Windows, Mac, or Linux all work)
3. Open the `android/` folder in Android Studio (File → Open)
4. Let it sync (first time will download some Android build tools — takes a few minutes)
5. Build → Generate Signed Bundle/APK, create a new signing key (**back this up somewhere safe** — if you lose it, you can never update the app again under the same listing)
6. Upload the resulting `.aab` file to the Play Console, fill in the store listing (see "Store listing assets" below), submit for review

Android review is usually quick (hours to a couple of days) and generally accepts PWA-wrapped apps without issue.

## iOS — steps for you

1. **Create an Apple Developer account** — [developer.apple.com/programs](https://developer.apple.com/programs/enroll/), $99/year, real identity verification required
2. **You need a Mac.** Xcode (Apple's build tool) only runs on macOS — if you don't have one, options are: borrow/buy one, or use a cloud Mac build service (e.g. MacStadium, Codemagic, GitHub Actions with a macOS runner)
3. On the Mac, run `npx cap open ios` from this project (or open `ios/App/App.xcworkspace` directly in Xcode)
4. In Xcode: select your Apple Developer team under Signing & Capabilities, set a version number
5. Product → Archive, then use Xcode's Organizer to upload to App Store Connect
6. In App Store Connect, fill in the store listing, submit for review

**Important honest note:** Apple's App Review Guideline 4.2 specifically targets apps that are "just a website wrapped in a shell." Capacitor apps meaningfully reduce this risk versus a bare wrapper (real native plugin access, not just a WebView pointed at a URL) — but there's no guarantee of approval. If it's rejected, the most common fix is adding a couple more native touches (native push notifications rather than web push is a good one — see below) and resubmitting. The $99/year fee is non-refundable regardless of the outcome.

## Store listing assets (both platforms need these)

- App name, short description, full description
- Screenshots (a few different phone sizes each — Android Studio/Xcode simulators can produce these)
- A **privacy policy URL** — both stores require this, no exceptions. This isn't currently built anywhere on justask-com.onrender.com; worth flagging that this needs writing (and, given the QA notes on this project, probably needs to happen alongside the terms/refund-policy page work that's already been flagged as outstanding).
- A content rating questionnaire (both stores ask a series of questions — straightforward for an app like this)

## Push notifications — next step, not done yet

The web-push system already live on the site (the "🔔 Enable notifications
for this order" button) works today in the browser/PWA install, but does
**not** work inside the native app wrapper — native apps need to go through
Apple's and Google's own push systems (APNs and FCM) instead, which is what
the `@capacitor/push-notifications` plugin (already installed) is for.

To finish this once you have real accounts:
1. Create a Firebase project (free) for Android push, download `google-services.json` into `android/app/`
2. Create an APNs key in your Apple Developer account for iOS push
3. Add client-side registration code (request permission, listen for the device token)
4. Add a new server endpoint to store native device tokens (separate from the existing web-push subscriptions table) and send to them via FCM/APNs instead of web-push

This is a contained, well-understood piece of work — just genuinely blocked on you having the real developer accounts and credentials first, so it's deliberately left for a follow-up rather than half-built now.

## Testing without submitting anything yet

You don't need either developer account just to *try* the app:
- **Android**: Android Studio can run the app directly on an emulator or a phone connected by USB, no Play Console account needed
- **iOS**: Xcode can run the app on the iOS Simulator (no Mac hardware needed beyond the Mac itself) or a real iPhone connected by cable, without an Apple Developer account — device installs just expire after 7 days without one
