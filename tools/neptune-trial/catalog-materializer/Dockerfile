# Public registry manifest verified 2026-09-09. Both linux/amd64 and linux/arm64.
FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.lock ./requirements.lock
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock
COPY materialize.py inventory_census.py worker.py supervisor.py test_materialize.py test_inventory_census.py test_supervisor.py ./
COPY coverage_report.py test_coverage_report.py test_inventory_integration.py ./
RUN python -m unittest discover -s . -p 'test_*.py' -v
USER 10001:10001
ENTRYPOINT ["python", "/app/supervisor.py"]
