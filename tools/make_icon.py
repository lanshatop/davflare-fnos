"""生成 Davflare 的飞牛应用图标。

产出：
  ICON.PNG        64x64    （fnOS 应用列表图标）
  ICON_256.PNG    256x256  （fnOS 应用详情图标）
  app/ui/images/icon_64.png
  app/ui/images/icon_256.png

设计：飞牛/Cloudflare 橙色渐变圆角方块 + 白色「上传到云」字形，
与 Davflare 的定位（云端对象存储的文件管理器 / 分享服务）一致。
"""

import os
from PIL import Image, ImageDraw, ImageFilter

S = 1024          # 超采样画布
SS = 4            # 相对 256 的倍数
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "davflare")
APP_IMG_DIR = os.path.join(OUT_DIR, "app", "ui", "images")

# Cloudflare 橙 (#F38020) 为主色
TOP = (255, 168, 92)
MID = (243, 128, 32)
BOTTOM = (196, 78, 12)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        if t < 0.5:
            k = t / 0.5
            c = tuple(round(TOP[i] + (MID[i] - TOP[i]) * k) for i in range(3))
        else:
            k = (t - 0.5) / 0.5
            c = tuple(round(MID[i] + (BOTTOM[i] - MID[i]) * k) for i in range(3))
        for x in range(size):
            px[x, y] = c
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def glyph_mask(size: int) -> Image.Image:
    """白色字形的 alpha 蒙版：云 + 上箭头。"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)

    white = 255
    dx, dy = 0, -70  # 整体微调，让字形在方形里视觉居中

    # --- 云 ---
    d.rounded_rectangle((236 + dx, 400 + dy, 788 + dx, 560 + dy), radius=80, fill=white)
    d.ellipse((340 - 100 + dx, 440 - 100 + dy, 340 + 100 + dx, 440 + 100 + dy), fill=white)
    d.ellipse((512 - 140 + dx, 372 - 140 + dy, 512 + 140 + dx, 372 + 140 + dy), fill=white)
    d.ellipse((690 - 96 + dx, 448 - 96 + dy, 690 + 96 + dx, 448 + 96 + dy), fill=white)

    # --- 上箭头 ---
    d.rounded_rectangle((476 + dx, 690 + dy, 548 + dx, 902 + dy), radius=36, fill=white)
    d.polygon(
        [(512 + dx, 592 + dy), (410 + dx, 706 + dy), (614 + dx, 706 + dy)],
        fill=white,
    )

    return m


def build() -> Image.Image:
    bg = gradient(S)
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    base.paste(bg, (0, 0), rounded_mask(S, radius=228))

    glyph = glyph_mask(S)

    # 一点内阴影，让字形从底面上「浮」起来
    shadow = glyph.filter(ImageFilter.GaussianBlur(18)).point(lambda v: int(v * 0.35))
    base.paste((120, 44, 4, 255), (0, 10), shadow)

    base.paste((255, 255, 255, 255), (0, 0), glyph)
    return base


def main() -> None:
    art = build()

    icon256 = art.resize((256, 256), Image.LANCZOS)
    icon64 = art.resize((64, 64), Image.LANCZOS)

    os.makedirs(APP_IMG_DIR, exist_ok=True)
    icon256.save(os.path.join(OUT_DIR, "ICON_256.PNG"))
    icon64.save(os.path.join(OUT_DIR, "ICON.PNG"))
    icon256.save(os.path.join(APP_IMG_DIR, "icon_256.png"))
    icon64.save(os.path.join(APP_IMG_DIR, "icon_64.png"))

    # 预览图，便于人工核对
    art.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, "icon_preview.png"))

    for name in ("ICON.PNG", "ICON_256.PNG",
                 os.path.join("app", "ui", "images", "icon_64.png"),
                 os.path.join("app", "ui", "images", "icon_256.png")):
        path = os.path.join(OUT_DIR, name)
        with Image.open(path) as im:
            print(f"{name}: {im.size[0]}x{im.size[1]} {im.mode} {os.path.getsize(path)}B")


if __name__ == "__main__":
    main()
