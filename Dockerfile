FROM odoo:19.0-20261015

USER root
# Python libraries for the DSS (forecasting, recommendations, segmentation).
# The image's Python 3.12 is "externally managed" (PEP 668), so pip refuses
# without --break-system-packages. Safe here: the container is single-purpose.
# B8 step 0: exact pins, read from the running container on 2026-10-26 (pip freeze), so a rebuild gives the same libraries and the DSS
# results stay reproducible. These are every package the line below adds or changes on top of odoo:19.0-20261015 (python-dateutil is
# upgraded from the base image's 2.8.2, as it already was before pinning).
RUN pip3 install --no-cache-dir --break-system-packages \
        pandas==3.1.0 numpy==2.5.4 statsmodels==0.15.0 scikit-learn==1.9.1 scipy==1.18.1 \
        patsy==1.0.3 joblib==1.6.0 threadpoolctl==3.7.0 formulaic==1.2.2 interface_meta==2.0.1 narwhals==2.27.1 \
        cloudpickle==3.1.2 wrapt==2.5.1 packaging==26.3 python-dateutil==3.0.0 tzdata==2026.5
USER odoo
