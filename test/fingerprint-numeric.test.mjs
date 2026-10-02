/**
 * The fingerprint's linear algebra, checked against closed-form answers.
 *
 * These routines are the numeric core of the attribution method, so they are
 * tested on inputs whose answers can be written down by hand — a Jacobi
 * decomposition that agrees with an analytically known spectrum is the evidence
 * that the SVD-based projection is doing what it claims.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  meanVector,
  columnScale,
  normalize,
  cosine,
  dotProduct,
  projectOut,
  jacobiEigen,
  topRightSingularVectors,
  softmax,
  standardize,
} from "../src/fingerprint/numeric.mjs";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("meanVector averages element-wise", () => {
  assert.deepEqual(meanVector([[1, 2], [3, 4]]), [2, 3]);
  assert.deepEqual(meanVector([]), []);
});

test("columnScale is population standard deviation, floored at 1", () => {
  const rows = [
    [1, 5],
    [3, 5],
  ];
  const scale = columnScale(rows, [2, 5]);
  assert.ok(close(scale[0], 1)); // sd of {1,3} is 1
  assert.equal(scale[1], 1); // a constant column is floored, not zero
});

test("normalize returns a unit vector and leaves the zero vector alone", () => {
  const n = normalize([3, 4]);
  assert.ok(close(Math.hypot(...n), 1));
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});

test("cosine is 1 for parallel and 0 for orthogonal", () => {
  assert.ok(close(cosine([1, 0], [2, 0]), 1));
  assert.ok(close(cosine([1, 0], [0, 1]), 0));
});

test("projectOut removes exactly the component along the basis", () => {
  // Remove x from (3,4): the basis is the x axis, so only y survives.
  const out = projectOut([3, 4], [[1, 0]]);
  assert.ok(close(out[0], 0));
  assert.ok(close(out[1], 4));
});

test("projectOut is a no-op against an empty basis", () => {
  assert.deepEqual(projectOut([1, 2], []), [1, 2]);
});

test("jacobiEigen recovers a known 2x2 spectrum", () => {
  // [[2,1],[1,2]] has eigenvalues 3 and 1.
  const { values } = jacobiEigen([
    [2, 1],
    [1, 2],
  ]);
  const sorted = [...values].sort((a, b) => b - a);
  assert.ok(close(sorted[0], 3, 1e-9));
  assert.ok(close(sorted[1], 1, 1e-9));
});

test("jacobiEigen is exact on a diagonal matrix", () => {
  const { values } = jacobiEigen([
    [5, 0],
    [0, 2],
  ]);
  const sorted = [...values].sort((a, b) => b - a);
  assert.ok(close(sorted[0], 5));
  assert.ok(close(sorted[1], 2));
});

test("topRightSingularVectors finds the dominant direction", () => {
  // Two rows that differ only along axis 0: the leading direction is axis 0.
  const rows = [
    [3, 0, 0],
    [-3, 0, 0],
  ];
  const basis = topRightSingularVectors(rows, 1);
  assert.equal(basis.length, 1);
  assert.ok(close(Math.abs(basis[0][0]), 1, 1e-9));
});

test("topRightSingularVectors returns nothing for a single row", () => {
  assert.deepEqual(topRightSingularVectors([[1, 2, 3]], 2), []);
});

test("topRightSingularVectors skips directions with no energy", () => {
  // One real direction; asking for two must not invent a second.
  const basis = topRightSingularVectors([[1, 0, 0], [-1, 0, 0]], 2);
  assert.equal(basis.length, 1);
});

test("softmax sums to one and preserves ordering", () => {
  const p = softmax([1, 2, 3]);
  assert.ok(close(p.reduce((a, b) => a + b, 0), 1, 1e-12));
  assert.ok(p[2] > p[1] && p[1] > p[0]);
});

test("softmax is stable for large scores", () => {
  const p = softmax([1000, 1001]);
  assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
  assert.ok(close(p[0] + p[1], 1, 1e-12));
});

test("standardize maps a constant vector to zeros", () => {
  assert.deepEqual(standardize([4, 4, 4]), [0, 0, 0]);
});

test("dotProduct is the plain inner product", () => {
  assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32);
});
