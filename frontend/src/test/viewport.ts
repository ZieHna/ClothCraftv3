/** jsdom has no matchMedia. setViewportWidth() picks phone or desktop; min-width / max-width queries are evaluated. */
let width = 1280;
export function setViewportWidth(next: number): void {
  width = next;
}

function matches(query: string): boolean {
  const max = /max-width:\s*([\d.]+)px/.exec(query);
  const min = /min-width:\s*([\d.]+)px/.exec(query);
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
}

export function installMatchMedia(): void {
  window.matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return matches(query);
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}
