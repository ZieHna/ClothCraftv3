/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setViewportWidth } from '../test/viewport';
import { ModeChooser } from './ModeChooser';
import { SwitchModeDialog } from './SwitchModeDialog';
import { isProEditorEnabled } from './flags';

describe('feature flag', () => {
  it('is off by default and on only for exactly "true"', () => {
    vi.stubEnv('VITE_PRO_EDITOR', '');
    expect(isProEditorEnabled()).toBe(false);
    vi.stubEnv('VITE_PRO_EDITOR', 'false');
    expect(isProEditorEnabled()).toBe(false);
    vi.stubEnv('VITE_PRO_EDITOR', 'true');
    expect(isProEditorEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('ModeChooser', () => {
  it('shows both cards, the Recommended mark and the warning', () => {
    render(<ModeChooser onChoose={() => {}} />);
    expect(screen.getByRole('radio', { name: /simple/i })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /pro/i })).toBeEnabled();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByText(/Quick and easy\. Add text, pictures and shapes\. Works on phone and computer\./)).toBeInTheDocument();
    expect(screen.getByText(/A full editor with advanced tools\. Best on a computer\./)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Heads up: a design can’t be moved between Simple and Pro. To switch later, you’ll start a new design.');
  });

  it('disables Pro on a phone-width screen and cannot choose it', async () => {
    setViewportWidth(390);
    const onChoose = vi.fn();
    render(<ModeChooser onChoose={onChoose} />);
    const pro = screen.getByRole('radio', { name: /pro/i });
    expect(pro).toBeDisabled();
    expect(screen.getByText(/not available on a phone/i)).toBeInTheDocument();
    await userEvent.click(pro);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onChoose).toHaveBeenCalledWith('simple');
  });

  it('is fully keyboard operable: tab to the group, arrow to Pro, tab to Continue, Enter', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(<ModeChooser onChoose={onChoose} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: /simple/i })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /pro/i })).toBeChecked();
    await user.tab();
    expect(screen.getByRole('button', { name: /continue with pro/i })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChoose).toHaveBeenCalledWith('pro');
  });

  it('draws a visible focus ring on the card, since the radio itself is hidden', () => {
    render(<ModeChooser onChoose={() => {}} />);
    const card = screen.getByRole('radio', { name: /simple/i }).closest('label')!;
    expect(card.className).toMatch(/has-focus-visible:outline-3/);
    expect(card.className).toMatch(/has-focus-visible:outline-ink/);
  });
});

describe('SwitchModeDialog', () => {
  it('says unsaved work is lost and never mentions a draft being kept', () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    render(<SwitchModeDialog open onConfirm={() => {}} onCancel={() => {}} />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/starts a new design/);
    expect(text).toMatch(/unsaved work will\s+be lost/);
    expect(text).not.toMatch(/draft|saved for later|kept/i);
  });
});

/** WCAG 2.x contrast of the colour pairs the chooser uses, with the real tokens read from index.css. */
describe('chooser contrast', () => {
  const css = readFileSync('src/index.css', 'utf8');
  const token = (name: string) => {
    const hex = new RegExp(String.raw`--color-${name}:\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];
    if (!hex) throw new Error(`token ${name} missing`);
    return hex;
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(token(a)), lum(token(b))].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const text: Array<[string, string, string]> = [
    ['card title', 'ink', 'cream'],
    ['card title, selected', 'ink', 'paper-warm'],
    ['card body', 'text', 'cream'],
    ['card body, selected', 'text', 'paper-warm'],
    ['Pro note, disabled', 'muted', 'paper-warm'],
    ['Pro text, disabled', 'text', 'paper-warm'],
    ['Recommended badge', 'cream', 'sage-dark'],
    ['warning', 'text', 'cream'],
    ['Continue button', 'cream', 'sage-dark'],
  ];
  it.each(text)('%s is at least 4.5:1', (_label, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it('selected-card ring and focus outline (ink) clear 3:1 against the page', () => {
    expect(ratio('ink', 'paper-warm')).toBeGreaterThanOrEqual(3);
    expect(ratio('brown-dark', 'cream')).toBeGreaterThanOrEqual(3);
  });
});
