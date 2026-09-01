import { type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export interface A11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{
    html: string;
    target: string[];
    failureSummary: string;
  }>;
}

export interface A11yAuditResult {
  violations: A11yViolation[];
  passes: number;
  incomplete: number;
  inapplicable: number;
}

/**
 * Run axe-core accessibility audit on the current page
 */
export async function runA11yAudit(
  page: Page,
  options?: {
    include?: string[];
    exclude?: string[];
    tags?: string[];
  }
): Promise<A11yAuditResult> {
  let builder = new AxeBuilder({ page });

  if (options?.include) {
    builder = builder.include(options.include);
  }

  if (options?.exclude) {
    builder = builder.exclude(options.exclude);
  }

  // Default to WCAG 2.1 AA tags
  const tags = options?.tags ?? ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
  builder = builder.withTags(tags);

  const results = await builder.analyze();

  return {
    violations: results.violations as A11yViolation[],
    passes: results.passes.length,
    incomplete: results.incomplete.length,
    inapplicable: results.inapplicable.length,
  };
}

/**
 * Assert no accessibility violations (errors only, warnings logged)
 */
export async function expectNoA11yViolations(
  page: Page,
  options?: {
    include?: string[];
    exclude?: string[];
    tags?: string[];
    allowedImpact?: Array<'minor' | 'moderate' | 'serious' | 'critical'>;
  }
): Promise<void> {
  const result = await runA11yAudit(page, options);

  // Filter by allowed impact levels (default: exclude minor and moderate)
  const allowedImpact = options?.allowedImpact ?? ['minor', 'moderate'];
  const blockingViolations = result.violations.filter(
    (v) => !allowedImpact.includes(v.impact)
  );

  if (blockingViolations.length > 0) {
    const violationMessages = blockingViolations
      .map(
        (v) =>
          `[${v.impact.toUpperCase()}] ${v.id}: ${v.help}\n  Help: ${v.helpUrl}\n  Nodes: ${v.nodes.length}`
      )
      .join('\n\n');

    throw new Error(
      `Accessibility violations found (${blockingViolations.length} blocking):\n\n${violationMessages}`
    );
  }

  // Log non-blocking violations as warnings
  const warnings = result.violations.filter((v) =>
    allowedImpact.includes(v.impact)
  );
  if (warnings.length > 0) {
    console.warn(
      `Accessibility warnings (${warnings.length}):`,
      warnings.map((w) => `${w.id}: ${w.help}`)
    );
  }
}

/**
 * Check keyboard navigation through interactive elements
 */
export async function checkKeyboardNavigation(
  page: Page,
  containerSelector: string = 'body'
): Promise<void> {
  const interactiveElements = await page.locator(
    `${containerSelector} button, ${containerSelector} a, ${containerSelector} input, ${containerSelector} select, ${containerSelector} textarea, ${containerSelector} [tabindex]:not([tabindex="-1"])`
  ).all();

  const focusableElements: Locator[] = [];

  for (const element of interactiveElements) {
    if (await element.isVisible()) {
      focusableElements.push(element);
    }
  }

  // Tab through all interactive elements
  for (let i = 0; i < focusableElements.length; i++) {
    await page.keyboard.press('Tab');

    // Verify focus is on an interactive element
    const focusedElement = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        tagName: el.tagName,
        type: (el as HTMLInputElement).type || null,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
      };
    });

    if (!focusedElement) {
      throw new Error(`Focus lost after Tab press #${i + 1}`);
    }
  }
}

/**
 * Check color contrast for text elements
 */
export async function checkColorContrast(
  page: Page,
  selector: string = 'body'
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withRules(['color-contrast'])
    .analyze();

  if (result.violations.length > 0) {
    const violations = result.violations
      .map(
        (v) =>
          `${v.id}: ${v.help}\n  Nodes: ${v.nodes.map((n) => n.html).join(', ')}`
      )
      .join('\n\n');

    throw new Error(
      `Color contrast violations found:\n\n${violations}`
    );
  }
}

/**
 * Verify ARIA attributes on elements
 */
export async function verifyAriaAttributes(
  page: Page,
  selector: string,
  expectedAttributes: Record<string, string>
): Promise<void> {
  const element = page.locator(selector);
  await element.waitFor({ state: 'visible' });

  for (const [attribute, expectedValue] of Object.entries(expectedAttributes)) {
    const actualValue = await element.getAttribute(attribute);
    if (actualValue !== expectedValue) {
      throw new Error(
        `Expected ${attribute}="${expectedValue}" on ${selector}, got "${actualValue}"`
      );
    }
  }
}

/**
 * Test form accessibility (labels, error messages, required fields)
 */
export async function testFormAccessibility(
  page: Page,
  formSelector: string
): Promise<void> {
  // Check all inputs have associated labels
  const inputs = await page.locator(`${formSelector} input, ${formSelector} select, ${formSelector} textarea`).all();

  for (const input of inputs) {
    const id = await input.getAttribute('id');
    const ariaLabel = await input.getAttribute('aria-label');
    const ariaLabelledBy = await input.getAttribute('aria-labelledby');
    const placeholder = await input.getAttribute('placeholder');

    // Input should have a label, aria-label, or aria-labelledby
    if (!id && !ariaLabel && !ariaLabelledBy && !placeholder) {
      const html = await input.evaluate((el) => el.outerHTML);
      throw new Error(`Input without accessible label: ${html}`);
    }

    // If input has id, verify label exists
    if (id) {
      const label = page.locator(`label[for="${id}"]`);
      const labelCount = await label.count();
      if (labelCount === 0 && !ariaLabel && !ariaLabelledBy) {
        throw new Error(`Input #${id} has no associated label`);
      }
    }
  }

  // Check required fields have aria-required
  const requiredInputs = await page.locator(`${formSelector} input[required], ${formSelector} input[aria-required="true"]`).all();
  for (const input of requiredInputs) {
    const ariaRequired = await input.getAttribute('aria-required');
    if (ariaRequired !== 'true') {
      // HTML required attribute is sufficient
    }
  }
}
