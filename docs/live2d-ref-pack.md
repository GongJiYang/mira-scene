# Live2D 隐藏区域参考包：生图提示词（GPT Image）

> 思路（参考 ArcLoop 的 Live2D Material Separation Guide）：**原图上看不见的部位，提前单独画出来**，不要等到事后让 AI 去补。
> 生成好的图放进 `tools/live2d-pipeline/overrides/<图层名>.png`，流水线会优先使用这些图。
> **所有图都以 M1 为编辑底图**（`/Users/gjy/Desktop/立绘图/M1 · 主立绘（透明背景）.png`），尺寸 1024×1536，背景透明，保证每张图和 M1 逐像素对齐。

## 每一条都要加在最前面的「锁定构图」
```
Use the attached image as the exact base. Keep the same character, same framing, same size, same position, same pose, same lighting, same art style (clean Japanese anime cel shading). Output 1024x1536 portrait, transparent background. Change ONLY what is described below; everything else must stay pixel-identical.
```

## R1 · `face_base` 无五官的脸（最重要：解决「幽灵五官」和眼线残留）
```
Remove the eyes, eyebrows, eyelashes, eyeliner, lower lash line, nose shadow line and mouth completely. Paint smooth, clean bare facial skin in those areas with the same skin tone and soft cel shading as the cheeks, keeping the face outline, ears and the soft cheek blush gradient. No lines, no marks, no ghost outlines of the removed features. Hair and everything else unchanged.
```
> 注意：只保留脸的皮肤。生成后用 M1 的脸部轮廓裁切。

## R2 · `forehead` 刘海掀起后的额头
```
Remove the front bangs entirely and reveal the full forehead and hairline skin underneath, with the same skin tone and lighting. The side hair and back hair stay exactly as they are. Do not change the eyes, face or anything else.
```

## R3 · `neck` 完整脖子（不戴耳机）
```
Remove the over-ear headphones from around the neck. Show the full neck from just under the chin down into the top of the off-white turtleneck collar, smooth skin with a soft shadow under the jaw, and the complete turtleneck collar where the headphones used to cover it. Everything else unchanged.
```
> 用途：把脖子补成实心；同时得到不戴耳机的高领，让耳机（neckwear）可以单独移动。

## R4 · 眼睛部件（一只眼一张，左右眼各做一套；裁切时只保留眼部）
**R4a `eyewhite` 实心眼白**
```
Change ONLY the eyes: remove the irises and pupils so each eye shows only a solid clean white eyeball (the sclera) filling the whole eye opening, with a soft grey-blue shadow under the upper eyelid. Eyelashes and eyelids unchanged.
```
**R4b `irides` 完整虹膜（不被眼皮遮挡）**
```
Change ONLY the eyes: draw each grey-blue anime iris as a complete perfect circle, including the top part normally hidden by the upper eyelid, with a dark pupil and two white highlight dots. Same size, color and position as the original irises. Remove the eyelids and eyelashes over the irises so the full circle is visible.
```
**R4c `eyelash_upper` 只有上睫毛线**
```
Change ONLY the eyes: keep only the upper eyelash line and eyeliner of each eye. Remove the eyeballs, irises, lower lashes and eyelid crease; the area inside and below the lash line becomes bare skin.
```
**R4d `eyelash_lower` 下睫毛 + 卧蚕**
```
Change ONLY the eyes: keep only the lower eyelash line and the soft under-eye bag (aegyo-sal) highlight of each eye. Remove the upper lashes, eyeballs and irises; the rest becomes bare skin.
```
**R4e `eyelid_crease` 上眼睑褶线**
```
Change ONLY the area above the eyes: keep only the thin double-eyelid crease line above each upper eyelash line. Remove the eyes, eyelashes and lower lash lines; everything else becomes bare skin.
```

## R5 · 耳机内胆（解决「耳机杯内胆缺失」）
```
Change ONLY the headphones: show the inner side of each ear cup as a dark charcoal oval cushion facing slightly inward, fully visible, with subtle fabric texture. Everything else unchanged.
```

## R6 · 耳坠与发丝的交界（解决「头发层留了一圈亮边」）
```
Remove the silver crescent-moon earring and repaint the hair strands and ear behind it naturally, with the same hair color and shading. Everything else unchanged.
```
> 用途：得到不戴耳坠的头发和耳朵，耳坠只放在 earwear 一层，这样转头时就不会出现两个耳坠。

## 已经有的（不需要重做）
闭眼 `eyelid_closed`，口型 `mouth_small`、`mouth_open`、`mouth_smile`、`mouth_sad`，表情 `brow_sad`、`brow_raised`、`blush`，都在 `assets/parts/`，已经与 M1 对齐。

## 优先级
1. **R1 无五官的脸 + R4a/R4b 眼白和虹膜**：这几张解决眼睛的全部问题，最值得先做。
2. R3 脖子、R6 耳坠交界。
3. R2 额头、R4c/d/e 睫毛和褶线、R5 耳机内胆。

## 交付
放到 `~/Desktop/立绘图/参考包/`，文件名用上面的英文名（例如 `face_base.png`）。尺寸和位置跟 M1 不完全一致也没关系，流水线会沿用 P4 的配准方法自动对齐，再按区域裁切。
