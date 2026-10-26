# Pinned: python 3.12.15 on Debian trixie. Direct dependencies are pinned in requirements.txt and the full tree in
# requirements.lock (pip freeze after installing them). Rebuild the lock when requirements.txt changes.
FROM python:3.12.15-slim-trixie
WORKDIR /srv
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock
COPY app ./app
COPY tests ./tests
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
