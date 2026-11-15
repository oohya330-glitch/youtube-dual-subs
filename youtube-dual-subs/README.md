# YouTube 中英對照逐字稿（VoiceTube 風格）

在 YouTube 影片旁邊顯示中英對照逐字稿，可以點單字查中文。

## 安裝／更新

1. 瀏覽器先安裝「篡改猴 Tampermonkey」，並開啟「允許使用者指令碼」。
2. 打開下面的連結，在篡改猴的頁面按「安裝」或「更新」：

   https://raw.githubusercontent.com/oohya330-glitch/youtube-dual-subs/main/youtube-dual-subs.user.js

之後篡改猴會自動檢查並更新。

## 功能

- 中英對照逐字稿：目前句子會標出來，面板會自動捲動，點句子就跳到那裡播放
- 句子翻譯：優先用 Chrome 內建翻譯，其次是 Google 翻譯，最後才用 YouTube 翻譯
- 點單字查中文：使用離線英漢字典，並依句意挑出最符合的意思
- 遮英文、遮中文、下載逐字稿、收合面板

## 字典來源

`dict/` 資料夾裡的字典，是由 ECDICT（https://github.com/skywind3000/ECDICT，MIT 授權）整理而成：
挑出最常用的約 4 萬個字，並用 OpenCC 轉成台灣繁體。授權條款請見 `LICENSE-ECDICT.txt`。
