# sudo

`journalctl` 不提權時會 `No journal files were opened due to insufficient permissions`。系統 unit 的安裝與重啟也要 root。

本次用 `sudo -n`（NOPASSWD）：

- `node refresh.js` 內部的 `sudo -n install`：把渲染後的 `openmausbot-telegram@.service` 寫進 `/etc/systemd/system/`。一般使用者不能放那個目錄，否則重開機後 long poll 不會起來。
- 同一個指令裡的 `daemon-reload`、`enable`、`disable`、`restart`：unit 內容或某一列的 token／帳號／bot id 變了才會重啟。沒變的列不重啟。
- `sudo -n journalctl -u openmausbot-telegram@<instance>`：確認 event stream 已連上。不提權就看不到這些日誌。
- 套用這次模板時，`node refresh.js` 內部的 `sudo -n install` 與 `systemctl restart`：新 unit 多了圖床環境變數，已在跑的 instance 要重讀才吃得到。圖床渲染結果與磁碟上的檔相同，所以沒有再跑 `docker compose up`。
