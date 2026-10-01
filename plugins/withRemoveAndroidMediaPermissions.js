// TWV-PLAY-2026 — strip photo/video permissions injected both by
// `expo-media-library` config plugin (which uses `withPermissions` to add
// READ_MEDIA_IMAGES/VIDEO/AUDIO directly into the app manifest) and by
// `expo-screen-capture` library manifest (READ_MEDIA_IMAGES).
//
// The wallet saves QR codes via `MediaLibrary.saveToLibraryAsync` (write-only,
// no READ_MEDIA_* required) and picks images via `expo-image-picker` which
// uses the Android system photo picker — no READ_MEDIA_IMAGES required on
// Android 13+. All three permissions are dead weight and fail Google Play's
// photo-and-video permissions policy review.
//
// Strategy: first delete any plain declarations injected by other plugins,
// then add `tools:node="remove"` markers so the manifest merger also strips
// whatever the library AndroidManifest.xml files declare.

const { withAndroidManifest } = require("expo/config-plugins");

const TOOLS_NS_URI = "http://schemas.android.com/tools";

// Contacts: the pulsa/data picker uses the permission-free system picker
// (modules/phone-contact-picker on Android), but the auto-applied
// `expo-contacts` config plugin still injects both permissions. Play's
// Contacts Permission policy (SDK 37+, 2027-01-27) requires a declaration
// for READ_CONTACTS; nothing here reads the address book.
const PERMISSIONS_TO_REMOVE = [
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_AUDIO",
];

module.exports = function withRemoveAndroidMediaPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    manifest.$ = manifest.$ || {};
    if (!manifest.$["xmlns:tools"]) {
      manifest.$["xmlns:tools"] = TOOLS_NS_URI;
    }

    manifest["uses-permission"] = manifest["uses-permission"] || [];

    // Step 1: delete any plain declarations for these permissions so that
    // a prior plugin's `withPermissions` call doesn't leave an explicit entry
    // that would win over the tools:node="remove" marker below.
    manifest["uses-permission"] = manifest["uses-permission"].filter(
      (p) =>
        !PERMISSIONS_TO_REMOVE.includes(p?.$?.["android:name"]) ||
        p?.$?.["tools:node"] === "remove",
    );

    // Step 2: add tools:node="remove" markers so the Gradle manifest merger
    // strips the same permissions from library AndroidManifest.xml files.
    for (const name of PERMISSIONS_TO_REMOVE) {
      const already = manifest["uses-permission"].find(
        (p) =>
          p?.$?.["android:name"] === name && p?.$?.["tools:node"] === "remove",
      );
      if (already) continue;
      manifest["uses-permission"].push({
        $: {
          "android:name": name,
          "tools:node": "remove",
        },
      });
    }

    return cfg;
  });
};
