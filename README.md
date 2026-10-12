# Fix Gemini Parser

Fix inline Markdown and LaTeX rendering in Google Gemini, including while responses stream.
Available as a Chrome extension and a Tampermonkey userscript.

## Features

- Repairs bold, italic, strikethrough, underline, inline code, and LaTeX.
- Works in paragraphs, headings, and supported table cells.
- Preserves Gemini’s original content, with reversible toggles during streaming.
- Custom colors, opacity, and CSS settings through the extension popup.

## Install

**Chrome:** [Chrome Web Store](https://chromewebstore.google.com/detail/ekaohoolbnjjienkcfhehflebgknpggl).
For manual installation, extract the ZIP from [Releases](https://github.com/kangjoseph90/fix-gemini-parser/releases/latest),
open `chrome://extensions`, enable **Developer mode**, and **Load unpacked**.
Select the folder containing `manifest.json`, then reload your Gemini tabs.

**Tampermonkey:** Install [fix-gemini-parser.user.js](https://github.com/kangjoseph90/fix-gemini-parser/releases/latest/download/fix-gemini-parser.user.js).
Use the **Fix Gemini Parser: Toggle** userscript menu to turn it on or off.

## Notes

This repairs inline formatting, not Gemini’s entire Markdown renderer.
Content with links, citations, interactive elements, or unsupported structures stays native.

## Development

See [development and rendering details](docs/development.md) for setup, tests,
supported syntax, and implementation notes.
