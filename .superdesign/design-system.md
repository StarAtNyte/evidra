# Evidra public MVP — design system

## Product character

Evidra is a research harness for people who want an AI system to investigate, build, test, and learn over time. The site should feel like a serious instrument: precise, calm, technical, and alive while work is happening.

## Visual direction

Use a dark, editorial, terminal-native interface inspired by the information density and live-agent previews of herdr.dev, but make Evidra's identity distinct. Use a deep blue-black canvas, warm ivory typography, vivid ultraviolet/cobalt accents, and a controlled signal-lime verification state. Favor asymmetric editorial sections, compact data labels, cinematic product surfaces, and a large copyable install command. Avoid generic SaaS gradients, stock photography, fake metrics, and unverified adoption claims.

## Tokens

### Dark theme

- Background / ink: `#080a14`
- Surface / panel: `#101426`
- Rule: `#2b3150`
- Foreground / paper: `#f6f2e8`
- Muted: `#9da2bb`
- Ultraviolet: `#8b6cff`
- Cobalt: `#4d8dff`
- Lime: `#c7ff4a`
- Amber: `#ffc857`
- Red: `#ff6b7a`

### Light theme

- Background / warm paper: `#f4f2ec`
- Surface: `#fffdfa`
- Rule: `#dedbe6`
- Foreground / ink: `#181722`
- Muted: `#6f6c7d`
- Ultraviolet: `#6948cf`
- Cobalt: `#3465c4`
- Lime: `#50751a`
- Amber: `#8a5a00`
- Red: `#b7344d`
- Display: `Iowan Old Style`, `Palatino Linotype`, `Book Antiqua`, `Georgia`, serif
- UI: `Inter`, `ui-sans-serif`, `system-ui`, sans-serif
- Data: `ui-monospace`, `SFMono-Regular`, `Menlo`, monospace
- Spacing: 4, 8, 12, 16, 24, 32, 48, 64px
- Radius: 2–8px
- Shadows: minimal; use borders and contrast instead

## Content rules

Lead with the individual researcher. Explain the loop plainly: question → evidence → hypothesis → experiment → evaluation → replication. Show real install commands: `npm install -g evidra`, `evidra`, `/research start`. Link to the public repository and existing Markdown docs.

## Web workbench extension

The browser workbench is an operational companion to the CLI, not a marketing landing page. Warm light is the default theme and a clear toggle switches to the dark theme; both must have equivalent hierarchy and accessible contrast. Research and Challenge are the two primary work modes. Build/Engineering, Data/Analytics, Business/Operations, and Design/Creative are secondary profiles, with Custom for anything else. Secondary profiles currently supply bounded goal guidance over the shared campaign runtime; never imply their specialized tools or evaluators exist unless configured. Keep durable campaign state, evidence, experiments, task dependencies, and operator controls central. Use an information-rich research studio layout: persistent project navigation, a clear campaign overview, phase/task progress, evidence and experiment surfaces, and an activity stream. Make idle, running, blocked, failed, and verified states visually distinct. Do not invent benchmark scores, completed work, or live agent activity; use a credible uninitialized/empty state where state is absent. Prefer small purposeful motion for live progress, respect reduced motion, and keep controls honest about whether they are currently actionable. The UI should work alongside the TUI against one local Evidra controller and state store; it must not suggest cloud collaboration or remote execution unless implemented.
