---
name: tomo-browse
description: Browse the web with a real browser using playwright-cli. Navigate pages, click elements, fill forms, take screenshots. Use when WebFetch isn't enough — pages need JavaScript, interaction, or visual capture.
---

# Browser Automation with playwright-cli

## Quick start

```bash
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli click e15
playwright-cli type "search query"
playwright-cli screenshot
playwright-cli close
```

## Commands

### Core

```bash
playwright-cli open
playwright-cli open https://example.com/
playwright-cli goto https://playwright.dev
playwright-cli type "search query"
playwright-cli click e3
playwright-cli dblclick e7
playwright-cli fill e5 "user@example.com" --submit
playwright-cli drag e2 e8
playwright-cli hover e4
playwright-cli select e9 "option-value"
playwright-cli upload ./document.pdf
playwright-cli check e12
playwright-cli uncheck e12
playwright-cli snapshot
playwright-cli eval "document.title"
playwright-cli dialog-accept
playwright-cli dialog-dismiss
playwright-cli close
```

### Navigation

```bash
playwright-cli go-back
playwright-cli go-forward
playwright-cli reload
```

### Keyboard

```bash
playwright-cli press Enter
playwright-cli press ArrowDown
playwright-cli keydown Shift
playwright-cli keyup Shift
```

### Save as

```bash
playwright-cli screenshot
playwright-cli screenshot e5
playwright-cli screenshot --filename=page.png
playwright-cli pdf --filename=page.pdf
```

### Tabs

```bash
playwright-cli tab-list
playwright-cli tab-new https://example.com/page
playwright-cli tab-close
playwright-cli tab-select 0
```

### Storage

```bash
playwright-cli cookie-list
playwright-cli cookie-get session_id
playwright-cli cookie-set session_id abc123
playwright-cli localstorage-get theme
playwright-cli localstorage-set theme dark
```

## Raw output

Use `--raw` to get clean output for piping:

```bash
playwright-cli --raw eval "document.title"
playwright-cli --raw snapshot > page.yml
```

## Snapshots

After each command, playwright-cli provides a snapshot with element refs (e.g., `e15`, `e3`). Use these refs to interact:

```bash
playwright-cli snapshot
playwright-cli click e15
```

You can also use CSS selectors or Playwright locators:

```bash
playwright-cli click "#main > button.submit"
playwright-cli click "getByRole('button', { name: 'Submit' })"
```

## Targeting elements

Prefer refs from snapshots. Fall back to CSS selectors or locators when refs are ambiguous.

## Example: Form submission

```bash
playwright-cli open https://example.com/form
playwright-cli snapshot
playwright-cli fill e1 "user@example.com"
playwright-cli fill e2 "password123"
playwright-cli click e3
playwright-cli snapshot
playwright-cli close
```

## Example: Multi-tab workflow

```bash
playwright-cli open https://example.com
playwright-cli tab-new https://example.com/other
playwright-cli tab-select 0
playwright-cli snapshot
playwright-cli close
```

## Installation

Before using any playwright-cli command, check if it's installed. If not, install it automatically — don't ask the user:

```bash
which playwright-cli || npm install -g @playwright/cli@latest
```
