# AutoTranslate (Thunderbird Add-on)

AutoTranslate automatically translates displayed emails in Thunderbird using Google Translate. Just like how it happens on gmail automatically!

## Install

1. Download `autotranslate.xpi`. or whole repository 
2. Open Thunderbird.
3. Go to **Settings** -> **Add-ons and Themes**.
4. Click the gear icon and choose **Install Add-on From File...**
5. Select `autotranslate.xpi`.
6. Confirm installation.

## How to use

1. Open any email message.
2. AutoTranslate translates it automatically (if enabled).
3. Click the add-on button to open settings.
4. Set your default target language and optional per-language rules.
5. Click **Save**.
6. Use **Translate now** to force translation of the currently open message.

## Notes

- Message text is sent to `https://translate.googleapis.com/` to perform translation.
- Settings are stored locally in Thunderbird (`storage.local`).
