# 语音包清单（S6b §5）

本清单由 `pnpm voices:list` 从角色包导出，列出所有需要预录的台词。**不调用 Fish 录音**。

## 录音格式要求

- 格式：mp3
- 声道：单声道（mono）
- 采样率：44.1kHz
- 开头结尾各留 0.1 秒静音

## 放置目录

录好的 mp3 按 `file` 列放到对应角色目录：`apps/client/public/characters/<id>/voice/fallback/<类别>.mp3`（五类兜底，客户端断线/卡住时本地播放）；
Mock 剧本与 nudge 的录音按 `file` 列的完整相对路径放到服务端语音目录 `assets/voice/<角色id>/clips/<key>.mp3`（S6b-fix1 §2 按角色分目录，与 `voiceKey.ts` 查表规则一致）。
Mock 模式找不到某条录音时照旧按现有逻辑处理（静音 beat + 字幕），不报错。

## 夏凛（rin）

### Mock 剧本

| 文件名 | 台词 | 情绪 | 场景 |
|---|---|---|---|
| assets/voice/rin/clips/2fdecf230fd42e76.mp3 | ……你是在问我吗？ | calm | arrive / ask_core |
| assets/voice/rin/clips/266438d5186a0497.mp3 | 算是吧。有人说过今晚会来。 | calm | arrive / ask_core |
| assets/voice/rin/clips/5b47c6be57b0b6b8.mp3 | 拍立得？我带了很多年。 | calm | arrive / ask_item |
| assets/voice/rin/clips/41ce5a9dba5a03b5.mp3 | 相纸不多了，所以只拍要紧的。 | calm | arrive / ask_item |
| assets/voice/rin/clips/b4ed815740488091.mp3 | 这么晚还在听电台？ | calm | arrive / ask_job |
| assets/voice/rin/clips/cc40b6d9c68b8fd4.mp3 | 《雨声信箱》，我今晚刚下播。 | calm | arrive / ask_job |
| assets/voice/rin/clips/8f70c9b6dd5956ee.mp3 | 谢谢。 | calm | arrive / comfort |
| assets/voice/rin/clips/159c9d762377bba5.mp3 | 我没事，就是坐一会儿。 | calm | arrive / comfort |
| assets/voice/rin/clips/9cad93e78205bb17.mp3 | 雨还在下。 | calm | arrive / greeting |
| assets/voice/rin/clips/05fcc6fcc86815d1.mp3 | 先坐吧，靠窗那桌干净。 | calm | arrive / greeting |
| assets/voice/rin/clips/6b6139dbe8e2236f.mp3 | 嗯。 | calm | arrive / other |
| assets/voice/rin/clips/1a5bfbdffb73c5f6.mp3 | 桌上那杯咖啡，一直没人动过。 | calm | arrive / other |
| assets/voice/rin/clips/c2bd62f2486e6bd2.mp3 | 他没说几点到。 | guarded | probe / ask_core |
| assets/voice/rin/clips/ff40b130d680479f.mp3 | 我也没问。问了，好像就变成催了。 | guarded | probe / ask_core |
| assets/voice/rin/clips/e411c9f3fc28edac.mp3 | 这张是台里楼下的雨。 | guarded | probe / ask_item |
| assets/voice/rin/clips/1d90bca40a92d436.mp3 | 拍的时候手抖了，反而像真的。 | guarded | probe / ask_item |
| assets/voice/rin/clips/e0472d9fcbab4bea.mp3 | 写信的人，比打电话的多。 | guarded | probe / ask_job |
| assets/voice/rin/clips/892237002d49fca0.mp3 | 有个人的字，我认得出来。 | guarded | probe / ask_job |
| assets/voice/rin/clips/04d3ca3bde3c4396.mp3 | 你不用陪我坐这么久。 | guarded | probe / comfort |
| assets/voice/rin/clips/9f90b041a57930d5.mp3 | 不过……有人在，确实好一点。 | guarded | probe / comfort |
| assets/voice/rin/clips/a8808428931c5d17.mp3 | 外面雨小一点了。 | guarded | probe / greeting |
| assets/voice/rin/clips/3b55586be760b156.mp3 | 你衣服湿了吗？ | guarded | probe / greeting |
| assets/voice/rin/clips/afbef065f90cf1c4.mp3 | 我在听。 | guarded | probe / other |
| assets/voice/rin/clips/f960a7024a8e35cc.mp3 | 快打烊了，不着急。 | guarded | probe / other |
| assets/voice/rin/clips/cbbc2456448470c2.mp3 | 他第一封信里说，不敢打电话。 | sad | reveal / ask_core |
| assets/voice/rin/clips/b58ebe8fb7d70e49.mp3 | 我就把节目时段往后挪了半小时。 | sad | reveal / ask_core |
| assets/voice/rin/clips/5ff1bd755a67d4d7.mp3 | 这张背面有一行字。 | sad | reveal / ask_item |
| assets/voice/rin/clips/5c833a14ef062a31.mp3 | 「等雨停」。是他写的。 | sad | reveal / ask_item |
| assets/voice/rin/clips/db3406121fcbf55a.mp3 | 今晚的节目，我念了他的信。 | sad | reveal / ask_job |
| assets/voice/rin/clips/f598bdeb403dbbe0.mp3 | 没念名字。他知道是他就行。 | sad | reveal / ask_job |
| assets/voice/rin/clips/6dd2dd4fcfe00770.mp3 | 我没事，真的。 | sad | reveal / comfort |
| assets/voice/rin/clips/c83be90751b9d87f.mp3 | 就是有点，说不上来。 | sad | reveal / comfort |
| assets/voice/rin/clips/c77d76b8bc493018.mp3 | 你还在。 | sad | reveal / greeting |
| assets/voice/rin/clips/1572038a9c833a26.mp3 | 雨停了，玻璃上只剩水痕。 | sad | reveal / greeting |
| assets/voice/rin/clips/8aa9980c19df0072.mp3 | 让我坐一会儿。 | sad | reveal / other |
| assets/voice/rin/clips/a696313bb3ab73d3.mp3 | ……抱歉，刚才走神了。 | sad | reveal / other |
| assets/voice/rin/clips/8b73f91f57fbbf01.mp3 | 我大概不会每天都等了。 | warm | ending / ask_core |
| assets/voice/rin/clips/ce1854e14f5a238d.mp3 | 但今晚，想再等十分钟。 | warm | ending / ask_core |
| assets/voice/rin/clips/4d73b07b316bc8dc.mp3 | 照片我收起来了。 | warm | ending / ask_item |
| assets/voice/rin/clips/a32f5141a6d8319e.mp3 | 不是丢掉。 | warm | ending / ask_item |
| assets/voice/rin/clips/a20c2fa881bda602.mp3 | 明天的节目照常。 | warm | ending / ask_job |
| assets/voice/rin/clips/5a1955ced744e088.mp3 | 信箱还会开着。 | warm | ending / ask_job |
| assets/voice/rin/clips/99f55b25ce317ec5.mp3 | 我知道。 | warm | ending / comfort |
| assets/voice/rin/clips/280f535bb38444df.mp3 | 谢谢你没劝我别等。 | warm | ending / comfort |
| assets/voice/rin/clips/56c98a8613a9c501.mp3 | 谢谢你还在这儿。 | warm | ending / greeting |
| assets/voice/rin/clips/487a7e84c0f19abf.mp3 | 要打烊了。 | warm | ending / greeting |
| assets/voice/rin/clips/f6b81758b7e8adca.mp3 | 灯我留着。 | warm | ending / other |
| assets/voice/rin/clips/ad38b90f41dc19c0.mp3 | 路上小心。 | warm | ending / other |

