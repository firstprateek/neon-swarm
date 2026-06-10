const keys = new Set<string>();

window.addEventListener('keydown', e => {
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const move = { x: 0, z: 0 };

export function getMove(): { x: number; z: number } {
  let x = 0, z = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) z -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) z += 1;
  if (x !== 0 && z !== 0) {
    const inv = 1 / Math.SQRT2;
    x *= inv; z *= inv;
  }
  move.x = x; move.z = z;
  return move;
}
