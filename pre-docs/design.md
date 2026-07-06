---
name: Structured Clarity
colors:
  surface: '#fbf9f7'
  surface-dim: '#dbdad7'
  surface-bright: '#fbf9f7'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f1'
  surface-container: '#efedeb'
  surface-container-high: '#eae8e5'
  surface-container-highest: '#e4e2e0'
  on-surface: '#1b1c1b'
  on-surface-variant: '#49473f'
  inverse-surface: '#30302f'
  inverse-on-surface: '#f2f0ee'
  outline: '#7a776e'
  outline-variant: '#cbc6bc'
  surface-tint: '#615e57'
  primary: '#21201a'
  on-primary: '#ffffff'
  primary-container: '#37352f'
  on-primary-container: '#a19d95'
  inverse-primary: '#cbc6bd'
  secondary: '#5d5f5d'
  on-secondary: '#ffffff'
  secondary-container: '#e2e3e1'
  on-secondary-container: '#636563'
  tertiary: '#1e201f'
  on-tertiary: '#ffffff'
  tertiary-container: '#333534'
  on-tertiary-container: '#9d9e9c'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e7e2d9'
  primary-fixed-dim: '#cbc6bd'
  on-primary-fixed: '#1d1c16'
  on-primary-fixed-variant: '#494740'
  secondary-fixed: '#e2e3e1'
  secondary-fixed-dim: '#c6c7c5'
  on-secondary-fixed: '#1a1c1b'
  on-secondary-fixed-variant: '#454746'
  tertiary-fixed: '#e2e2e1'
  tertiary-fixed-dim: '#c6c7c5'
  on-tertiary-fixed: '#1a1c1b'
  on-tertiary-fixed-variant: '#454746'
  background: '#fbf9f7'
  on-background: '#1b1c1b'
  surface-variant: '#e4e2e0'
typography:
  h1:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  h1-mobile:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: '1.2'
  h2:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  h3:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
  code-sm:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.5'
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.4'
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  2xl: 64px
  max-width: 900px
  sidebar-width: 240px
---

## Brand & Style

This design system is built on the principles of **Functional Minimalism** and **Document-Centricity**. It prioritizes content hierarchy and clarity above all else, evoking a sense of calm productivity and organized thought. The target audience includes knowledge workers, researchers, and technical teams who require a tool that recedes into the background, allowing their data and ideas to take center stage.

The aesthetic is heavily inspired by modern workspace tools:
- **Cleanliness:** Ample white space to reduce cognitive load.
- **Utility:** Every element has a purpose; decorative flourishes are replaced by structural integrity.
- **Tactility:** Subtle depth is used to indicate interactivity, mimicking physical paper and light surfaces.
- **Neutrality:** A monochromatic base allows user content and status indicators to provide the only splashes of color.

## Colors

The palette is strictly controlled to maintain a "living document" feel.

- **Primary (#37352F):** Deep charcoal used for all primary text, headings, and high-emphasis icons. It provides high contrast without the harshness of pure black.
- **Surface (#F7F7F5):** An off-white, warm gray used for sidebars, callout blocks, and secondary backgrounds to distinguish sections from the main canvas.
- **Border (#E9E9E7):** A soft, low-contrast gray used for dividers and subtle component outlines.
- **Muted (#ACABA9):** A mid-tone gray for metadata, placeholders, and deactivated states.
- **Background (#FFFFFF):** The main workspace canvas remains pure white to maximize legibility.

## Typography

The typography system uses **Inter** for its exceptional legibility and neutral, systematic tone. **Geist** is introduced for technical identifiers, monospaced data, and small labels to provide a precise, developer-friendly edge.

- **Headings:** Utilize tight letter spacing and heavy weights to anchor the page.
- **Body:** Generous line height (1.6) is applied to long-form text to ensure comfortable reading sessions.
- **Monospaced:** Used exclusively for IDs, code snippets, and specific metadata metrics in callout blocks.

## Layout & Spacing

The layout follows a **structured document-like model** rather than a traditional marketing grid.

- **Main Canvas:** Content is centered with a max-width of 900px to maintain optimal line lengths for reading.
- **Sidebar:** A fixed 240px left-hand navigation surface using the `#F7F7F5` background.
- **Gutters:** Standardized 24px margins on mobile, scaling to fluid whitespace on desktop to keep the focus central.
- **Vertical Rhythm:** Large `2xl` (64px) spacing between major sections; `md` (16px) for component internals.

## Elevation & Depth

This design system avoids heavy shadows in favor of **Tonal Layering** and **Low-Contrast Outlines**.

- **Level 0 (Base):** The `#FFFFFF` main canvas.
- **Level 1 (Inset):** The `#F7F7F5` surfaces (sidebar, callouts, input fields) which appear "etched" or recessed into the page.
- **Level 2 (Interaction):** Hover states and active buttons use a very soft, diffused shadow (`0px 1px 3px rgba(0,0,0,0.05)`) to indicate they are liftable or clickable.
- **Borders:** 1px solid `#E9E9E7` is used for structural separation (e.g., between the sidebar and the main content) rather than depth.

## Shapes

The shape language is **Soft**. All interactive and container elements use a consistent 0.25rem (4px) radius. This creates a geometric, professional feel that is slightly approachable without appearing overly "bubbly" or consumer-grade.

- **Small elements (Buttons, Inputs):** 4px (Soft)
- **Large elements (Callout blocks, Cards):** 8px (Rounded-lg)

## Components

- **Buttons:** Primary buttons are charcoal (`#37352F`) with white text. Secondary buttons are outlined or transparent with a subtle hover fill of `#F7F7F5`.
- **Callout Blocks:** Large, light-gray containers used for metrics or "Pro-tips." They feature a minimalist line icon on the left and a 1px border.
- **Breadcrumbs:** Simple, chevron-separated text links in the `#ACABA9` color, anchored at the top of the content area.
- **Sidebars:** Collapsible panels with a vertically stacked list of navigation items. Active items are highlighted with a soft-gray background and a 2px left-accent bar.
- **Input Fields:** Minimalist design with a 1px border. On focus, the border darkens to the primary charcoal, and the background remains `#FFFFFF`.
- **Chips:** Small, gray-filled pill shapes for tagging, using the `caption` typography style for maximum density.
- **Icons:** 20x20px stroke-based icons (1.5pt weight) to match the clean, linear nature of the typography.