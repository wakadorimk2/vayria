/** Hidden panels retain layout boxes, but must not reserve prop space. */
export function isPlacementObstacleVisible(node: HTMLElement): boolean {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
  }
  return true;
}
