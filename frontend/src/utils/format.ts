/**
 * Formats a number with thousand separators and abbreviates large values.
 * Example: 1234567 -> 1.23M
 * Example: 1234 -> 1,234
 */
export const formatNumber = (num: number | string | bigint): string => {
  const value = typeof num === 'string' ? parseFloat(num) : Number(num);
  
  if (isNaN(value)) return '0';

  // Abbreviate only large numbers (Millions and Billions)
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(2).replace(/\.00$/, '') + 'B';
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value);
};

/**
 * Formats currency amounts using the formatNumber utility.
 */
export const formatCurrency = (value: number, currency: string): string => {
  const formatted = formatNumber(value);
  
  if (currency === "XLM") {
    return `${formatted} XLM`;
  }
  
  try {
    // We want the currency symbol if possible, but still use our abbreviation logic.
    // If we use Intl.NumberFormat with currency style, it won't abbreviate.
    // So we'll just prepend/append the currency code/symbol.
    const symbol = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(0).replace(/[0.0\s]/g, '');
    
    return `${symbol}${formatted}`;
  } catch (e) {
    return `${formatted} ${currency}`;
  }
};
