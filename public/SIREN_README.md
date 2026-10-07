# 警笛音效文件

默认已生成 `siren.wav`，可直接使用。如需替换：

## 免费下载来源

- Mixkit: https://mixkit.co/free-sound-effects/siren/
- Pixabay: https://pixabay.com/sound-effects/search/police%20siren/
- Zapsplat: https://www.zapsplat.com/police-siren-sound-effects/

## 支持的格式

`dashboard.js` 会按顺序尝试加载：

1. `public/siren.mp3`
2. `public/siren.wav`

只要放一个就行，刷新页面生效。

## 重新生成默认警笛

```bash
cd /path/to/automeme
node scripts/generate-siren.js
```
