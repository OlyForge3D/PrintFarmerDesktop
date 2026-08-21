# Design System

## Theme

PrintFarmer Desktop uses a restrained, dark desktop-tool theme intended for operators working near printers in mixed or low ambient light. Surfaces are compact, quiet, and structurally separated by borders rather than decoration.

## Color

- Window and canvas: `#0e1116`, `#11151a`
- Navigation and inspector: `#15191f`
- Raised surface: `#1a1f27`; hover: `#202630`
- Primary text: `#e6e9ed`; secondary text: `#a7afba`; quiet text: `#929ca8`
- Borders: `#2a3039`; strong borders: `#3b4653`
- Accent/action: `#62b0e8`; focus: `#86c7f2`; selected tint: `#173247`
- Success: `#69b98a`; warning: `#d6a75f`; danger: `#e07178`

Status always combines color with text, iconography, or both. New colors must preserve WCAG AA contrast against their actual surface.

## Typography

Use the existing Segoe UI Variable/Segoe UI/system sans stack throughout the product. The base renderer size is 13px with a 1.4 line height. Use the existing Cascadia/Segoe UI Mono stack only for immutable IDs, revisions, values, and machine-readable references. Keep headings compact and sentence-cased; instructional prose should remain under 75 characters per line.

## Shape and Spacing

- Controls use 4px radii; content cards use 6px radii.
- Default content padding is 16px with 8px and 12px internal rhythms.
- Borders define panes and grouped state; shadows are reserved for floating dialogs.
- Avoid nested cards and decorative side stripes.

## Components

- Primary actions use the accent color and appear once per decision region.
- Secondary and destructive actions use the shared button vocabulary and explicit labels.
- Inputs, selects, text areas, segmented controls, tabs, and disclosure controls need hover, focus, disabled, invalid, busy, and read-only states where applicable.
- Loading uses structural placeholders or contextual status text.
- Empty states explain eligibility or the next safe action.
- Alerts use full borders/background tints and a textual severity heading.
- Desktop dialogs follow centralized modal ownership, focus trap, Escape handling, and trigger restoration.

## Layout

The shell retains native titlebar and statusbar regions. Top-level workspaces are peers selected from persistent shell navigation. Library keeps its three-pane layout. Printer Calibration uses a workflow-oriented shell with a project rail, main task region, and contextual detail region that collapse structurally at narrow widths without hiding current status.

The shell has exactly three tiers, and each uses one idiom:

1. **Places** — a persistent vertical rail on the left, grouped into workspaces and services. Every place is declared once in `src/renderer/shell/workspaces.ts` with its label, icon, landmark id, skip-link target, and focus target; the shell reads that registry rather than branching on a workspace id. Adding a feature means adding a registry entry and the component that renders its landmark. Below 1120px the rail keeps every destination and drops only its labels, which remain in each item's accessible name.
2. **Services** — app-level facilities are places in the rail, not dialogs. Durable, monitorable, or revisitable state (transfers, folder access) must be reachable without dismissing anything. Reserve dialogs for decisions that need protected focus. PrintFarmer authority lives in one shell-owned bar above the active place, visible everywhere and never re-implemented inside a workspace.
3. **Status** — the statusbar reports the system, never the route: current activity, transfers in flight, sources needing attention, connection, and build. The rail already communicates location through `aria-current`.

Each place owns exactly one `<h1>`, at one shared scale, and the shell chrome owns none. Second-level navigation inside a place uses the same left-rail idiom as the first, so one navigation vocabulary covers the whole product.

## Motion

Transitions communicate state changes in 150-250ms using ease-out curves. No decorative page choreography. Under `prefers-reduced-motion: reduce`, transitions and smooth scrolling become effectively instantaneous.

## Content

Use newly authored PrintFarmer Desktop guidance. Explain why a prerequisite matters, what the user should inspect, and what happens next. Never imply that software can verify a physical nozzle/toolhead change or printer safety condition that has not been explicitly confirmed.