### 主动开口（nudge）

| 文件名 | 台词 | 情绪 | 场景 |
|---|---|---|---|
| assets/voice/rin/clips/2c185156c6e39895.mp3 | ……你还在听吗？ | calm | nudge（主动开口） |

### 兜底（五类）

| 文件名 | 台词 | 情绪 | 场景 |
|---|---|---|---|
| assets/voice/rin/clips/ee1dd2c20b12c085.mp3 | 刚才没听清，你再说一遍好吗？ | guarded | fallback（） |
| assets/voice/rin/clips/d90593a91a417007.mp3 | 雨声太大了，信号断了一下……你刚才说什么？ | guarded | fallback（） |
| assets/voice/rin/clips/53c4a02d06fc0ab8.mp3 | ……抱歉，刚才走神了。你刚才说到哪了？ | guarded | fallback（） |
| assets/voice/rin/clips/276b9f578d0d184c.mp3 | 店里的灯闪了一下。我们刚才说到哪了？ | guarded | fallback（） |
| assets/voice/rin/clips/28c240cbe728ee5a.mp3 | ……喂？好像断线了。 | guarded | fallback（） |
| assets/voice/rin/clips/4841bec79d5cbc66.mp3 | 好像没换成。这里也挺好的，不是吗。 | guarded | fallback（） |
| assets/voice/rin/clips/348f718989c3dcb6.mp3 | 那个地方……我们换一个吧。 | guarded | fallback（） |
| assets/voice/rin/clips/6cabd6a6ee0c375f.mp3 | 别急，一个一个来。 | guarded | fallback（） |

