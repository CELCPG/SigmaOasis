# Sigma Oasis — Apple Glass / visionOS UI Redesign Prompt

## Overview
Redesign the Sigma Oasis desktop application using an **Apple Glass / visionOS spatial design language**. Every surface should feel like a physical sheet of frosted glass floating in a dark, ambient-lit space. The "Oasis Ripple" replaces all traditional loading/spinning indicators.

---

## Design Philosophy

### Core Principles
1. **Physical glass, not frosted CSS** — Every panel is a translucent surface with real depth, light refraction, and edge glow. Think "looking through a museum display case," not "white background with blur."
2. **Spatial depth, not flat layers** — Background orbs, mid-ground panels, and foreground controls exist at different z-depths. Parallax on scroll.
3. **Light lives inside the glass** — All accents (teal, amber, lavender) should feel like they are emitting from within the material, not painted on top.
4. **Calm over chaos** — No jarring transitions. Everything settles like water. The Oasis Ripple is the heartbeat of the app.

### Reference Vibe
- Apple visionOS window chrome
- macOS Sonoma desktop widgets
- Nothing Phone (2) Glyph Interface (subtle, purposeful light)
- Aesop skincare packaging (restraint, texture, negative space)

---

## Color System

### Backgrounds
| Token | Value | Usage |
|---|---|---|
| `--bg-base` | `#000000` | Deepest layer — pure black canvas |
| `--bg-orb-teal` | `rgba(0,212,170,0.06)` | Top-left ambient orb (400px, blur 80px) |
| `--bg-orb-purple` | `rgba(100,80,220,0.05)` | Bottom-right ambient orb (300px, blur 100px) |

### Glass Surfaces
| Token | Value | Usage |
|---|---|---|
| `--glass-primary` | `rgba(255,255,255,0.05)` | Main panels, cards |
| `--glass-hover` | `rgba(255,255,255,0.08)` | Hover state |
| `--glass-active` | `rgba(255,255,255,0.12)` | Active/selected state |
| `--glass-border` | `rgba(255,255,255,0.08)` | Panel borders |
| `--glass-highlight` | `rgba(255,255,255,0.12)` | Top edge light streak |

### Accent Colors (Emitting)
| Token | Value | Usage |
|---|---|---|
| `--accent-teal` | `#00d4aa` | Primary brand, thinking state, search tools |
| `--accent-teal-glow` | `#4fffd1` | Text highlights, active indicators |
| `--accent-amber` | `#ffd166` | Code execution tools |
| `--accent-lavender` | `#a78bfa` | Memory/recall tools |
| `--accent-blue` | `#6cb4ff` | Assistant role |
| `--accent-purple` | `#c084fc` | Researcher role |

### Text
| Token | Value | Usage |
|---|---|---|
| `--text-primary` | `rgba(255,255,255,0.92)` | Headings, body |
| `--text-secondary` | `rgba(255,255,255,0.6)` | Descriptions, metadata |
| `--text-tertiary` | `rgba(255,255,255,0.35)` | Timestamps, hints |
| `--text-muted` | `rgba(255,255,255,0.2)` | Placeholders |

---

## Glass Panel Specification

Every panel in the app must follow this exact specification:

```css
.glass-panel {
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border-radius: 24px;
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 
    inset 0 1px 0 rgba(255,255,255,0.08),   /* Top light streak */
    0 12px 40px rgba(0,0,0,0.3);            /* Physical drop shadow */
  position: relative;
  overflow: hidden;
}

/* The signature top light streak — REQUIRED on every glass surface */
.glass-panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
}
```

### Border Radius Scale
- **Large panels** (sidebar, main chat): `24px`
- **Medium cards** (conversation items, messages): `20px`
- **Small elements** (buttons, pills, avatars): `16px` or `14px`
- **Micro** (tool indicators, badges): `10px` or `50%` (circles)

---

## Typography

