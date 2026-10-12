# Fix Gemini Parser

Chrome extension and Tampermonkey userscript for correcting inline Markdown and
LaTeX while Gemini streams a response. Version 5.0.4 uses the same rendering engine
for both distributions.

## Install

For Chrome, download/extract the extension ZIP or clone this repository, open
`chrome://extensions`, enable Developer mode, and use **Load unpacked** to select
the directory containing `manifest.json`. Reload existing Gemini tabs after
installing or updating the extension. The popup controls rendering, individual
formats, colors, opacity, and custom declarations. Changes also reach other open
Gemini tabs through `chrome.storage.onChanged`.

For Tampermonkey, install `user-script.js`. The userscript manager's **Fix Gemini
Parser: Toggle** menu enables/disables rendering and remembers that choice.
Edit `userscript-bootstrap.js` to customize the default format/color settings,
then rebuild the generated script. Its KaTeX and markdown-it dependencies and
fonts use the version-pinned jsDelivr URLs in the metadata. Chrome's distribution
bundles those dependencies and fonts locally.

## Rendering and toggles

The engine never writes to a Gemini paragraph's `innerHTML`, moves its children,
or marks it permanently rendered. It reads the current light DOM and renders a
separate shadow tree attached to a supported text block. Gemini retains the
original Text nodes and can update or replace them normally. The preview takes
space in the paragraph's normal flow, so wrapping, width changes, display math,
and following blocks follow its actual height without coordinate overlays.

While enabled, a clipped, non-interactive, `aria-hidden` slot keeps the original
light DOM available to native text/`innerText` readers. Only the preview is shown
and exposed to accessibility. Turning off removes the preview/styles, cancels
queued work, disconnects observers, and displays the original through a plain
slot. The browser cannot detach a shadow root once created; the root remains with
only that slot while disabled. Original nodes, attributes and event handlers
remain intact. Turning on always scans the current source, including changes
made while off. Finished and streaming responses use the same renderer.

Text/child/attribute mutations enqueue affected blocks. A fixed 40 ms window
coalesces updates without waiting for the entire stream to finish. Whole
container replacement triggers rediscovery and cleanup. Identical snapshots are
not rewritten. Reconciliation retains equal text/formula nodes instead of replacing
the whole preview. New hosts and structural finalization are processed in the
MutationObserver microtask before the next paint; plain token updates keep the
40 ms coalescing window. Gemini's finished inline tokens keep the streaming fonts
and formatting, and known path/index metadata does not trigger a native fallback.
Native inline visibility/opacity and explicit styles are retained. Class/style
changes on ancestors inside the chat also refresh copied styles.
Formatting-setting changes invalidate snapshots, and stylesheets
are shared across projections. Disclaimers are hidden with removable CSS rather
than deleted.

Inline formatting uses markdown-it's balanced delimiters, with a narrow repair
for punctuation-ended emphasis/strike immediately followed by Korean suffixes.
Identifier underscores keep the tokenizer's normal word rules. Literal HTML
entity spellings are preserved because the input is already DOM text. Inline
code and math are opaque to other formatting, including when their formatting toggle is off.
Inline code has its own background, spacing, and font inside the shadow tree,
using inherited Gemini theme variables throughout streaming and finalization.
Color/opacity/custom CSS overrides still apply; disabling code repair preserves
native code box styles when other formats keep the paragraph projected.
Unfinished code/math stays literal until closed, and unfinished emphasis follows
the inline tokenizer's literal fallback. Nested literal `<u>` pairs skip tag
spellings inside code/math. Closed code normalizes line breaks and edge spaces before Gemini finalizes it.
Inline dollar math rejects whitespace boundaries and closing dollars followed
by digits to avoid pairing prices; an unmatched plain numeric price does not
block later emphasis. Dollar notation remains ambiguous for unusual prose.
Valid `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` render with
KaTeX's DOM renderer and MathML; invalid math stays literal. Text is built with
DOM APIs, without raw HTML injection or a Trusted Types policy. KaTeX font faces
are registered at document scope and its layout styles at shadow scope.

## Supported scope

The engine operates on `p`, `h1`–`h6`, and existing direct `span` children of
`td`/`th` in `.chat-container`, excluding known user
query/editor/footer/code regions. Simple native inline formatting is retained.
Adjacent text nodes and spans carrying only Gemini path/index/Angular metadata
can form one Markdown token.

Blocks containing attachments, links, citations, unrecognized native math, buttons, unknown
components, or interactive/unknown inline attributes remain entirely native.
If those arrive during streaming, an existing preview immediately falls back to
the original slot on the next rendering batch. Recognized inert `span.math-inline`
elements with `data-math` are read as expressions and rendered by our own KaTeX,
including after Gemini finalizes the source. Their descendants are never cloned;
formulas containing interactive descendants still fall back to native display.
Another component's shadow root
is never taken over. Gemini's existing table-cell spans host the same streaming
preview as paragraphs, including math, native bold, inline code, and color settings.
The table/cells and their content nodes are never wrapped, moved, or replaced;
column layout, merged cells, scrolling, and native copy data remain owned by Gemini.
Cell hosts with interactive/unknown attributes or unsafe descendants stay native.
Bare `td`/`th` text stays native because those tags cannot host shadow roots;
supported paragraphs/headings inside cells can also be rendered. Delimiters are
not joined across separate cell spans or across cells.
Markdown delimiters crossing styled native elements are processed per text run,
not across those element boundaries. This is an inline repair tool, not a full
replacement for Gemini's block Markdown renderer.

The automated tests use simulated Gemini DOM updates and a real installed MV3
extension against an intercepted `gemini.google.com` fixture. They do not submit
prompts to live Gemini or verify its current private selectors, virtualization,
auto-scroll implementation, or native response-copy button.

## Develop and verify

Node.js 20+ is required for development. Runtime distributions do not require
Node.js or an npm install.

```sh
npm ci
npx playwright install --with-deps chromium
npm run build:userscript
npm run check:userscript
npm test
```

`parser-engine.js` is the shared implementation. `content.js` is the Chrome
storage/resource adapter. `user-script.js` is generated from the engine and
`userscript-bootstrap.js`; do not edit the generated engine copy manually.

The browser tests cover retained source identity, cumulative token updates,
partial delimiters, regeneration, SPA replacement, mid-stream toggles, colors,
native interaction fallback, layout, selection/accessibility, font loading,
Trusted Types, both adapters, and real popup/storage integration. The MV3 test
uses a temporary browser profile under ignored `test-results/` and removes it.
`CHROME_PATH` can override the browser for engine tests;
`EXTENSION_CHROME_PATH` overrides it for the MV3 test and must support extension
sideloading.

Vendored dependencies: KaTeX 0.16.9 and markdown-it 14.1.0. Their licenses are in
`lib/LICENSE.katex` and `lib/LICENSE.markdown-it`.
