"""Self-contained full-covariance estimator for WhestBench Phase 2.

The archive contains only this file, so it must not import starter-kit examples.
"""

from __future__ import annotations

import flopscope as flops
import flopscope.numpy as fnp
from whestbench import BaseEstimator, SetupContext
from whestbench.domain import MLP


_COV_RESCALE_THRESHOLD = 1e30


class Estimator(BaseEstimator):
    """Propagate mean and full covariance through linear/ReLU layers."""

    def __init__(self) -> None:
        self._setup_rng = None

    def setup(self, ctx: SetupContext) -> None:
        self._setup_rng = fnp.random.default_rng(ctx.seed)

    def predict(self, mlp: MLP, budget: int) -> fnp.ndarray:
        del budget
        width = mlp.width
        _ = fnp.random.default_rng(mlp.seed)
        mu = fnp.zeros(width, dtype=fnp.float32)
        cov = flops.as_symmetric(fnp.eye(width, dtype=fnp.float32), symmetry=(0, 1))
        log_scale = 0.0
        rows = []

        for w in mlp.weights:
            max_var = float(fnp.max(fnp.diag(cov)))
            if max_var > _COV_RESCALE_THRESHOLD:
                scale = float(fnp.sqrt(max_var))
                mu = mu / scale
                cov = cov / (scale * scale)
                log_scale += float(fnp.log(scale))

            mu_pre = w.T @ mu
            cov_pre = fnp.einsum("ij,ia,jb->ab", cov, w, w)
            var_pre = fnp.maximum(fnp.diag(cov_pre), 1e-12)
            sigma_pre = fnp.sqrt(var_pre)
            alpha = mu_pre / sigma_pre
            phi = flops.stats.norm.pdf(alpha).astype(fnp.float32)
            Phi = flops.stats.norm.cdf(alpha).astype(fnp.float32)

            mu = mu_pre * Phi + sigma_pre * phi
            ez2 = (mu_pre * mu_pre + var_pre) * Phi + mu_pre * sigma_pre * phi
            var_post = fnp.maximum(ez2 - mu * mu, 0.0)

            zero32 = fnp.zeros((), dtype=fnp.float32)
            gain = fnp.where(sigma_pre > 1e-12, Phi, zero32)
            cov = fnp.multiply(fnp.outer(gain, gain), cov_pre)
            fnp.fill_diagonal(cov, var_post)
            cov = flops.as_symmetric(cov, symmetry=(0, 1))
            rows.append(mu * float(fnp.exp(log_scale)))

        return fnp.stack(rows, axis=0)
