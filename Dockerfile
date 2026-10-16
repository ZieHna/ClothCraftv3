FROM odoo:19.0-20261015

USER root
# Python libraries for the DSS (forecasting, recommendations, segmentation).
# The image's Python 3.12 is "externally managed" (PEP 668), so pip refuses
# without --break-system-packages. Safe here: the container is single-purpose.
RUN pip3 install --no-cache-dir --break-system-packages pandas statsmodels scikit-learn
USER odoo
