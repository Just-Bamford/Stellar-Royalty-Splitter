# Stellar Royalty Splitter - Design System

> **Issues**: #968 (Dark Mode), #967 (Design System)
> **Version**: 1.0.0
> **Last Updated**: September 27, 2026

## Overview

This document defines the comprehensive design system for the Stellar Royalty Splitter application. It provides a single source of truth for colors, typography, spacing, and component patterns to ensure consistency across the entire application.

## Table of Contents

1. [Color Palette](#color-palette)
2. [Typography](#typography)
3. [Spacing](#spacing)
4. [Shadows & Elevation](#shadows--elevation)
5. [Border Radius](#border-radius)
6. [Transitions](#transitions)
7. [Component Patterns](#component-patterns)
8. [Dark Mode Guidelines](#dark-mode-guidelines)
9. [Accessibility](#accessibility)

---

## Color Palette

### Primary Colors

Used for primary actions, links, and key UI elements.

```css
--accent-primary: #667eea;        /* Light mode primary */
--accent-primary-dark: #764ba2;   /* Primary gradient end */
--accent-primary-light: rgba(102, 126, 234, 0.1);  /* Subtle backgrounds */
```

**Dark Mode:**
```css
--accent-primary: #818cf8;        /* Brighter for dark backgrounds */
--accent-primary-dark: #a78bfa;
```

### Background Colors

```css
--bg-primary: #ffffff;      /* Main content areas */
--bg-secondary: #f8f9fa;    /* Page background, subtle differentiation */
--bg-tertiary: #f0f2f5;     /* Sunken areas, inactive states */
--bg-quaternary: #e9ecef;   /* Deep sunken, borders */
```

**Dark Mode:**
```css
--bg-primary: #0f172a;      /* Rich navy, reduces eye strain */
--bg-secondary: #1e293b;    /* Elevated surfaces */
--bg-tertiary: #334155;     /* Further elevated */
--bg-quaternary: #475569;   /* Highest elevation */
```

### Text Colors

```css
--text-primary: #1a1a1a;    /* Headings, primary content */
--text-secondary: #5a5a5a;  /* Body text, descriptions */
--text-tertiary: #8a8a8a;   /* Subtle text, labels */
--text-quaternary: #b8b8b8; /* Placeholder text */
--text-disabled: #b8b8b8;   /* Disabled state */
--text-inverse: #ffffff;    /* Text on dark backgrounds */
```

### Status Colors

#### Success
```css
--success: #10b981;           /* Success messages, positive actions */
--success-light: #d1fae5;     /* Success backgrounds */
--success-dark: #059669;      /* Hover states */
```

#### Warning
```css
--warning: #f59e0b;           /* Warning messages */
--warning-light: #fef3c7;     /* Warning backgrounds */
--warning-dark: #d97706;      /* Hover states */
```

#### Error
```css
--error: #ef4444;             /* Error messages, destructive actions */
--error-light: #fee2e2;       /* Error backgrounds */
--error-dark: #dc2626;        /* Hover states */
```

#### Info
```css
--info: #3b82f6;              /* Informational messages */
--info-light: #dbeafe;        /* Info backgrounds */
--info-dark: #2563eb;         /* Hover states */
```

### Border Colors

```css
--border-primary: #e5e7eb;    /* Default borders */
--border-secondary: #f3f4f6;  /* Subtle borders */
--border-tertiary: #d1d5db;   /* Strong borders */
--border-focus: #667eea;      /* Focus state */
```

---

## Typography

### Font Families

```css
--font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif;
--font-family-mono: "Fira Code", "JetBrains Mono", "Consolas", monospace;
```

### Font Sizes

| Token | Size | Usage |
|-------|------|-------|
| `--font-size-2xs` | 10px | Small labels, timestamps |
| `--font-size-xs` | 12px | Captions, footnotes |
| `--font-size-sm` | 14px | Small buttons, labels |
| `--font-size-base` | 16px | Body text (default) |
| `--font-size-lg` | 18px | Prominent body text |
| `--font-size-xl` | 20px | H4, subheadings |
| `--font-size-2xl` | 24px | H3 |
| `--font-size-3xl` | 30px | H2 |
| `--font-size-4xl` | 36px | H1 |
| `--font-size-5xl` | 48px | Hero text |

### Font Weights

```css
--font-weight-light: 300;
--font-weight-normal: 400;       /* Body text */
--font-weight-medium: 500;       /* Slightly emphasized */
--font-weight-semibold: 600;     /* Headings, buttons */
--font-weight-bold: 700;         /* Strong emphasis */
--font-weight-extrabold: 800;    /* Hero text */
```

### Line Heights

```css
--line-height-none: 1;           /* Tight, for headings */
--line-height-tight: 1.25;
--line-height-snug: 1.375;
--line-height-normal: 1.5;       /* Body text (default) */
--line-height-relaxed: 1.625;
--line-height-loose: 2;          /* Increased readability */
```

### Typography Scale Examples

```html
<h1 style="font-size: var(--font-size-4xl); font-weight: var(--font-weight-bold);">
  Primary Heading
</h1>

<p style="font-size: var(--font-size-base); line-height: var(--line-height-normal);">
  Body text with comfortable reading experience.
</p>

<code style="font-family: var(--font-family-mono); font-size: var(--font-size-sm);">
  GABC...XYZ
</code>
```

---

## Spacing

### Spacing Scale

| Token | Size | Usage |
|-------|------|-------|
| `--spacing-0` | 0px | No space |
| `--spacing-1` | 2px | Minimal gap |
| `--spacing-2` | 4px | Tight spacing |
| `--spacing-3` | 6px | Very small gaps |
| `--spacing-4` | 8px | Small gaps |
| `--spacing-6` | 12px | Medium gaps |
| `--spacing-8` | 16px | Default gap |
| `--spacing-12` | 24px | Large gaps |
| `--spacing-16` | 32px | Section spacing |
| `--spacing-24` | 48px | Major sections |
| `--spacing-32` | 64px | Hero spacing |

### Semantic Spacing

```css
--spacing-xs: 4px;      /* Minimal space between related elements */
--spacing-sm: 8px;      /* Small gaps within components */
--spacing-md: 16px;     /* Default component padding */
--spacing-lg: 24px;     /* Card padding, section gaps */
--spacing-xl: 32px;     /* Major section spacing */
--spacing-2xl: 48px;    /* Page-level spacing */
--spacing-3xl: 64px;    /* Hero sections */
```

### Usage Examples

```css
.card {
  padding: var(--spacing-lg);        /* 24px all around */
  margin-bottom: var(--spacing-md);  /* 16px gap between cards */
}

.button {
  padding: var(--spacing-sm) var(--spacing-md);  /* 8px vertical, 16px horizontal */
}
```

---

## Shadows & Elevation

### Shadow Scale

```css
--shadow-xs: 0 1px 2px 0 rgba(0, 0, 0, 0.05);          /* Subtle elevation */
--shadow-sm: 0 1px 3px 0 rgba(0, 0, 0, 0.1);           /* Slight lift */
--shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);        /* Default cards */
--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);      /* Dropdowns, popovers */
--shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1);      /* Modals */
--shadow-2xl: 0 25px 50px -12px rgba(0, 0, 0, 0.25);   /* Hero elements */
--shadow-inner: inset 0 2px 4px 0 rgba(0, 0, 0, 0.05); /* Inset effect */
```

### Focus Shadows

```css
--shadow-focus: 0 0 0 3px rgba(102, 126, 234, 0.15);         /* Focus ring */
--shadow-focus-error: 0 0 0 3px rgba(239, 68, 68, 0.15);     /* Error focus */
--shadow-focus-success: 0 0 0 3px rgba(16, 185, 129, 0.15);  /* Success focus */
```

### Elevation Hierarchy

1. **Base Level (0)**: Page background
2. **Level 1 (shadow-sm)**: Cards, panels
3. **Level 2 (shadow-md)**: Buttons, inputs on focus
4. **Level 3 (shadow-lg)**: Dropdowns, tooltips
5. **Level 4 (shadow-xl)**: Modals, dialogs
6. **Level 5 (shadow-2xl)**: Full-screen overlays

---

## Border Radius

```css
--radius-none: 0;
--radius-sm: 4px;       /* Small elements */
--radius-md: 8px;       /* Buttons, inputs (default) */
--radius-lg: 12px;      /* Cards, panels */
--radius-xl: 16px;      /* Large cards */
--radius-2xl: 24px;     /* Hero cards */
--radius-full: 9999px;  /* Pills, badges */
--radius-circle: 50%;   /* Avatars, icons */
```

---

## Transitions

### Duration

```css
--transition-fast: 100ms;    /* Micro-interactions */
--transition-base: 200ms;    /* Default transitions */
--transition-slow: 350ms;    /* Deliberate animations */
--transition-slower: 500ms;  /* Major state changes */
```

### Easing Functions

```css
--ease-in: cubic-bezier(0.4, 0, 1, 1);            /* Accelerating */
--ease-out: cubic-bezier(0, 0, 0.2, 1);           /* Decelerating (default) */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);      /* Smooth both ways */
--ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);  /* Playful bounce */
```

### Usage

```css
.button {
  transition: all var(--transition-base);
}

.modal {
  transition: opacity var(--transition-slow) var(--ease-out);
}
```

---

## Component Patterns

### Buttons

```css
.btn-primary {
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-primary-dark));
  color: var(--text-inverse);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  font-weight: var(--font-weight-semibold);
  box-shadow: var(--shadow-md);
  transition: all var(--transition-base);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
```

### Cards

```css
.card {
  background: var(--bg-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-sm);
  transition: all var(--transition-base);
}

.card:hover {
  border-color: var(--accent-primary-light);
  box-shadow: var(--shadow-md);
}
```

### Inputs

```css
.input {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: var(--spacing-sm) var(--spacing-md);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  transition: all var(--transition-base);
}

.input:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--shadow-focus);
  background: var(--bg-primary);
}
```

---

## Dark Mode Guidelines

### Implementation

Dark mode is activated via the `data-theme="dark"` attribute on the root `<html>` element:

```html
<html data-theme="dark">
```

### Best Practices

1. **Never hardcode colors** - Always use CSS variables
2. **Test both modes** - Ensure readable contrast in both themes
3. **Adjust shadows** - Dark mode uses stronger shadows for depth
4. **Brighten colors** - Status colors are lighter in dark mode for visibility
5. **Use semantic tokens** - Prefer `--text-primary` over specific hex values

### Color Contrast Guidelines

- **Light Mode**: Dark text on light backgrounds (high contrast)
- **Dark Mode**: Light text on dark backgrounds (reduced brightness to avoid eye strain)

### Testing Dark Mode

```javascript
// Toggle dark mode
document.documentElement.setAttribute('data-theme', 'dark');

// Toggle light mode
document.documentElement.setAttribute('data-theme', 'light');
```

---

## Accessibility

### Color Contrast

All color combinations meet WCAG 2.1 Level AA standards:

- **Normal text**: Minimum 4.5:1 contrast ratio
- **Large text** (18px+ or 14px+ bold): Minimum 3:1 contrast ratio
- **UI components**: Minimum 3:1 contrast ratio

### Focus States

All interactive elements have visible focus indicators:

```css
button:focus-visible,
input:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
  border-color: var(--border-focus);
}
```

### Motion Preferences

Respects `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Touch Targets

Minimum touch target size of 48x48px for mobile:

```css
@media (pointer: coarse) {
  button, input[type="checkbox"], input[type="radio"] {
    min-height: 48px;
    min-width: 48px;
  }
}
```

---

## Z-Index Scale

```css
--z-base: 0;               /* Normal content flow */
--z-dropdown: 1000;        /* Dropdown menus */
--z-sticky: 1020;          /* Sticky headers */
--z-fixed: 1030;           /* Fixed navigation */
--z-modal-backdrop: 1040;  /* Modal overlays */
--z-modal: 1050;           /* Modal dialogs */
--z-popover: 1060;         /* Popovers, tooltips */
--z-tooltip: 1070;         /* Tooltips (highest UI) */
--z-toast: 1080;           /* Toast notifications */
```

---

## Usage in Components

### Import Design Tokens

```tsx
import '../styles/design-tokens.css';
```

### Example Component

```tsx
const Card = ({ children }) => (
  <div style={{
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--spacing-lg)',
    boxShadow: 'var(--shadow-md)',
  }}>
    {children}
  </div>
);
```

---

## Resources

- [Inter Font](https://rsms.me/inter/)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Color Contrast Checker](https://webaim.org/resources/contrastchecker/)

---

**Maintained by**: Stellar Royalty Splitter Team  
**Last Review**: September 27, 2026  
**Next Review**: December 27, 2026
