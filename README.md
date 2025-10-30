LLM Prices (Static)

This is a simple GitHub Pages–compatible static page that reads local JSON files to display LLM pricing in a sortable table with a quick cost calculator.

Files:
- `index.html` – main page
- `styles.css` – minimal styling
- `app.js` – loads and renders pricing data
- `anthropic-pricing.json` – sample pricing data
- `google-pricing.json` – sample pricing data (empty by default)

Usage (locally):
- Serve the folder with any static server (or open `index.html` directly). Some browsers restrict `fetch` for `file://`; to avoid this, run a tiny server:
  - Python: `python3 -m http.server 8000` then visit http://localhost:8000/

Deploy on GitHub Pages:
1. Commit to your default branch (e.g., `main`).
2. In the repo Settings → Pages, set Source to “Deploy from a branch” and choose the root (`/`) of `main`.
3. Open the published URL.

Notes:
- The app reads from `anthropic-pricing.json` and `google-pricing` (treated as JSON). Add more files by editing `DATA_FILES` in `app.js`.
- Table columns include Standard and Batch prices when available.
- Calculator uses prices per 1M tokens; enter your input/output token counts to estimate cost.
- Per-row calculator only: Enter Input, Cached Input, and Output tokens directly in the table to see live Standard and Batch costs per model. Adjust the "Cached input factor" (default 0.50) in the top controls to model provider-specific cache discounts.