## 忧奈（yuna）

### Mock 剧本

| 文件名 | 台词 | 情绪 | 场景 |
|---|---|---|---|
| assets/voice/yuna/clips/633a0a73fc5047b6.mp3 | 嗯哼。 | calm | arrive / ask_core |
| assets/voice/yuna/clips/d6e41345d4b04c45.mp3 | 这位观众，下播时间不营业哦。 | calm | arrive / ask_core |
| assets/voice/yuna/clips/572c1dca8ca87da9.mp3 | 截图？什么截图。 | calm | arrive / ask_item |
| assets/voice/yuna/clips/6ae6a81d500e962a.mp3 | 我没截过图啊，你记错了吧。 | calm | arrive / ask_item |
| assets/voice/yuna/clips/2c2fc785bfde13f3.mp3 | 谢谢……突然这么温柔干嘛。 | calm | arrive / comfort |
| assets/voice/yuna/clips/c8c01d8a9d859b4b.mp3 | 我没事，就是有点累。 | calm | arrive / comfort |
| assets/voice/yuna/clips/620555977687ccac.mp3 | ……诶？还有人？ | calm | arrive / greeting |
| assets/voice/yuna/clips/f6b2ee35d445a88e.mp3 | 我以为大家都走了，推流忘关了。 | calm | arrive / greeting |
| assets/voice/yuna/clips/afbef065f90cf1c4.mp3 | 我在听。 | guarded | probe / ask_core |
| assets/voice/yuna/clips/072cf21dcb677888.mp3 | 弹幕就剩你一条了，挺清楚的。 | guarded | probe / ask_core |
| assets/voice/yuna/clips/0836a020535dfef3.mp3 | 你说老截图？ | guarded | probe / ask_item |
| assets/voice/yuna/clips/08ed9de7bacfd338.mp3 | ……我手机里倒是存着一张。 | guarded | probe / ask_item |
| assets/voice/yuna/clips/f00885d3dd5d4505.mp3 | 别这样，我会当真的。 | guarded | probe / comfort |
| assets/voice/yuna/clips/1a757f88bcd2487c.mp3 | ……不过，有人在，确实好一点。 | guarded | probe / comfort |
| assets/voice/yuna/clips/4ace908a0191b32c.mp3 | 你还没走啊。 | guarded | probe / greeting |
| assets/voice/yuna/clips/4c2bc07e4d1d84a3.mp3 | 明天不用上班吗你。 | guarded | probe / greeting |
| assets/voice/yuna/clips/90aed4ddd9fcd8ca.mp3 | 让我缓一下。 | sad | reveal / ask_core |
| assets/voice/yuna/clips/be9802619adb0c8f.mp3 | ……抱歉，刚才发呆了。 | sad | reveal / ask_core |
| assets/voice/yuna/clips/a0f2919c52cd5801.mp3 | 这是我第一次开播。 | sad | reveal / ask_item |
| assets/voice/yuna/clips/f87da68723d493d2.mp3 | 三个观众，我紧张到一直在喝水。 | sad | reveal / ask_item |
| assets/voice/yuna/clips/6dd2dd4fcfe00770.mp3 | 我没事，真的。 | sad | reveal / comfort |
| assets/voice/yuna/clips/df329193cb6c08b9.mp3 | 就是说出来，好像轻一点了。 | sad | reveal / comfort |
| assets/voice/yuna/clips/c77d76b8bc493018.mp3 | 你还在。 | sad | reveal / greeting |
| assets/voice/yuna/clips/4fa106fb718cc518.mp3 | 那我就……跟你说点真话吧。 | sad | reveal / greeting |
| assets/voice/yuna/clips/ad847bf1748fcbcf.mp3 | 晚安，最后一位观众。 | warm | ending / ask_core |
| assets/voice/yuna/clips/ed5d8e53bd9b1dbc.mp3 | 这次真的下播啦。 | warm | ending / ask_core |
| assets/voice/yuna/clips/585b3b6c70b7f784.mp3 | 截图我会留着的。 | warm | ending / ask_item |
| assets/voice/yuna/clips/c454a587e9955b6e.mp3 | 那三个人里，说不定也有你。 | warm | ending / ask_item |
| assets/voice/yuna/clips/99f55b25ce317ec5.mp3 | 我知道。 | warm | ending / comfort |
| assets/voice/yuna/clips/f5414c26df7a231a.mp3 | 谢谢你没劝我别走。 | warm | ending / comfort |
| assets/voice/yuna/clips/d9bb13529b36d75b.mp3 | 谢谢你今晚没退出。 | warm | ending / greeting |
| assets/voice/yuna/clips/1477892832d7f7b0.mp3 | 我要关推流了哦。 | warm | ending / greeting |

