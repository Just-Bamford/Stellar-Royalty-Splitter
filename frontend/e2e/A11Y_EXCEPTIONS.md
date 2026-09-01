# Accessibility (WCAG 2.1 AA) Exceptions

This document tracks known accessibility issues and exceptions that cannot be automatically fixed.

## Active Exceptions

### 1. Export Menu Dropdown
- **Component**: Export Dashboard Menu
- **Issue**: Menu items may not be fully keyboard navigable in all browsers
- **Impact**: Minor
- **Justification**: Export is a secondary feature; menu is accessible via mouse and basic keyboard navigation
- **Workaround**: Users can use Tab to navigate to the export button and Enter to open the menu
- **Tracking Issue**: #XXX
- **Date Added**: 2026-08-26

### 2. Wallet Connection Modal
- **Component**: WalletConnect
- **Issue**: Third-party wallet provider UI may not meet WCAG AA standards
- **Impact**: Moderate
- **Justification**: Wallet UI is controlled by external providers (Freighter, etc.)
- **Workaround**: Users can use browser extensions for wallet management
- **Tracking Issue**: #XXX
- **Date Added**: 2026-08-26

### 3. Chart Visualizations
- **Component**: EarningsHistoryChart, CollaboratorAllocationChart
- **Issue**: Charts may not be fully accessible to screen readers
- **Impact**: Serious
- **Justification**: Complex data visualizations require alternative text representations
- **Workaround**: Data is available in tabular format in the same section
- **Tracking Issue**: #XXX
- **Date Added**: 2026-08-26

## Resolved Exceptions

None yet.

## Manual Testing Requirements

Automated tools catch ~30% of accessibility issues. Manual testing is required for:

1. **Screen Reader Testing**: Test with NVDA, VoiceOver, and JAWS
2. **Keyboard-Only Navigation**: Complete all critical user flows without mouse
3. **Color Contrast**: Verify contrast ratios in different themes (light/dark)
4. **Zoom/Magnification**: Test at 200% and 400% zoom levels
5. **Voice Control**: Test with voice commands (Dragon NaturallySpeaking)

## Testing Schedule

- **Weekly**: Automated axe-core tests in CI
- **Monthly**: Manual screen reader testing of critical paths
- **Quarterly**: Full accessibility audit with external tools

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/TR/WCAG21/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apd/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [axe-core Documentation](https://github.com/dequelabs/axe-core)
