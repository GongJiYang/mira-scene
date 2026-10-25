# 原画需求清单与 GPT Image 提示词

> 用于 D24 代码绑定的 2.5D 角色。画风：**日系二次元**。生图工具：**GPT Image（gpt-image-1）**。
> 角色已改为原创设定（不再使用题目故事种子里的 Mira），见 §0。

## 0. 角色与场景设定

**夏凛（Natsu Rin）**，27 岁，原创成年女性。深夜电台《雨声信箱》的主持人。
- **外形**：黑色及肩短发，发尾微微内卷；左耳旁有一缕挑染的浅蓝色头发；灰蓝色眼睛，眼神沉静。
- **服装**：墨绿色长款风衣，肩上沾着雨水；里面是米白色高领毛衣；脖子上挂着一副头戴式耳机。
- **标志物**：**左耳一枚银色月牙耳坠**；随身带一台**拍立得相机**，用来拍下每晚的雨。
- **性格**：说话温和、慢，善于倾听，但不轻易谈起自己。
- **场景**：暴雨后的深夜，一家快要打烊的咖啡馆。凛坐在靠窗的位置，在等一位给电台写了三年信、从没露过面的听众，对方约好今晚来见她。
- **对应剧情节点**：arrive（偶遇）→ probe（试探：她在等谁）→ reveal（拍立得里那张「信」的照片 / 她说出等待的原因）→ ending。
- **「翻相机找照片」事件**：改为「翻看拍立得照片」，贴合人设。

---

## 1. 通用规格

| 项 | 要求 |
|---|---|
| 尺寸 | 角色：**1024×1536 竖版**；背景：**1536×1024 横版**（另生成一张竖版 1024×1536，供手机端使用） |
| 背景 | 角色和部件用 `background: transparent`，`output_format: png` |
| 质量 | `quality: high` |
| 构图 | 腰部以上半身像，**正面朝向**，双眼看向镜头，嘴自然闭合，**双手放在画面以外**（手势由 A1–A4 图层单独提供） |
| 一致性 | 每条提示词都带上 §2 的「角色块」和「风格块」，原样复制，**不要改字** |
| 对齐 | 所有角色部件都从**同一张主立绘**派生（§3），不要另起新图 |

---

## 2. 公共块（每条提示词都要拼上）

**风格块 STYLE**
```
Japanese anime illustration style, clean crisp lineart, cel shading with soft gradient highlights, visual novel character sprite quality, consistent warm key light from upper left, subtle cool rim light from the right (rain window), high detail, no text, no watermark, no signature.
```

**角色块 CHARACTER**
```
Natsu Rin, an adult woman, 27 years old. Shoulder-length black bob hair with ends slightly curled inward, one thin streak of pale blue hair beside her left ear. Calm grey-blue eyes. A single silver crescent-moon earring on her LEFT ear. Wearing a long dark green trench coat with raindrops on the shoulders, over an off-white turtleneck sweater. Over-ear headphones resting around her neck.
```

---

## 3. 主立绘（第一步，先交这一张给我确认）

**M1 · 主立绘（透明背景）**，尺寸 1024×1536，background transparent
```
[STYLE] [CHARACTER]
Waist-up portrait, facing the viewer directly (front view), looking straight at the camera, neutral calm expression, mouth gently closed, eyes fully open. Arms relaxed down at her sides, hands below the bottom edge of the frame and not visible. Symmetric centered composition, full head and hair visible with margin above the head, character fills about 80% of the height. Transparent background, character only, no props, no background.
```

**M1-ref · 角色设定参考图（可选，便于后续保持一致）**，1536×1024
```
[STYLE] [CHARACTER]
Character reference sheet on a plain light grey background: front view waist-up, three-quarter view waist-up, and close-up of the face showing the crescent-moon earring and the pale blue hair streak. Same outfit in all views.
```

> 确认主立绘后，后面所有编辑都**以 M1 为输入图**（edit 模式）。

---

## 4. 部件拆分（以 M1 为输入，用编辑模式 + 蒙版）