### 主动开口（nudge）

| 文件名 | 台词 | 情绪 | 场景 |
|---|---|---|---|
| assets/voice/yuna/clips/c34ddb0ccbd03a29.mp3 | ……还在吗？弹幕好安静。 | calm | nudge（主动开口） |

### 兜底（五类）

| 文件名 | 台词 | 情绪 | 场景 |
|---|---|---|---|
| assets/voice/yuna/clips/6524e9a76832cc3a.mp3 | 你那边声音糊了，没听清，再说一次？ | guarded | fallback（） |
| assets/voice/yuna/clips/19c882b08c777f8f.mp3 | 啊，卡了卡了，网络又抽风了……你刚说啥？ | guarded | fallback（） |
| assets/voice/yuna/clips/4b4fc7cd1a397bea.mp3 | ……抱歉，刚刚发呆了。你说到哪了？ | guarded | fallback（） |
| assets/voice/yuna/clips/45436f812286ae6e.mp3 | 直播间好像卡住了，等我一下……好了，你继续。 | guarded | fallback（） |
| assets/voice/yuna/clips/09deab7a0a8d105c.mp3 | 诶？画面卡住了……还在吗？ | guarded | fallback（） |
| assets/voice/yuna/clips/9f3b6e729336ff88.mp3 | 诶，背景卡住了，没换成……先凑合一下吧。 | guarded | fallback（） |
| assets/voice/yuna/clips/6f71dc9db3703404.mp3 | 这个不行哦，换一个别的吧。 | guarded | fallback（） |
| assets/voice/yuna/clips/dc45dcc06e729b4a.mp3 | 等等，上一个还没换完呢。 | guarded | fallback（） |
