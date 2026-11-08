import { describe, expect, it } from 'vitest';
import {
  DESKTOP_GLASS_SHAPES,
  MOBILE_GLASS_SHAPES,
  glassShapeCap,
  shouldAutoPerformance,
  type DeviceProfile,
} from '../../src/lib/device';

const desktop: DeviceProfile = {
  mobile: false,
  lowEnd: false,
  batterySaver: false,
  saveData: false,
};

describe('glass shape budget', () => {
  it('caps desktop at 16 and phones or low-end machines at 12', () => {
    expect(DESKTOP_GLASS_SHAPES).toBe(16);
    expect(MOBILE_GLASS_SHAPES).toBe(12);
    expect(glassShapeCap(desktop)).toBe(16);
    expect(glassShapeCap({ ...desktop, mobile: true })).toBe(12);
    expect(glassShapeCap({ ...desktop, lowEnd: true })).toBe(12);
  });
});

describe('automatic performance mode', () => {
  it('stays off on a capable machine', () => {
    expect(shouldAutoPerformance(desktop)).toBe(false);
  });

  it('turns on for low-end devices and battery saver', () => {
    expect(shouldAutoPerformance({ ...desktop, lowEnd: true })).toBe(true);
    expect(shouldAutoPerformance({ ...desktop, batterySaver: true })).toBe(true);
  });
});