- **Font Family**: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif`
- **Headings**: 15–18px, weight 600, letter-spacing `-0.3px`
- **Body**: 14–15px, weight 400, line-height `1.6`
- **Labels/Status**: 11–13px, weight 500, letter-spacing `0.08em`, `uppercase` for status text
- **Metadata**: 10–11px, weight 400, color `--text-tertiary`

---

## Component Specifications

### 1. Sidebar
- Width: `280px`
- Glass panel with `padding: 20px 16px`
- Contains:
  - **App header** (logo + name + tagline) — glass panel, `border-radius: 24px`
  - **New conversation button** — `background: rgba(0,212,170,0.15)`, teal border glow
  - **Search field** — glass input with icon
  - **Conversation list** — stack of glass cards, active item gets teal border + teal top streak
  - **Connection status** — bottom panel with pulsing green dot

### 2. Top Orchestrator Bar
- Full-width glass panel, `border-radius: 20px`
- Contains:
  - **Mode selector** (Independent / Pipeline / Orchestrated) — pill switcher with active state in `rgba(255,255,255,0.1)`
  - **Role pills** — colored badges (blue for Assistant, purple for Researcher) with `border: 1px solid [color]20`
  - **Export button** — ghost button, right-aligned

### 3. Chat Messages
- **User messages**: Glass panel with `background: rgba(0,212,170,0.12)`, `border: 1px solid rgba(0,212,170,0.18)`, `border-radius: 24px 24px 6px 24px` (speech bubble tail on left)
- **AI messages**: Glass panel with `border-radius: 24px 24px 24px 6px`, left-aligned with Σ avatar
- **Σ Avatar**: `40×40px`, gradient `rgba(0,212,170,0.8)` to `rgba(0,143,107,0.8)`, `border-radius: 14px`, inner shadow `inset 0 1px 0 rgba(255,255,255,0.2)`, outer glow `0 4px 20px rgba(0,212,170,0.25)`

### 4. Bottom Input Bar
- Full-width glass panel, `border-radius: 24px`, `padding: 6px`
- Contains:
  - **Attach button** — `40×40px` glass circle icon
  - **Voice button** — `40×40px` glass circle icon
  - **Text input** — transparent, `--text-primary`, placeholder `--text-muted`
  - **Send button** — gradient `rgba(0,212,170,0.2)` to `rgba(0,143,107,0.2)`, teal border, `border-radius: 16px`, `color: #4fffd1`

### 5. Tool Call Indicators (in thinking state)
- Three glass icon buttons (`28×28px`, `border-radius: 10px`)
- Icons: 🔍 Search, ⚡ Code, 💾 Memory
- **Idle**: `background: rgba(255,255,255,0.04)`, `border: 1px solid rgba(255,255,255,0.06)`, icon `rgba(255,255,255,0.2)`
- **Active**: `background: [tool-color]20`, `border-color: [tool-color]50`, icon `[tool-color]`, `box-shadow: 0 0 16px [tool-color]30`
- Transition: `0.5s ease`

---

## The Oasis Ripple — Thinking Indicator

### Placement
Inside the AI message bubble, to the right of the Σ avatar. Replaces all `...` or spinner states.

### Glass Pool Disc
- Size: `64×64px` SVG
- Base: Radial gradient from `rgba(0,212,170,0.08)` center to `rgba(0,212,170,0.01)` edge
- Border: `0.8px solid rgba(0,212,170,0.15)` + `1.5px solid rgba(255,255,255,0.04)` (double ring for glass thickness)
- Inner ring: `20px radius, 0.5px stroke, rgba(0,212,170,0.06)`
- Glass highlight: Ellipse at `cx=26, cy=22`, `rx=8, ry=5`, rotated `-30deg`, `rgba(255,255,255,0.06)`, blurred
- Center orb: `3px radius`, `#00d4aa`, glow filter, pulsing `opacity: 0.6→1→0.6` over `2.5s`

### Animation States

#### State 1: Ambient Thinking
- Every `2–3s` (randomized), a soft ripple expands from center
- Ripple: `radius 0→22px`, `duration 2.8s`, `opacity 0.5→0`, `stroke-width 0.8→0`
- Easing: `ease-out-cubic` — `1 - (1-t)³`
- Status text: "THINKING" in `#4fffd1`, `letter-spacing: 0.1em`, `uppercase`

#### State 2: Tool Call
1. **Droplet spawn** — Teardrop appears at random point on disc edge (`r=30px` from center)
2. **Fall** — Accelerates toward center over `750ms` (`ease-in-quad: t²`)
3. **Trail** — Dashed line follows behind, `30% opacity`
4. **Impact** — Droplet vanishes, primary ripple expands (`0→24px`, `2.2s`, tool color)
5. **Secondary ripple** — `200ms` delay, smaller (`0→17px`, `1.8s`)
6. **Splash particles** — `4-6` tiny circles burst outward, random angles, fade over `~30 frames`
7. **Tool icon illumination** — Matching tool pill lights up (see Component 5)
8. **Status update** — Text changes to tool label ("SEARCHING", "EXECUTING", "RECALLING") in tool color
9. **Reset** — After `1.8s`, text returns to "THINKING" in teal

