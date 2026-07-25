FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY omniarena_rating ./omniarena_rating

# Periodic refit loop by default, including the style-controlled pass: the
# dashboard's style panels have no other writer, so an image that skips it is
# only half a deployment. Override the command for a one-shot or default-only
# run.
CMD ["python", "-m", "omniarena_rating", "--loop", "--style"]
