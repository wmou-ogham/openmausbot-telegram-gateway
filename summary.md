# 把機器設定移出程式

**環境：** 這個專案目錄。OpenMaus harness 位址來自 `OMB_SERVER_URL`。服務帳號、資料目錄、node 路徑、圖床來自 `.env`。Token 仍在 gitignore 的 `bots.csv`。

**目標：** 程式與文件可以公開給別人用，不再把某一台機器的路徑、Telegram 帳號或 bot id 寫死。

**完成事項：**

- 新增 `.env.example`。`gateway.js` 與 `refresh.js` 讀同目錄的 `.env`，且不覆蓋已經存在的環境變數。
- `OMB_TELEGRAM_BOT_ID` 與 `OMB_TELEGRAM_ALLOW_USERNAME` 沒有預設值。`refresh.js` 仍把這兩項和 token、state 路徑寫進每個 instance 的 env。
- 圖床改為選擇性。`OMB_IMAGE_PUBLISH_DIR` 與 `OMB_IMAGE_PUBLIC_BASE` 齊全才發布；否則 `sendPhoto`。
- `openmausbot-telegram@.service.in` 由 `refresh.js` 渲染後安裝。舊的單 bot unit 檔不再放在樹裡。
- `image-host/compose.yml.in` 與 `omb-img.yml.in` 取代寫死網址的檔案。目的路徑有填才寫出。
- 測試、README、`bots.example.csv`、`reproduced.md` 改用通用路徑與假資料。

**困難與處理：** instance 專用的變數必須蓋過 `.env`。systemd 的 `EnvironmentFile` 在行程啟動前寫入，載入 `.env` 時不覆蓋既有變數，所以 token 與允許帳號仍以 CSV 那一列為準。

# Move host settings out of the program

**Environment:** This repository. The harness URL comes from `OMB_SERVER_URL`. The service account, data directory, node binary, and image bed come from `.env`. Tokens stay in gitignored `bots.csv`.

**Goal:** Make the program and docs usable by someone else, without a machine path, Telegram account, or bot id fixed in source.

**Done:**

- Added `.env.example`. `gateway.js` and `refresh.js` load `.env` from this directory and do not override variables that are already set.
- `OMB_TELEGRAM_BOT_ID` and `OMB_TELEGRAM_ALLOW_USERNAME` have no default. `refresh.js` still writes those, the token, and the state path into each instance env.
- The image bed is optional. Both `OMB_IMAGE_PUBLISH_DIR` and `OMB_IMAGE_PUBLIC_BASE` must be set; otherwise the gateway uses `sendPhoto`.
- `refresh.js` renders `openmausbot-telegram@.service.in` and installs it. The old single-bot unit files are no longer in the tree.
- `image-host/compose.yml.in` and `omb-img.yml.in` replace the files that named a real host. They are written only when a destination is set.
- Tests, the README, `bots.example.csv`, and `reproduced.md` use generic paths and fixture data.

**Difficulties:** Instance settings have to win over `.env`. systemd's `EnvironmentFile` is applied before the process starts, and the `.env` loader does not override existing variables, so the token and allowed account stay on the CSV row.
