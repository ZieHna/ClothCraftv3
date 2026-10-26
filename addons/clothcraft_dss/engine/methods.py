"""Forecasting methods (B8 step 2). Each takes the training history y (weekly units, oldest first, already limited to the training
window) and a horizon H, and returns H point forecasts (numpy floats). NaN means the method does not apply to this series. Nothing here
reads the clock or a random source: the same history always gives the same forecast. Clipping at zero happens in forecast.py.
"""
import warnings

import numpy as np

ETS_MIN_WEEKS = 8      # Holt with a damped trend estimates 4 parameters; below this it is not fitted
SEASON = 52


def naive(y, H):
    """Next weeks = the last week."""
    return np.full(H, float(y[-1])) if len(y) else np.full(H, np.nan)


def moving_average(y, H, k=4):
    """Next weeks = the mean of the last k weeks (all weeks when there are fewer)."""
    return np.full(H, float(np.mean(y[-k:]))) if len(y) else np.full(H, np.nan)


def seasonal_naive(full_y, H, period=SEASON):
    """Week t+h = the same week one year earlier. Uses the FULL history (ramp-up weeks included): it is only a comparator.
    NaN where that week does not exist."""
    n = len(full_y)
    out = np.full(H, np.nan)
    for h in range(1, H + 1):
        i = n + h - 1 - period
        if 0 <= i < n:
            out[h - 1] = float(full_y[i])
    return out


def holt_damped(y, H):
    """ETS(A,Ad,N): additive error, additive damped trend, no seasonality (about 1.5 annual cycles exist, too few for a seasonal model).
    statsmodels' maximum-likelihood fit, deterministic."""
    if len(y) < ETS_MIN_WEEKS:
        return np.full(H, np.nan)
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        fit = ExponentialSmoothing(np.asarray(y, dtype=float), trend='add', damped_trend=True, seasonal=None,
                                   initialization_method='estimated').fit(optimized=True)
        return np.asarray(fit.forecast(H), dtype=float)


def croston_sba(y, H, alpha=0.1):
    """Croston's method with the Syntetos-Boylan bias correction, for intermittent series: exponential smoothing (alpha) of the non-zero
    demand sizes z and of the intervals p between them; forecast = (1 - alpha/2) * z / p for every week ahead. An all-zero history gives 0."""
    y = np.asarray(y, dtype=float)
    nz = np.flatnonzero(y > 0)
    if len(y) == 0:
        return np.full(H, np.nan)
    if len(nz) == 0:
        return np.zeros(H)
    z, p, last = y[nz[0]], float(nz[0] + 1), nz[0]
    for i in nz[1:]:
        z = alpha * y[i] + (1 - alpha) * z
        p = alpha * (i - last) + (1 - alpha) * p
        last = i
    return np.full(H, (1 - alpha / 2) * z / p)


def zero_share(y):
    return float(np.mean(np.asarray(y) == 0)) if len(y) else 1.0


METHODS = {'naive': naive, 'ma4': moving_average, 'ets': holt_damped, 'croston': croston_sba}
# the order used to break ties: simpler first
SIMPLICITY = ('naive', 'ma4', 'snaive', 'ets', 'croston', 'ets_croston')