#### State 3: Complete
- All ripples settle
- Thinking indicator: `opacity: 0.3`, `transform: scale(0.96)`, `transition: 0.8s cubic-bezier(0.16,1,0.3,1)`
- Response text fades in: `opacity: 0→1`, `translateY(10px)→0`, same easing

### Color Coding by Tool
| Tool | Ripple Color | Status Label |
|---|---|---|
| Search / Web | `#4fffd1` | "SEARCHING" |
| Code / Execute | `#ffd166` | "EXECUTING" |
| Memory / Recall | `#a78bfa` | "RECALLING" |
| File / Read | `#ff6b6b` | "READING" |

### Performance
- Use `requestAnimationFrame` for all JS-driven animation
- Remove SVG elements immediately after animation completes
- Limit concurrent ripples to `8` max
- Glow filter only on center orb and active ripples — splash particles skip filter
- Support `prefers-reduced-motion`: disable droplet fall, keep static center pulse only

---

## Animation System

### Easing Tokens
```css
--ease-spring: cubic-bezier(0.16, 1, 0.3, 1);        /* Entrances, reveals */
--ease-settle: cubic-bezier(0.33, 1, 0.68, 1);      /* Thinking-to-complete */
--ease-ripple: cubic-bezier(0.25, 0.46, 0.45, 0.94);  /* Water physics */
```

### Transition Defaults
- **Panel entrances**: `opacity 0→1`, `scale 0.96→1`, `0.5s var(--ease-spring)`
- **Hover states**: `background` + `border-color`, `0.2s ease`
- **Message appearance**: `opacity 0→1`, `translateY(8px)→0`, `0.4s var(--ease-spring)`
- **Tool call sequence**: `0.75s` droplet fall + `2.2s` ripple expansion + `0.5s` icon flash

### Parallax (Optional Enhancement)
- Background orbs move at `0.3x` scroll speed
- Glass panels move at `1.0x` (normal)
- Foreground elements (input bar) move at `1.1x` (slight lead)

---

## Responsive Behavior

| Breakpoint | Sidebar | Chat Padding | Pool Size |
|---|---|---|---|
| Desktop (≥1200px) | 280px | 40px | 64×64px |
| Tablet (768–1199px) | 240px | 24px | 56×56px |
| Mobile (<768px) | Hidden (drawer) | 16px | 48×48px |

---

## File Structure (Suggested)

```
src/
├── components/
│   ├── GlassPanel.tsx          # Base glass surface component
│   ├── OasisRipple.tsx         # The thinking indicator
│   ├── ChatMessage.tsx         # User + AI message bubbles
│   ├── Sidebar.tsx             # Left nav
│   ├── OrchestratorBar.tsx     # Top mode bar
│   ├── InputBar.tsx            # Bottom composer
│   ├── ToolPill.tsx            # Individual tool indicator
│   └── SigmaAvatar.tsx         # Σ logo avatar
├── styles/
│   ├── tokens.css              # Color, spacing, radius tokens
│   ├── glass.css               # Glass panel mixin + ::before streak
│   └── animations.css          # Easing, keyframes, transitions
└── hooks/
    └── useOasisRipple.ts       # Animation state machine
```

---

## Quality Checklist

Before shipping, verify:
- [ ] Every glass panel has the `::before` top light streak
- [ ] No solid `#fff` or `#000` backgrounds except the base canvas
- [ ] All borders are `1px solid rgba(255,255,255,0.08)` or darker
- [ ] The Oasis Ripple replaces every loading state in the app
- [ ] Tool calls are visually distinct (color + label + icon flash)
- [ ] `prefers-reduced-motion` is respected
- [ ] 60fps on M1 Mac, no jank during ripple animations
- [ ] Dark mode only — no light mode variant needed for v1

---

## Deliverables

1. **Figma file** with all components as variants
2. **React component library** (or your framework of choice)
3. **CSS token system** with the glass mixin
4. **OasisRipple component** with full animation state machine
5. **Interactive prototype** showing the tool-call sequence
