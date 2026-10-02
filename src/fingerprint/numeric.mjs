/**
 * fingerprint/numeric.mjs — linear algebra for the model fingerprint
 *
 * The whole method rests on one trick borrowed from ModelTrace (the method, not
 * the code): the same model, asked the same question in different environments,
 * answers with a systematic offset that has nothing to do with which model it
 * is. Estimate that offset direction across environments, project it out, and
 * what remains is the model's own bias.
 *
 * That needs a small SVD of a 355-dimension feature space. numpy is not a
 * dependency here, so the pieces we actually use are spelled out below. Every
 * routine is deliberately small and independently testable — this file has no
 * knowledge of models, probes or banks.
 */

/**
 * Mean of a set of equal-length vectors.
 * Returns a zero vector for an empty input rather than throwing: callers treat
 * "no environments to learn from" as "nothing to project out", which is a normal
 * state when only one environment has been collected.
 */
export function meanVector(vectors) {
  if (!vectors.length) return [];
  const width = vectors[0].length;
  const out = new Array(width).fill(0);
  for (const v of vectors) for (let i = 0; i < width; i++) out[i] += v[i];
  for (let i = 0; i < width; i++) out[i] /= vectors.length;
  return out;
}

/** Element-wise standard deviation across rows, with the ModelTrace floor of 1. */
export function columnScale(rows, means) {
  const n = rows.length;
  if (!n) return [];
  const width = rows[0].length;
  const out = new Array(width).fill(0);
  for (const row of rows) for (let i = 0; i < width; i++) out[i] += (row[i] - means[i]) ** 2;
  for (let i = 0; i < width; i++) {
    const sd = Math.sqrt(out[i] / n);
    // A feature that never varies carries no information; dividing by its real
    // (zero) scale would blow it up to NaN. ModelTrace floors it at 1 and so
    // does this.
    out[i] = sd < 1e-12 ? 1 : sd;
  }
  return out;
}

/** Normalize a vector to unit length; the zero vector is returned unchanged. */
export function normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return vec.slice();
  return vec.map((v) => v / norm);
}

/** Cosine similarity, guarding the zero vector. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d < 1e-12 ? 0 : dot / d;
}

/**
 * Project `vec` onto `basis` and subtract, i.e. remove the components of `vec`
 * that live in the span of the basis vectors. The basis is assumed orthonormal
 * (it comes out of topRightSingularVectors that way).
 */
export function projectOut(vec, basis) {
  const out = vec.slice();
  for (const axis of basis) {
    const c = dotProduct(out, axis);
    for (let i = 0; i < out.length; i++) out[i] -= c * axis[i];
  }
  return out;
}

export function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Top-k right singular vectors of `rows`, i.e. the principal directions of the
 * row set. This is the only nontrivial numerical piece the method needs, and it
 * is a fixed, tiny matrix (at most a handful of environments by 355 features).
 *
 * Implemented as the eigen-decomposition of the (small) Gram matrix rows·rowsᵀ
 * by cyclic Jacobi rotations — no iteration count to tune, no convergence
 * surprises, and the cost is bounded by the number of rows, not the number of
 * features. Returns directions in DESCENDING eigenvalue order, capped at `k`.
 *
 * Rows are expected to be the environment offsets already mean-centred by the
 * caller, matching what the original does before its SVD.
 */
export function topRightSingularVectors(rows, k = 2) {
  const m = rows.length;
  if (m < 2) return [];
  const width = rows[0].length;

  // Gram matrix G = rows · rowsᵀ  (m×m, m is tiny)
  const G = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      let s = 0;
      for (let t = 0; t < width; t++) s += rows[i][t] * rows[j][t];
      G[i][j] = s;
      G[j][i] = s;
    }
  }

  // Jacobi eigen-decomposition of the symmetric Gram matrix.
  const { values, vectors } = jacobiEigen(G);

  // Keep the k largest eigenvalues, ignore directions with no energy.
  const order = values
    .map((v, i) => [v, i])
    .filter(([v]) => v > 1e-12)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k);

  const basis = [];
  for (const [lambda, idx] of order) {
    // Right singular vector v = rowsᵀ · u / sqrt(lambda), where u is the
    // eigenvector of the Gram matrix. Renormalize for numerical comfort.
    const sigma = Math.sqrt(lambda);
    const u = vectors[idx];
    const v = new Array(width).fill(0);
    for (let r = 0; r < m; r++) {
      const coeff = u[r] / sigma;
      if (coeff === 0) continue;
      for (let c = 0; c < width; c++) v[c] += coeff * rows[r][c];
    }
    const n = normalize(v);
    // Drop a direction that collapsed to nothing (degenerate input).
    let norm = 0;
    for (const x of n) norm += x * x;
    if (norm > 1e-12) basis.push(n);
  }
  return basis;
}

/**
 * Cyclic Jacobi eigen-decomposition for a real symmetric matrix.
 * Returns eigenvalues (unsorted) and the matching eigenvectors as rows.
 */
export function jacobiEigen(matrix, maxSweeps = 60) {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  // Start from the identity so accumulated rotations give the eigenvectors.
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-20) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let i = 0; i < n; i++) {
          const aip = a[i][p];
          const aiq = a[i][q];
          a[i][p] = c * aip - s * aiq;
          a[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p][i];
          const aqi = a[q][i];
          a[p][i] = c * api - s * aqi;
          a[q][i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i][p];
          const viq = v[i][q];
          v[i][p] = c * vip - s * viq;
          v[i][q] = s * vip + c * viq;
        }
      }
    }
  }

  const values = new Array(n).fill(0);
  for (let i = 0; i < n; i++) values[i] = a[i][i];
  // Eigenvectors as rows of `vectors`.
  const vectors = Array.from({ length: n }, (_, i) => v.map((row) => row[i]));
  return { values, vectors };
}

/** Softmax over a score vector, with the max-subtraction for stability. */
export function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

/** Standardize to zero mean / unit variance; a constant vector maps to zeros. */
export function standardize(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const scale = Math.max(Math.sqrt(variance), 1e-12);
  return values.map((v) => (v - mean) / scale);
}
