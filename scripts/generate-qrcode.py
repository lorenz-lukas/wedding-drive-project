#!/usr/bin/env python3
"""
Generate QR code with D&J logo in lavender at center.
"""

import os
import sys
from pathlib import Path

try:
    import qrcode
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Error: Required packages not found.")
    print("Install with: pip install qrcode pillow")
    sys.exit(1)


def find_best_font():
    """Find the best cursive font available on the system."""
    font_paths = [
        "/usr/share/fonts/opentype/lobster/lobster.otf",
        "/usr/share/fonts/truetype/lobster/Lobster-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf",
    ]

    for path in font_paths:
        if os.path.exists(path):
            return path

    return None


def generate_qrcode():
    """Generate QR code with D&J logo in center."""

    # Configuration
    qr_url = "https://casamento-douglas-juliana.vercel.app/challenges/upload"
    output_dir = Path(__file__).parent.parent / "public" / "media"
    output_path = output_dir / "qrcode.png"

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Generating QR code for: {qr_url}")
    print(f"Output path: {output_path}")

    # Generate QR code
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=2,
    )
    qr.add_data(qr_url)
    qr.make(fit=True)

    # Create QR image
    qr_img = qr.make_image(fill_color="#000000", back_color="#ffffff").convert("RGB")
    qr_size = qr_img.size[0]

    # Create canvas with QR code
    canvas = Image.new("RGB", (qr_size, qr_size), color="#ffffff")
    canvas.paste(qr_img, (0, 0))

    # Draw D&J text in lavender at center
    draw = ImageDraw.Draw(canvas, "RGBA")
    center_x = qr_size / 2
    center_y = qr_size / 2

    # Draw D&J text in lavender at center
    font_path = find_best_font()

    if not font_path:
        print("No cursive font found in container. Falling back to default font.")
        font = ImageFont.load_default()
    else:
        # Compute the largest readable text size that fits in the center area.
        max_text_width = int(qr_size * 0.55)
        max_text_height = int(qr_size * 0.30)
        font = ImageFont.truetype(font_path, 32)
        for candidate in range(36, int(qr_size * 0.60), 4):
            test_font = ImageFont.truetype(font_path, candidate)
            test_bbox = draw.textbbox((0, 0), "D&J", font=test_font)
            test_width = test_bbox[2] - test_bbox[0]
            test_height = test_bbox[3] - test_bbox[1]
            if test_width <= max_text_width and test_height <= max_text_height:
                font = test_font
            else:
                break
        print(f"Using font: {font_path}")

    text = "D&J"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    text_x = center_x - text_width / 2 - bbox[0]
    text_y = center_y - text_height / 2 - bbox[1]

    # Draw text outline/shadow for better visibility
    outline_width = max(4, int(qr_size * 0.012))
    lavender_color = "#7d679f"
    outline_color = "#ffffff"

    # Draw outline
    for adj_x in range(-outline_width, outline_width + 1):
        for adj_y in range(-outline_width, outline_width + 1):
            if adj_x != 0 or adj_y != 0:
                draw.text(
                    (text_x + adj_x, text_y + adj_y),
                    text,
                    fill=outline_color,
                    font=font,
                )

    # Draw main text
    draw.text((text_x, text_y), text, fill=lavender_color, font=font)

    # Save image
    canvas.save(str(output_path), "PNG")

    print(f"✓ QR code generated successfully!")
    print(f"  File: {output_path}")
    print(f"  Size: {qr_size}x{qr_size}px")
    print(f"  URL: /media/qrcode.png")


if __name__ == "__main__":
    generate_qrcode()
