/**
 * Shared client-side state for a filtered plate grid.
 *
 * Two independent controls sit above the log — the facet chips and the search
 * box — and both decide which plates belong on screen. If each simply set
 * `hidden` on the cards it rejected, the second to run would reveal what the
 * first had just hidden. So each records its own verdict under its own key and
 * a card is shown only when nothing is holding it back.
 *
 * Hiding is done with an attribute rather than the `hidden` property because
 * the grid's cells carry the shared hairline borders: a hidden cell has to
 * leave the grid entirely (`display: none`), or its borders stay behind.
 */

export type Reason = 'facet' | 'search';

const ATTR: Record<Reason, string> = {
  facet: 'data-out-facet',
  search: 'data-out-search',
};

/** Record one control's verdict on one card. */
export function setOut(card: HTMLElement, reason: Reason, out: boolean): void {
  if (out) card.setAttribute(ATTR[reason], '');
  else card.removeAttribute(ATTR[reason]);
}

export function isVisible(card: HTMLElement): boolean {
  return !card.hasAttribute(ATTR.facet) && !card.hasAttribute(ATTR.search);
}

export function visibleCards(cards: HTMLElement[]): HTMLElement[] {
  return cards.filter(isVisible);
}

/**
 * Re-run everything that depends on which plates are showing: the plate
 * numbers, which run 01, 02, 03 down the visible sequence rather than staying
 * with the entry they were rendered against, and the note that stands in for
 * an empty grid.
 *
 * Called by both controls after they have set their own verdicts, so the
 * result reflects the pair of them and not whichever ran last.
 */
export function refresh(grid: HTMLElement, message = 'Nothing here matches those filters.'): number {
  const cards = Array.from(grid.querySelectorAll<HTMLElement>('[data-search]'));
  const shown = visibleCards(cards);

  shown.forEach((card, i) => {
    const index = card.querySelector<HTMLElement>('[data-plate-index]');
    if (index) index.textContent = `PL. ${String(i + 1).padStart(2, '0')}`;
  });

  // The divider's tally, which stands above the grid rather than inside it:
  // "18 entries" while everything is showing, "6 of 18 entries" once anything
  // has been narrowed.
  for (const tally of document.querySelectorAll<HTMLElement>(`[data-count-for="${grid.id}"]`)) {
    const noun = tally.dataset.countNoun ?? 'entries';
    tally.textContent =
      shown.length === cards.length
        ? `${cards.length} ${noun}`
        : `${shown.length} of ${cards.length} ${noun}`;
  }

  let none = grid.querySelector<HTMLElement>('.cigar-grid__none');
  if (!none) {
    none = document.createElement('p');
    none.className = 'empty-state cigar-grid__none';
    none.hidden = true;
    grid.append(none);
  }
  none.textContent = message;
  none.hidden = shown.length > 0;

  return shown.length;
}
