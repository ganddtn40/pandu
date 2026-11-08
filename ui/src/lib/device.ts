export const MOBILE_GLASS_SHAPES = 12;
export const DESKTOP_GLASS_SHAPES = 16;

export interface DeviceProfile {
  mobile: boolean;
  lowEnd: boolean;
  batterySaver: boolean;
  saveData: boolean;
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

interface BatteryLike {
  charging: boolean;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryLike>;
}

/** One shared profile so the glass engine and design init agree. */
export function readDeviceProfile(): DeviceProfile {
  if (typeof window === 'undefined') {
    return { mobile: false, lowEnd: false, batterySaver: false, saveData: false };
  }
  const hints = navigator as NavigatorWithHints;
  const mobile =
    window.matchMedia('(max-width: 720px)').matches ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = hints.deviceMemory ?? 8;
  const saveData = hints.connection?.saveData === true;
  return {
    mobile,
    lowEnd: cores <= 4 || memory <= 4,
    batterySaver: saveData,
    saveData,
  };
}

/** Cap WebGL shapes on phones and low-end machines. */
export function glassShapeCap(profile: DeviceProfile = readDeviceProfile()): number {
  return profile.mobile || profile.lowEnd ? MOBILE_GLASS_SHAPES : DESKTOP_GLASS_SHAPES;
}

export function shouldAutoPerformance(profile: DeviceProfile = readDeviceProfile()): boolean {
  return profile.lowEnd || profile.batterySaver;
}

/** Battery saver is read once, after the synchronous profile. */
export async function lowBattery(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const battery = (navigator as NavigatorWithBattery).getBattery;
  if (!battery) return false;
  try {
    const status = await battery.call(navigator);
    return !status.charging && status.level <= 0.2;
  } catch {
    return false;
  }
}
