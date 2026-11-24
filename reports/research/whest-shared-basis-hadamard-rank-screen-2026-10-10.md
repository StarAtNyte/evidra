# Shared-basis Hadamard closure rank screen (2026-10-10)

## Question

Can the old-source K3 interactions be kept in a small shared factor basis by
compressing products of shared-basis vectors, instead of rebuilding dense
source legs? For source factors `A = Q F` and `P = Q G`, their elementwise
product lies in the span of columns `q_i ⊙ q_j`, with up to `r(r+1)/2`
columns. TensorSketch or a shared product basis would only help if this span
has rapidly decaying singular values at a rank far below width `n`.

## Synthetic structural screen

Generated one Gaussian matrix per rank, orthonormalized its columns to form
`Q ∈ R^(1024×r)`, built `H[:,(i,j)] = Q[:,i] ⊙ Q[:,j]` for `i≤j`, and measured
the fraction of `H`'s squared singular-value mass in the top `m` directions.
This is a basis-geometry diagnostic, not a candidate estimator or score.

| Shared rank `r` | Product columns | Fraction captured at `m=256` | `m=512` | `m=768` |
|---:|---:|---:|---:|---:|
| 32 | 528 | 0.811 | 0.997 | 1.000* |
| 64 | 2,080 | 0.538 | 0.807 | 0.946 |
| 128 | 8,256 | 0.394 | 0.666 | 0.866 |
| 256 | 32,896 | 0.323 | 0.587 | 0.814 |

`*` At `r=32`, the product matrix has rank 528, so 768 captures its full
column space.

## Decision and limits

The isotropic random-basis proxy does not support an aggressively compressed
product basis at ranks 64–256: preserving even 80–90% of product energy needs
`m` close to width, erasing most of the intended transport-cost saving. This
weakens the proposed TensorSketch/shared-product-basis route; it does not
measure the V30 K3 output error, because the actual V30 shared basis and
source-weighted contractions may be non-isotropic. Do not implement or promote
this as an estimator change on this evidence alone.

If this avenue is revisited, first capture the actual V30 `Q` and source
coefficient factors and test **contraction-weighted** error on untouched
networks. The raw product-energy proxy is only a cheap screening statistic.
The underlying idea was motivated by fast TensorSketch approximations of
elementwise functions of low-rank matrices ([Han et al., 2020](https://proceedings.mlr.press/v119/han20a/han20a.pdf));
their generic sketch variance grows with degree and does not guarantee that
this specific old-source contraction is compressible.
