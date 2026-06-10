/**
 * Uniform spatial hash grid rebuilt every frame with a counting sort.
 * Zero allocations per frame; entities outside the grid clamp to edge cells.
 * The grid recenters on the player each build, so it only needs to cover
 * the active bubble of gameplay, not the whole world.
 */
export class SpatialGrid {
  readonly cellSize: number;
  readonly dim: number;
  readonly cellStart: Int32Array; // dim*dim + 1, start offset per cell into `indices`
  readonly indices: Int32Array;   // entity ids, grouped by cell
  private readonly cursor: Int32Array;
  private readonly cellOf: Int32Array;
  originX = 0;
  originZ = 0;

  constructor(cellSize: number, dim: number, capacity: number) {
    this.cellSize = cellSize;
    this.dim = dim;
    this.cellStart = new Int32Array(dim * dim + 1);
    this.indices = new Int32Array(capacity);
    this.cursor = new Int32Array(dim * dim);
    this.cellOf = new Int32Array(capacity);
  }

  build(px: Float32Array, pz: Float32Array, count: number, centerX: number, centerZ: number): void {
    const { cellSize, dim, cellStart, indices, cursor, cellOf } = this;
    const half = dim * cellSize * 0.5;
    this.originX = centerX - half;
    this.originZ = centerZ - half;
    const ox = this.originX, oz = this.originZ, maxC = dim - 1;

    cursor.fill(0);
    for (let i = 0; i < count; i++) {
      let cx = ((px[i] - ox) / cellSize) | 0;
      if (cx < 0) cx = 0; else if (cx > maxC) cx = maxC;
      let cz = ((pz[i] - oz) / cellSize) | 0;
      if (cz < 0) cz = 0; else if (cz > maxC) cz = maxC;
      const c = cz * dim + cx;
      cellOf[i] = c;
      cursor[c]++;
    }

    let sum = 0;
    const cells = dim * dim;
    for (let c = 0; c < cells; c++) {
      cellStart[c] = sum;
      sum += cursor[c];
      cursor[c] = cellStart[c];
    }
    cellStart[cells] = sum;

    for (let i = 0; i < count; i++) {
      indices[cursor[cellOf[i]]++] = i;
    }
  }

  cellX(x: number): number {
    let c = ((x - this.originX) / this.cellSize) | 0;
    return c < 0 ? 0 : c > this.dim - 1 ? this.dim - 1 : c;
  }

  cellZ(z: number): number {
    let c = ((z - this.originZ) / this.cellSize) | 0;
    return c < 0 ? 0 : c > this.dim - 1 ? this.dim - 1 : c;
  }
}
