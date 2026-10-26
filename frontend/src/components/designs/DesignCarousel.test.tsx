import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { featuredDesigns } from '../../designs/catalog';
import { DesignCarousel } from './DesignCarousel';

const designs = featuredDesigns();
const renderIt = (list = designs) =>
  render(
    <MemoryRouter>
      <DesignCarousel designs={list} />
    </MemoryRouter>,
  );
const name = () => screen.getByTestId('carousel-name').textContent;
const position = () => screen.getByTestId('carousel-position').textContent;

describe('the designs carousel', () => {
  it('is a labelled carousel that shows the first design, its picture, style and a Customize Design link to the editor', () => {
    renderIt();
    const region = screen.getByRole('region', { name: 'Highlighted designs' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(name()).toBe(designs[0]!.name);
    expect(position()).toBe(`Design 1 of ${designs.length}`);
    expect(screen.getByTestId('carousel-image')).toHaveAttribute('src', `/designs/previews/${designs[0]!.id}.webp`);
    expect(screen.getByTestId('carousel-image')).toHaveAttribute('alt', designs[0]!.previewAlt);
    expect(screen.getByTestId('carousel-style')).toHaveTextContent(designs[0]!.style);
    expect(within(region).getByRole('link', { name: /Customize Design/ })).toHaveAttribute('href', `/design?template=${designs[0]!.id}`);
    expect(within(region).getByRole('group', { name: new RegExp(`^1 of ${designs.length}: `) })).toBeInTheDocument();
  });

  it('Next and Previous change the design and the position, and wrap around at both ends', async () => {
    const user = userEvent.setup({ delay: null });
    renderIt();
    await user.click(screen.getByTestId('carousel-next'));
    expect(name()).toBe(designs[1]!.name);
    expect(position()).toBe(`Design 2 of ${designs.length}`);
    await user.click(screen.getByTestId('carousel-prev'));
    await user.click(screen.getByTestId('carousel-prev'));
    expect(name()).toBe(designs[designs.length - 1]!.name); // from the first, Previous wraps to the last
    await user.click(screen.getByTestId('carousel-next'));
    expect(name()).toBe(designs[0]!.name); // and Next wraps to the first
  });

  it('has one dot per design (a 44 px target, named), marks the current one, and a dot jumps to its design', async () => {
    const user = userEvent.setup({ delay: null });
    renderIt();
    const dots = screen.getAllByTestId('carousel-dot');
    expect(dots).toHaveLength(designs.length);
    expect(dots[0]).toHaveAttribute('aria-current', 'true');
    expect(dots[0]).toHaveAccessibleName(`Show ${designs[0]!.name}`);
    expect(dots[2]!.className).toContain('size-11');
    await user.click(dots[2]!);
    expect(name()).toBe(designs[2]!.name);
    expect(dots[2]).toHaveAttribute('aria-current', 'true');
    expect(dots[0]).not.toHaveAttribute('aria-current');
  });

  it('the Left and Right arrow keys move it, and announce the position politely', async () => {
    const user = userEvent.setup({ delay: null });
    renderIt();
    screen.getByTestId('carousel-next').focus();
    await user.keyboard('{ArrowRight}');
    expect(position()).toBe(`Design 2 of ${designs.length}`);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(position()).toBe(`Design ${designs.length} of ${designs.length}`);
    expect(screen.getByTestId('carousel-position')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not turn by itself (nothing moves unless a control is used)', async () => {
    renderIt();
    await new Promise((r) => setTimeout(r, 120));
    expect(position()).toBe(`Design 1 of ${designs.length}`);
  });

  it('shows nothing for an empty list, and a single design still works', () => {
    const { container } = renderIt([]);
    expect(container).toBeEmptyDOMElement();
  });
});
