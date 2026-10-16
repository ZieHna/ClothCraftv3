FROM odoo:19.0-20261015

USER root
# Python libraries for the DSS (forecasting, recommendations, segmentation).
RUN pip3 install --no-cache-dir pandas statsmodels scikit-learn
USER odoo
