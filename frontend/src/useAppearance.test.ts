// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAppearance, useAppearance } from './useAppearance';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('console appearance', () => {
  it('persists a mode switch across initialization', () => {
    localStorage.setItem('commandcode-appearance', 'dark');
    initAppearance();
    const appearance = useAppearance();
    expect(appearance.isDark.value).toBe(true);
    appearance.toggleAppearance();
    expect(localStorage.getItem('commandcode-appearance')).toBe('light');
    initAppearance();
    expect(appearance.isDark.value).toBe(false);
    expect(document.documentElement.dataset.appearance).toBe('light');
  });
  it('keeps working when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    initAppearance();
    expect(useAppearance().isDark.value).toBe(true);
    expect(() => useAppearance().toggleAppearance()).not.toThrow();
    expect(document.documentElement.dataset.appearance).toBe('light');
  });
});
