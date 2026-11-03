# Unofficial Telegram gateway for OpenMausBot 0.1.84

Adapted from closed PR https://github.com/milind-soni/OpenMausBot/pull/110 (never merged).
Each process is locked to one Telegram account, one bot token, and one harness bot.
The gateway talks to OpenMaus on loopback (`OMB_SERVER_URL`, default `http://127.0.0.1:8799`). Nothing in this repository is published for you.

## 設定

```bash
cp .env.example .env
cp bots.example.csv bots.csv
```

`.env` 與 `bots.csv` 都不進 git。`.env` 放這台機器的路徑、服務帳號、OpenMaus 位址，以及選擇性的圖床。Token 只放在 `bots.csv`。`node refresh.js` 會把每一列寫進 `$OMB_DATA_DIR/telegram-bots/<instance>.env`（mode 600），並安裝 systemd template。

| 變數 | 用途 |
|---|---|
| `OMB_SERVICE_USER` / `OMB_SERVICE_HOME` | systemd 的使用者和家目錄。空白則用執行 `refresh.js` 的帳號 |
| `OMB_GATEWAY_DIR` / `OMB_NODE_BIN` | 這個專案的路徑，以及要用的 `node` |
| `OMB_DATA_DIR` | OpenMaus 資料目錄。空白則是 `~/.openmausbot` |
| `OMB_SERVER_URL` | harness API。空白則是 `http://127.0.0.1:8799` |
| `OMB_IMAGE_PUBLISH_DIR` / `OMB_IMAGE_PUBLIC_BASE` | 兩者都有才把本機圖嵌成 https。缺一則改走 `sendPhoto` |
| `OMB_IMAGE_COMPOSE_DEST` / `OMB_IMAGE_TRAEFIK_DEST` | 有填才把 `deploy/image-host/*.in` 渲染到那兩個路徑 |

`bots.csv` 欄位：`instance`、`harness_bot`（名稱或 id）、`allow_username`（必填）、`state_path`、`replaces`、`token`。同一 token 或同一個 harness bot 不能出現兩次，否則 `getUpdates` 會互搶。`replaces` 用來關掉舊的單 bot unit。

改完執行：

```bash
node refresh.js
```

沒有改過的列不會重啟。`.env` 若改變已安裝的 unit，正在跑的 instance 會重啟。

## 行為

- 只接受 `allow_username` 的私人聊天。
- 同一則 OpenMausBot `assistant_text` 在 Telegram 只佔一則，串流用 `editMessageText` 原地更新。
- 內文走 Bot API 10.1 **`sendRichMessage` / `editMessageText.rich_message`**（[Rich Message Formatting](https://core.telegram.org/bots/api#rich-message-formatting-options)）。`sendRichMessage` 失敗才退回 `parse_mode=HTML`。
- 有設定圖床時，回覆裡的本機圖片會複製到 `OMB_IMAGE_PUBLISH_DIR`，檔名是內容雜湊，再嵌成 `OMB_IMAGE_PUBLIC_BASE/<雜湊>.jpg`。來源必須在 `OMB_DATA_DIR` 裡，且是 10MB 以內的 jpg／png／gif／webp。progressive JPEG 會先轉成 baseline。圖床寫不進去，或沒有設定圖床時，改用 `sendPhoto`。
- thinking／工具期間送 `sendChatAction typing`。
- 圖片、語音、音訊，以及 PDF／Office／純文字會下載。不滿 12 秒的語音不在這裡轉，音檔交給 OpenMaus。12 秒以上才用本機 Whisper。第一次使用前執行 `sh stt/setup.sh`（權重放在 `$OMB_DATA_DIR/stt`）。執行緒數是 `OMB_STT_CPU_THREADS`，空白則為機器核心數減 2。
- 位置與即時位置只寫進 `telegram-context/<bot id>.json`。模型用 MCP `telegram` 的 `get_location` 讀。
- 有對到的 OpenMaus 訊息會帶 `replyToId`。助理回覆會 `reply` 回該則 Telegram 訊息。
- 照片若還留著 EXIF GPS，座標記在同一個脈絡檔。
- 助理回覆裡的 `<attached-file>`，或指向本機檔案的 Markdown 連結，會用 `sendDocument` 送回。允許的根目錄是 `OMB_FILE_ROOTS`（冒號分隔）。空白則是資料目錄與家目錄。

有些網路沒有到 `api.telegram.org` 的 IPv6 路由。`gateway.js` 會關掉 Node Happy Eyeballs 並優先 IPv4，避免 long poll 停在 `ETIMEDOUT`。

## Telegram 脈絡 MCP

在 OpenMaus 的 Plugins → MCP servers 貼上並啟用（名稱 `telegram`）。把下面兩個路徑換成 `.env` 裡的 `OMB_NODE_BIN` 與 `OMB_GATEWAY_DIR`：

```json
{
  "command": "/path/to/node",
  "args": ["/path/to/openmausbot-telegram-gateway/telegram-mcp.js"]
}
```

stdio，一行一個 JSON。環境變數不要用 `OMB_` 開頭，那是 OpenMaus 的保留字；資料目錄不是預設位置時才設 `TELEGRAM_CONTEXT_DIR`。貼上的伺服器預設是關的，Test 看到 `get_location`、`list_photo_locations`、`read_photo_exif` 後再打開。

## 目錄

- `gateway.js`、`refresh.js`、`telegram-mcp.js`：三個進入點。
- `src/`：訊息、媒體、圖床、語音的程式與測試。
- `stt/`：本機 Whisper worker。權重不在這裡。
- `deploy/`：systemd template，以及選擇性的圖床。

## 圖床

`deploy/image-host/nginx.conf` 只回應 32 位雜湊檔名，目錄不列出檔案。`compose.yml.in` 與 `omb-img.yml.in` 是模板。`refresh.js` 在目的路徑有填、且圖床變數齊全時才寫出檔案。compose 內容有變才會 `docker compose up -d`。把 `nginx.conf` 放在 compose 檔旁邊。

## 測試

```bash
npm test
```
