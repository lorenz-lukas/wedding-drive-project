FROM python:3.13-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-lobster \
    fonts-dejavu-core \
    fonts-liberation \
    && pip install -U pip \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir qrcode[pil] Pillow

# Copy scripts
COPY scripts/generate-qrcode.py ./scripts/

# Default command: generate QR code
CMD ["python3", "scripts/generate-qrcode.py"]