**流程**：在 Photoshop、Krita 或 Photopea 里，用 M1 手动把下表的图层切开（选区 + 拷贝到新图层，画布保持 1024×1536 不动）。
被遮挡、需要补画的地方，用 GPT Image 的 **edit + mask**（蒙版只盖住要补的区域）来处理，提示词如下。

**E1 · 补额头**（去掉前发，补出完整额头，作为 `face` 层）。蒙版：前发区域
```
[STYLE] [CHARACTER]
Edit only the masked area: remove the front bangs and reveal a complete clean forehead and hairline skin, matching the existing skin tone and lighting exactly. Keep everything outside the mask pixel-identical.
```

**E2 · 补后发**（去掉头和脸，只留后发，作为 `hair_back` 层）
```
[STYLE] [CHARACTER]
Edit only the masked area: show only the back part of the black bob hair as it would look behind the head, fully painted where the face and neck used to cover it. Same hair color, shading and pale blue streak position. Transparent elsewhere.
```

**E3 · `neck` 脖子层 + `collar` 领子层（推荐手动做，不用 AI）**
> 原来的提示词有问题：要补的是被下巴挡住的那段脖子，edit 模式画不出画面上看不见的部分；高领毛衣也不存在「领口内侧」。

**手动做法（约 5 分钟）**：
1. 在 M1 上选中下巴与高领之间露出来的那一小段脖子皮肤，复制成新图层 `neck`。
2. 把这一层**往上拉长 60–80px**，让顶端藏到脸的下面；颜色用脖子原本的肤色，顶部可以稍微加深一点（下巴投下的阴影）。
3. 再把高领毛衣最上面的那一圈领子单独切出来，存成 `collar` 层，放在 `neck` 上面、`face` 下面。这样头部转动时，脖子会从领子里自然露出来。
4. 图层顺序（从下到上）：`hair_back` → `body` → `neck` → `collar` → `face` → 五官 → `hair_front`。

**AI 备选（手动做不顺手时再用）**：以 M1 为输入，蒙版盖住**整个头部和头发**（不只是脖子），这样模型看不到下巴，才能画出完整的脖子。
```
[STYLE]
Edit only the masked area: paint only a slender neck rising from the top of the off-white turtleneck collar, smooth skin with soft shading, the neck ends in a clean rounded top where the head would attach, nothing above it, transparent background above the neck. Keep the coat and sweater outside the mask unchanged.
```
> 这张图只用来抠出脖子，其他部分不要用。

**E4 · 无五官的脸**（去掉眼、眉、嘴，留下平滑的皮肤，作为 `face` 底层）
```
[STYLE] [CHARACTER]
Edit only the masked area: remove the eyes, eyebrows and mouth, leaving smooth blank facial skin with the same shading and soft cheek gradient. Keep face outline unchanged.
```

**E5 · 完整瞳孔**（`iris_L/R`，不被眼睑遮挡的完整圆形瞳孔）
```
[STYLE]
A single anime eye iris, grey-blue with a darker ring and two white highlight spots, perfectly round and complete, not cut off by eyelids, on a transparent background, same art style and color as Natsu Rin's eyes.
```

---

## 5. 表情差分（以 M1 为输入，蒙版只盖住眼、眉或嘴）

> 每一条都是 **edit + mask**：蒙版只盖住对应的五官区域，其他地方保持不变。

| 编号 | 图层名 | 蒙版区域 | 提示词（前面拼上 [STYLE] [CHARACTER]） |
|---|---|---|---|
| X1 | `eyelid_half` | 双眼 | `Edit only the masked eyes: eyes half-closed, relaxed drowsy look, same eyelashes style.` |
| X2 | `eyelid_closed` | 双眼 | `Edit only the masked eyes: eyes gently closed, soft curved closed-eye lines with eyelashes, peaceful.` |
| X3 | `brow_sad` | 双眉 | `Edit only the masked eyebrows: inner ends raised and tilted, a sad worried brow shape.` |
| X4 | `brow_raised` | 双眉 | `Edit only the masked eyebrows: both raised high, surprised.` |
| X5 | `brow_soft` | 双眉 | `Edit only the masked eyebrows: relaxed and slightly lowered, warm gentle look.` |
| X6 | `mouth_small` | 嘴 | `Edit only the masked mouth: mouth slightly open, speaking a soft syllable.` |
| X7 | `mouth_open` | 嘴 | `Edit only the masked mouth: mouth open mid-speech, small visible upper teeth, natural.` |
| X8 | `mouth_o` | 嘴 | `Edit only the masked mouth: small round "o" shaped open mouth.` |
| X9 | `mouth_smile` | 嘴 | `Edit only the masked mouth: closed gentle smile, corners slightly lifted.` |
| X10 | `mouth_sad` | 嘴 | `Edit only the masked mouth: closed mouth with corners slightly down, restrained sadness.` |
| X11 | `blush` | 双颊 | `Edit only the masked cheeks: add soft pink anime blush with faint diagonal hatch lines.` |
| X12 | `earring_glint` | 耳坠 | `Edit only the masked earring: the silver crescent-moon earring catches a small sparkle of light.` |

