FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY omniarena_rating ./omniarena_rating

# Periodic refit loop by default; override the command for a one-shot run.
CMD ["python", "-m", "omniarena_rating", "--loop"]
