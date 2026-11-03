# 讓別人跑起來

在這個專案目錄：

```bash
cp .env.example .env
cp bots.example.csv bots.csv
# 編輯 .env 與 bots.csv。token 只放在 bots.csv。
node --test
node refresh.js
systemctl is-active 'openmausbot-telegram@*'
```

`refresh.js` 需要免密碼 sudo，才能把 unit 裝進 `/etc/systemd/system/` 並重啟。沒有改過的列不會重啟。

允許的 Telegram 帳號私訊該 bot 一次之後，harness 回覆才推得到 Telegram。

## 圖床

`.env` 的 `OMB_IMAGE_PUBLISH_DIR` 與 `OMB_IMAGE_PUBLIC_BASE` 都留空時，本機圖片走 `sendPhoto`，不會打到別人的網址。

兩者都有填，而且 `OMB_IMAGE_COMPOSE_DEST` 有填時，`node refresh.js` 會渲染 `image-host/compose.yml.in`。目錄本身要先存在，旁邊放一份 `image-host/nginx.conf`。根路徑應是 404。實際圖片網址要回圖片的 content-type。

## 語音

```bash
node --check gateway.js stt.js
node --test
# 還沒有 venv 時：
# sh stt/setup.sh
```

第一次轉譯會把 `large-v3` 權重下載到 `$OMB_DATA_DIR/stt/cache`。`faster-whisper` 1.2.1 不能配 PyAV 16 以上。

超過 15 秒才在 gateway 用本機 Whisper，轉完的文字只送進 OpenMaus。15 秒以內，或沒有時長，上傳音檔。

## 脈絡 MCP

```bash
node --check gateway.js telegram-mcp.js
node --test
```

OpenMaus 的 MCP 命令使用 `.env` 的 `OMB_NODE_BIN`，參數是 `$OMB_GATEWAY_DIR/telegram-mcp.js`。Test 應看到 `get_location`、`list_photo_locations`、`read_photo_exif`。