> 生成后，在编辑软件里把**只属于这个五官的部分**切出来，存成独立的透明 PNG，画布尺寸不变。

---

## 6. 手臂与道具（以 M1 为输入，蒙版盖住手臂和胸前区域）

**A1 · `arm_cup` 双手捧咖啡杯（待机、喝咖啡）**
```
[STYLE] [CHARACTER]
Edit only the masked area: both hands holding a white ceramic coffee cup in front of her chest, steam rising softly, fingers wrapped around the cup, trench coat sleeves visible. Keep the face and hair unchanged.
```

**A2 · `arm_polaroid` 双手翻看拍立得照片（翻照片事件）**
```
[STYLE] [CHARACTER]
Edit only the masked area: both hands holding a small stack of instant polaroid photos in front of her chest, thumb lifting the top photo as if flipping through them, photos' images not visible (backs facing the viewer). Keep the face and hair unchanged.
```

**A3 · `arm_camera` 双手举着拍立得相机**
```
[STYLE] [CHARACTER]
Edit only the masked area: both hands holding a cream-colored instant camera at chest height, lens facing the viewer. Keep the face and hair unchanged.
```

**A4 · `arm_phone` 一只手看手机（check_phone，可选）**
```
[STYLE] [CHARACTER]
Edit only the masked area: right hand holding a smartphone low near her chest, screen faintly lighting her fingers, left hand resting. Keep the face and hair unchanged.
```

---

## 7. 场景背景

> **思路**：先生成一张**竖版主场景 B1**，其余变化（雨停、打烊）都**以 B1 为输入，用 edit + 蒙版只改局部**，保证透视和构图完全一致。
> **雨由代码做**：雨滴下落、玻璃上的水痕都是代码叠加的动画，**背景里只画少量静止水珠**，避免出现两套雨。
> **镜头**：视线高度在坐着的人胸口附近，平视、透视很轻。角色会叠在画面中央偏下的位置，那里要留空。

**场景风格块 SCENE**（每条都拼上）
```
Japanese anime background art, visual novel background quality, painterly but clean with crisp edges, eye-level camera at the chest height of a seated person, gentle perspective, 35mm lens feel. Lighting: warm amber pendant light from the upper left inside the cafe, cool blue night light coming through the window on the right side, soft deep shadows, moody and quiet, matching a character sprite lit warm from the left with a cool blue rim light from the right. No people, no characters, no animals, no text, no logos, no signage letters.
```

**B1 · `bg_main` 主场景（最先生成）**：竖版 1024×1536（手机端用），之后再生成一张横版 1536×1024（桌面端用）
```
[SCENE]
A quiet window seat in a small wooden cafe late at night, just before closing. A large window fills the upper and middle part of the background directly behind the center of the frame; outside is a dark rainy city street with blurred warm and blue street lights and soft bokeh. Only a few still water droplets on the glass, no rain streaks. On the left edge, the corner of the wooden counter with an espresso machine under a warm hanging lamp. On the right edge, a wall with a small shelf holding an old radio and a potted plant. The lower-center area in front of the window is empty open space where a seated person will be placed. Floor and table surfaces are NOT shown in the bottom 20% of the image; that area is a softly lit, out-of-focus empty cafe interior.
```
> 横版：同一段提示词，把第一句改成 `wide horizontal composition`，其余不变。横版和竖版不需要像素对齐。

