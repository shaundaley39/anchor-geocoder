/**
 * A static k-d tree that does not own its coordinates.
 *
 * `kdbush` copies every coordinate into arrays of its own, duplicating what the
 * artifact already holds: 128MB on the four-country build, 490MB at fourteen.
 * This keeps only the permutation and reads through an accessor, which is
 * affordable because a range query touches only the nodes on its path.
 * Coordinates stay raw fixed-point integers, so comparisons are exact.
 */

export type CoordFn = (id: number) => number;

export class PointIndex {
  /** Point ids in k-d tree order, and the only thing this retains. */
  private readonly ids!: Uint32Array;
  private readonly nodeSize!: number;
  private readonly getX!: CoordFn;
  private readonly getY!: CoordFn;

  /**
   * Adopts a permutation computed at build time, which is the path the server
   * takes: partitioning in-process cost 3.0s of startup, on every replica on
   * every deploy. `nodeSize` must match what produced the permutation, which is
   * why the artifact records it.
   */
  static fromPermutation(
    ids: Uint32Array, getX: CoordFn, getY: CoordFn, nodeSize: number,
  ): PointIndex {
    const idx = Object.create(PointIndex.prototype) as {
      ids: Uint32Array; nodeSize: number; getX: CoordFn; getY: CoordFn;
    };
    idx.ids = ids;
    idx.nodeSize = nodeSize;
    idx.getX = getX;
    idx.getY = getY;
    return idx as unknown as PointIndex;
  }

  /**
   * Builds the permutation in-process; used by tests.
   *
   * @param scratch  Partition against temporary contiguous arrays. Faster, but
   * costs 8 bytes per point on peak RSS, which is what an OOM killer watches, so
   * the default trades boot time for headroom.
   */
  constructor(count: number, getX: CoordFn, getY: CoordFn, nodeSize = 64, scratch = false) {
    this.getX = getX;
    this.getY = getY;
    this.nodeSize = nodeSize;

    this.ids = new Uint32Array(count);
    for (let i = 0; i < count; i++) this.ids[i] = i;
    if (count === 0) return;

    if (scratch) {
      const xs = new Int32Array(count);
      const ys = new Int32Array(count);
      for (let i = 0; i < count; i++) {
        xs[i] = getX(i);
        ys[i] = getY(i);
      }
      this.sortKD(xs, ys, 0, count - 1, 0);
    } else {
      this.sortKD(null, null, 0, count - 1, 0);
    }
  }

  /** Coordinate of the point currently at position `i`, on the given axis. */
  private at(xs: Int32Array | null, ys: Int32Array | null, i: number, axis: number): number {
    if (xs !== null) return (axis === 0 ? xs : ys!)[i]!;
    const id = this.ids[i]!;
    return axis === 0 ? this.getX(id) : this.getY(id);
  }

  get length(): number { return this.ids.length; }

  /** The tree structure ends up encoded entirely by position. */
  private sortKD(xs: Int32Array | null, ys: Int32Array | null, left: number, right: number, axis: number): void {
    if (right - left <= this.nodeSize) return;
    const mid = (left + right) >> 1;
    this.select(xs, ys, mid, left, right, axis);
    this.sortKD(xs, ys, left, mid - 1, 1 - axis);
    this.sortKD(xs, ys, mid + 1, right, 1 - axis);
  }

  /** Floyd–Rivest quickselect. Only the median position matters, so sorting
   * would be wasteful. */
  private select(
    xs: Int32Array | null, ys: Int32Array | null,
    k: number, left: number, right: number, axis: number,
  ): void {
    const v = (i: number) => this.at(xs, ys, i, axis);

    while (right > left) {
      if (right - left > 600) {
        // Recurse on a sample to pick tight bounds.
        const n = right - left + 1;
        const m = k - left + 1;
        const z = Math.log(n);
        const s = 0.5 * Math.exp((2 * z) / 3);
        const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (m - n / 2 < 0 ? -1 : 1);
        const newLeft = Math.max(left, Math.floor(k - (m * s) / n + sd));
        const newRight = Math.min(right, Math.floor(k + ((n - m) * s) / n + sd));
        this.select(xs, ys, k, newLeft, newRight, axis);
      }

      const t = v(k);
      let i = left;
      let j = right;

      this.swap(xs, ys, left, k);
      if (v(right) > t) this.swap(xs, ys, left, right);

      while (i < j) {
        this.swap(xs, ys, i, j);
        i++;
        j--;
        while (v(i) < t) i++;
        while (v(j) > t) j--;
      }

      if (v(left) === t) this.swap(xs, ys, left, j);
      else {
        j++;
        this.swap(xs, ys, j, right);
      }

      if (j <= k) left = j + 1;
      if (k <= j) right = j - 1;
    }
  }

  private swap(xs: Int32Array | null, ys: Int32Array | null, i: number, j: number): void {
    if (xs !== null) {
      const tx = xs[i]!; xs[i] = xs[j]!; xs[j] = tx;
      const ty = ys![i]!; ys![i] = ys![j]!; ys![j] = ty;
    }
    const ti = this.ids[i]!; this.ids[i] = this.ids[j]!; this.ids[j] = ti;
  }

  /** Visits every point inside the box, in no particular order. */
  range(
    minX: number, minY: number, maxX: number, maxY: number, visit: (id: number) => void,
  ): void {
    if (this.ids.length === 0) return;
    // Explicit stack, to keep the hot loop allocation-free.
    const stack: number[] = [0, this.ids.length - 1, 0];

    while (stack.length > 0) {
      const axis = stack.pop()!;
      const right = stack.pop()!;
      const left = stack.pop()!;

      if (right - left <= this.nodeSize) {
        for (let i = left; i <= right; i++) {
          const id = this.ids[i]!;
          const x = this.getX(id);
          const y = this.getY(id);
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) visit(id);
        }
        continue;
      }

      const mid = (left + right) >> 1;
      const id = this.ids[mid]!;
      const x = this.getX(id);
      const y = this.getY(id);
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) visit(id);

      // Descend only into the halves the box can reach.
      const lo = axis === 0 ? minX : minY;
      const hi = axis === 0 ? maxX : maxY;
      const split = axis === 0 ? x : y;
      if (lo <= split) stack.push(left, mid - 1, 1 - axis);
      if (hi >= split) stack.push(mid + 1, right, 1 - axis);
    }
  }
}
