# Sigma Oasis — Visual Style Guide
## Apple Glass / visionOS Edition · v1.0

---

## Brand Essence

**Sigma Oasis** — Private AI where you own your data.

**Design Vibe**: A protected pool of water in a dark, infinite space. Light passes through glass. Nothing leaks. Everything settles.

**Three Words**: Calm · Deep · Owned

---

## Color Palette

### Background Layer
```
Base Canvas:    #000000  (pure black — infinite depth)
Orb Teal:       rgba(0,212,170,0.06)  (top-left ambient glow)
Orb Purple:     rgba(100,80,220,0.05) (bottom-right ambient glow)
```

### Glass Surfaces
```
Primary:        rgba(255,255,255,0.05)
Hover:          rgba(255,255,255,0.08)
Active:         rgba(255,255,255,0.12)
Border:         rgba(255,255,255,0.08)
Highlight Edge: rgba(255,255,255,0.12)  (the 1px top streak)
```

### Accent Colors (Emitting)
```
Teal Primary:   #00d4aa   (brand, thinking, search tools)
Teal Glow:      #4fffd1   (text highlights, active states)
Amber:          #ffd166   (code execution tools)
Lavender:       #a78bfa   (memory/recall tools)
Blue:           #6cb4ff   (assistant role)
Purple:         #c084fc   (researcher role)
```

### Text
```
Primary:        rgba(255,255,255,0.92)
Secondary:      rgba(255,255,255,0.60)
Tertiary:       rgba(255,255,255,0.35)
Muted:          rgba(255,255,255,0.20)
```

---

## Typography

| Role | Size | Weight | Letter-Spacing | Transform |
|------|------|--------|----------------|-----------|
| App Title | 15px | 600 | -0.3px | — |
| Body | 14–15px | 400 | normal | — |
| Status Label | 13px | 600 | 0.08em | UPPERCASE |
| Metadata | 10–11px | 400 | normal | — |
| Button | 14px | 500 | normal | — |

**Font Stack**: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif`

---

## The Glass Surface

Every panel in the app follows this exact specification:

```css
.glass-panel {
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border-radius: 24px;
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),   /* Top light streak */
    0 12px 40px rgba(0,0,0,0.3);            /* Physical depth */
  position: relative;
  overflow: hidden;
}

/* Mandatory top light streak on every glass surface */
.glass-panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
}
```

---

## Border Radius Scale

| Size | Value | Usage |
|------|-------|-------|
| Large | 24px | Sidebar, main chat panels, input bar |
| Medium | 20px | Conversation cards, message bubbles |
| Small | 16px | Buttons, pills, avatars |
| Micro | 10px | Tool indicators, badges |
| Circle | 50% | Status dots, icon buttons |

---

## The Σ Avatar

```
Size:           40×40px
Background:     linear-gradient(135deg, rgba(0,212,170,0.8), rgba(0,143,107,0.8))
Border-radius:  14px
Text:           Σ, 20px, weight 700, white
Inner shadow:   inset 0 1px 0 rgba(255,255,255,0.2)
Outer glow:     0 4px 20px rgba(0,212,170,0.25)
Border:         1px solid rgba(0,212,170,0.3)
```

---

## The Oasis Ripple

### The Thinking Indicator
Replaces all spinners, dots, and loading bars. A 64×64px glass disc pool where droplets fall and ripples expand.

### Pool Disc
```
Size:           64×64px SVG
Base:           radial-gradient(circle, rgba(0,212,170,0.08), rgba(0,212,170,0.01))
Outer ring:     0.8px solid rgba(0,212,170,0.15)
Glass ring:     1.5px solid rgba(255,255,255,0.04)
Inner ring:     20px radius, 0.5px stroke, rgba(0,212,170,0.06)
Highlight:      ellipse at (26,22), rx=8, ry=5, rotated -30deg, rgba(255,255,255,0.06)
Center orb:     3px radius, #00d4aa, pulsing opacity 0.6→1→0.6 over 2.5s
```

### Animation States

| State | Trigger | Visual |
|-------|---------|--------|
| **Ambient** | AI is thinking | Soft ripple expands from center every 2–3s |
| **Tool Call** | External tool invoked | Colored droplet falls from edge → impact → ripple + splash + tool icon glows |
| **Complete** | Response ready | Indicator dims to 30% opacity, scales to 0.96, response text fades in |

### Tool Color Coding

| Tool | Ripple Color | Icon | Label |
|------|-------------|------|-------|
| Search | #4fffd1 | 🔍 | SEARCHING |
| Code | #ffd166 | ⚡ | EXECUTING |
| Memory | #a78bfa | 💾 | RECALLING |
| File | #ff6b6b | 📄 | READING |

---

## Easing Tokens

```css
--ease-spring:  cubic-bezier(0.16, 1, 0.3, 1);     /* Entrances, reveals */
--ease-settle:  cubic-bezier(0.33, 1, 0.68, 1);    /* Thinking → complete */
--ease-ripple:  cubic-bezier(0.25, 0.46, 0.45, 0.94); /* Water physics */
```

---

## Component Quick Reference

### Sidebar
- 280px wide, glass panel, 20px padding
- Active conversation: teal border + teal top streak + "Active now" dot
- Connection status: bottom panel, pulsing green dot

### Top Orchestrator Bar
- Mode switcher: pill buttons, active in `rgba(255,255,255,0.1)`
- Role pills: colored badges with matching border glow

### Chat Messages
- **User**: `bg: rgba(0,212,170,0.12)`, `border: rgba(0,212,170,0.18)`, tail on left
- **AI**: standard glass, tail on right, Σ avatar left-aligned

### Bottom Input
- Full-width glass bar, 40×40px icon buttons (glass circles)
- Send button: gradient teal, `#4fffd1` text, teal border glow

### Tool Pills
- 28×28px glass squares, 10px radius
- Idle: muted gray
- Active: tool color background + border glow + matching icon color

---

## Do's and Don'ts

### ✅ Do
- Use the `::before` light streak on every glass surface
- Let background orbs create spatial depth
- Make accent colors feel like they're emitting from within the glass
- Replace every loading state with the Oasis Ripple
- Keep transitions calm and springy

### ❌ Don't
- Use solid white or black backgrounds (except the base canvas)
- Add drop shadows to glass panels (use inset highlights + outer ambient shadow only)
- Use generic spinners, skeletons, or "..." typing indicators
- Make tool call colors too saturated — they should glow, not scream
- Forget `prefers-reduced-motion`

---

## One-Line Principles

1. **Glass has thickness** — every panel gets the top light streak
2. **Light lives inside** — accents emit, they don't sit on top
3. **Water doesn't rush** — all motion is organic, eased, and settles
4. **Your oasis is yours** — contained, private, calm

---

*Sigma Oasis · Apple Glass Edition · Designed 2026*