**B2 · `bg_rainstop` 雨停后（§4 要求的环境变化）**：以 B1 为输入，蒙版**只盖住窗外的景色**（不包括窗框）
```
[SCENE]
Edit only the masked area outside the window: the rain has stopped. The wet street glistens and reflects the street lights, the clouds are parting and a thin silver crescent moon is visible in the night sky. A few droplets remain on the glass. Keep everything outside the mask pixel-identical.
```
> 细节：月牙对应凛的耳坠，可以作为剧情里的一个呼应点。

**B3 · `bg_closing` 打烊灯光（可选，也可以完全用代码调色）**：以 B1 为输入，蒙版盖住**除窗外以外的全部室内**
```
[SCENE]
Edit only the masked interior: most of the cafe lights are switched off for closing, only the single hanging lamp above the window seat is still on, the counter area falls into deep shadow, a dimmer and more intimate mood. Keep the window and the view outside unchanged.
```

**B4 · `fg_table` 前景桌面**：横版 1536×1024，`background: transparent`
```
[STYLE]
Foreground prop layer only, transparent background. The near edge of a dark wooden cafe table seen at eye level from a seated position, the table top runs horizontally across the full width of the image and occupies only the bottom 30% of the canvas; everything above it is fully transparent. On the table: a white ceramic coffee cup on a saucer with faint steam on the right, a cream-colored instant camera in the middle-left, two instant photos lying face down beside it. Warm light from the upper left, cool blue reflection from the right on the varnished surface.
```
> 桌面高度要和角色立绘的腰部对得上；如果对不上，代码里可以整体上下移动这一层，不用重画。

**生成后检查**
- B1 中央偏下是否留空（不能画出椅子、桌子、杯子挡在那里）。
- B2 与 B1 叠在一起来回切换：窗框、柜台、灯是否完全不动，只有窗外在变。
- B4 上方是否真的透明（没有残留的背景色块）。
- 三张图的色调是否和 M1 立绘一致：左侧暖光、右侧冷蓝，整体偏暗。

## 8. 拍立得照片（「翻照片」事件的预置结果，也是生成失败时的退路）

**照片风格块 PHOTO**
```
An instant polaroid photograph in Japanese anime illustration style, slightly faded film colors, soft vignette, white polaroid border with a thicker bottom margin, the photo is slightly tilted, no text.
```

| 编号 | 文件名 | 提示词 |
|---|---|---|
| P1 | `photo_rain_street.png` | `[PHOTO] A rainy night street seen from a radio station window, neon reflections in puddles.` |
| P2 | `photo_letters.png` | `[PHOTO] A neat stack of handwritten letters tied with a blue ribbon on a desk next to a microphone.` |
| P3 | `photo_bus_stop.png` | `[PHOTO] An empty bus stop in the rain at dawn, a single umbrella left leaning on the bench.` |
| P4 | `photo_back_figure.png` | `[PHOTO] The back of a person in a grey coat walking away under an umbrella, face not visible.` |

尺寸 1024×1024，`quality: high`。

> **对话实时生成的照片**（核心体验里的生成图）会复用 [PHOTO] 块，加上由对话内容决定的一句画面描述，所以生成结果和预置照片风格一致。

---

## 9. 交付优先级

1. **M1 主立绘**：先交给我确认风格和细节，确认后再做后面的步骤。
2. **P0**：E1–E4 拆出基础图层；X2 `eyelid_closed`、X7 `mouth_open`；A1 `arm_cup`；B1 `bg_main`、B4 `fg_table`。有了这些就能做出待机、倾听、思考、说话四种状态。
3. **P1**：其余表情差分（X1、X3–X10）；A2 `arm_polaroid`；B2 雨停；P1–P4 照片。
4. **P2**：A3、A4、X11、X12、B3 打烊灯光。

## 10. 文件放置

把交付文件放到 `~/mira-scene/assets/raw/`，每个文件按「图层名.png」命名（例如 `eyelid_closed.png`），主立绘命名为 `master.png`。不要改动画布尺寸。
