FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    APP_HOST=0.0.0.0 PORT=10000 APP_HTTPS=1 \
    APP_DATA_DIR=/tmp/conta-clara-cache APP_REQUIRE_EXTERNAL_STORAGE=1
RUN --mount=type=secret,id=build_ca,target=/tmp/build-ca,mode=0444 \
    if [ -f /tmp/build-ca ]; then export SSL_CERT_FILE=/tmp/build-ca; \
    printf 'Acquire::https::CaInfo "/tmp/build-ca";\n' > /etc/apt/apt.conf.d/99build-ca; fi \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-por tesseract-ocr-eng poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99build-ca
WORKDIR /app
COPY requirements.lock.txt ./
RUN --mount=type=secret,id=build_ca,target=/tmp/build-ca,mode=0444 \
    if [ -f /tmp/build-ca ]; then export PIP_CERT=/tmp/build-ca; fi \
    && pip install --no-cache-dir --disable-pip-version-check -r requirements.lock.txt
COPY app ./app
COPY run.py ./
RUN useradd --create-home --uid 10001 conta && chown -R conta:conta /app
USER conta
EXPOSE 10000
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--timeout", "120", "--bind", "0.0.0.0:10000", "run:app"]
