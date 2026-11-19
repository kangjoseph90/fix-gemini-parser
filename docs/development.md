# Development and rendering details

[Back to README](../README.md)

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
queued work, disconnects parsing observers, and displays the original through a plain
slot. The browser cannot detach a shadow root once created; the root remains with
only that slot while disabled. Original nodes, attributes and event handlers
remain intact. Turning on always scans the current source, including changes
made while off. Finished and streaming responses use the same renderer.
Roots use manual slot assignment. A minimal per-host observer watches only direct
child-list changes during native passthrough (disabled, fallback, or destroyed),
so new source children remain visible. It performs no parsing or scheduled work.

Text/child/attribute mutations enqueue affected blocks. A fixed 40 ms window
coalesces updates without waiting for the entire stream to finish. Whole
container replacement triggers rediscovery and cleanup. Identical snapshots are
not rewritten. Reconciliation retains equal text/formula nodes instead of replacing
the whole preview. New hosts and structural finalization are processed in the
MutationObserver microtask before the next paint; plain token updates keep the
40 ms coalescing window. Gemini's finished inline tokens keep the streaming fonts
and formatting, and known path/index metadata does not trigger a native fallback.
New native children are assigned to their original slot before computed styles
are measured, including ancestors of nested projections. Unassigned light-DOM
children in a manual shadow root otherwise return missing presentation values.

Animated Markdown paragraphs start projected before their first complete format
token and retain that projection through temporary plain text or split delimiters.
The preview displays the latest DOM batch directly: Gemini's pending/animating
word-reveal presentation is normalized only in copied text, instead of sampling
animated opacity or switching back to the native fade queue. Original nodes,
classes, CSS animations, and live widget slots remain unchanged. Explicit inline
opacity/display and unrelated visibility styles are preserved; disabling restores
Gemini's current native reveal state.

Native inline visibility/opacity and explicit styles are retained. Class/style
changes on ancestors inside the chat, stylesheet insertion/removal/text updates,
stylesheet load, and viewport changes also refresh copied styles. Inert presentation
spans retain computed CSS and dir/lang while delimiters can cross their boundaries.
Boxed spans keep one native-style wrapper so padding/backgrounds and block layout
are not repeated for each token.
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
by digits to avoid pairing prices; an unmatched plain numeric price, including `/month` or `/월` unit suffixes, does not
block later emphasis. Dollar notation remains ambiguous for unusual prose.
Valid `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` render with
KaTeX's DOM renderer and MathML; invalid math stays literal. Text is built with
DOM APIs, without raw HTML injection or a Trusted Types policy. KaTeX font faces
are registered at document scope and its layout styles at shadow scope.

## Supported scope

The engine operates on `p`, `h1`–`h6`, and existing direct `span` children of
`td`/`th` in `.chat-container`, excluding known user query/editor/footer/code
regions. Simple native inline formatting, `sup`, `sub`, and `mark` are retained.
Adjacent text nodes and inert presentation spans can form one Markdown token,
including spans with dir/lang and sanitizer metadata such as `data-sourcepos`.
Semantic format/code/math boundaries and live widgets remain tokenizer boundaries.

Live widgets, links, controls, and unknown/interactive inline attributes are
slotted through at their original positions. Original nodes, attributes,
parents, handlers, and component lifecycle remain intact; surrounding text still
receives repair and configured colors. Their internals stay opaque. A supported
existing span containing both text and a nested widget gets its own projection,
processed before its parent projection. Outer projections slot that original
span; no native node is wrapped or moved. Unsupported inner hosts remain live as
a unit. Stable manual assignments display each original widget once without
writing `slot` attributes or reconnecting its component.

Recognized inert `span.math-inline`, `span.math-block`, `math-inline`, and
`math-block` elements with `data-math` are read as expressions and rendered by our
own KaTeX, including after Gemini finalizes the source. Display mode remains
stable. Their descendants are not cloned; formulas with interactive descendants
remain live. Another component's shadow root is never taken over. MathML stays
available to assistive technology but cannot be mouse-selected, preventing the
hidden MathML and visible formula from being copied twice.

Table-cell spans host the same preview as paragraphs. The table/cells and their
content nodes are never wrapped, moved, or replaced; column layout, merged cells,
scrolling, and native response/table copy data remain owned by Gemini. Interactive
cell hosts stay native. Bare `td`/`th` text stays native because those tags cannot
host shadow roots. Delimiters are not joined across cells. Bare text-only `li`
content is projected through its existing supported direct list parent
(`div`, `section`, `article`, `main`, or `blockquote`), since `li` cannot host a
shadow root either. Original lists/items keep their identity and parents;
numbering attributes and nested list layout are retained. Lists with unsupported
live descendants remain native. This is an inline repair tool, not a replacement
for Gemini's block Markdown renderer.

## Selected-text copy

Gemini's public copy helper uses `getRangeAt(0).cloneContents()`. Chromium can
retarget a pointer selection inside a shadow root to a collapsed outer range,
producing empty HTML, and `Selection.toString()` can stop at the first shadow
paragraph. A capture-phase copy bridge handles only selections involving an
active projection within one chat container. It resolves the composed selection
using owned shadow roots, reconstructs the selected interval across previews and
assigned native slots, and exports both HTML and plain text from that interval.
Hidden source slots and duplicate MathML are omitted. Partial inline formatting,
links, native citations, and paragraph breaks are retained; unrelated text and
unselected tails are not exported. Clipboard HTML carries computed formatting
needed outside the shadow stylesheet. Gemini's copy listener cannot overwrite a
successfully reconstructed copy. Native/editor/button/disabled selections stay
on the native/default path, as does a selection invalidated during streaming.
Whole-response and table-copy buttons retain their original source data.

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
live interaction boundaries, nested widgets, lists, selected-text/HTML copy,
layout, selection/accessibility, font loading,
Trusted Types, both adapters, and real popup/storage integration. The MV3 test
uses a temporary browser profile under ignored `test-results/` and removes it.
`CHROME_PATH` can override the browser for engine tests;
`EXTENSION_CHROME_PATH` overrides it for the MV3 test and must support extension
sideloading.

Vendored dependencies: KaTeX 0.16.9 and markdown-it 14.1.0. Their licenses are in
[KaTeX](../lib/LICENSE.katex) and [markdown-it](../lib/LICENSE.markdown-it).

## Userscript configuration

Edit `userscript-bootstrap.js` to customize the default format/color settings,
then run `npm run build:userscript`. Dependencies and fonts use version-pinned
jsDelivr URLs; the Chrome extension bundles them locally.
