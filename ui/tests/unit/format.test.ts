import { describe, expect, it } from 'vitest';
import { formatUsd } from '../../src/lib/format';

describe('formatUsd', () => {
  it('labels an unknown price instead of showing a dash', () => {
    expect(formatUsd(0, 2, 'Price unknown')).toBe('Price unknown');
    expect(formatUsd(Number.NaN, 0, 'Price unknown')).toBe('Price unknown');
  });

  it('formats known prices', () => {
    expect(formatUsd(0, 0, 'Price unknown')).toBe('$0.00');
    expect(formatUsd(1.234, 0, 'Price unknown')).toBe('$1.23');
    expect(formatUsd(0.004, 0, 'Price unknown')).toBe('<$0.01');
  });
});
