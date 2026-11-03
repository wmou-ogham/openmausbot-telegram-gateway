# 公開設定

- [x] 帳號、bot id、路徑、圖床不再寫死在程式與 unit。來源是 `.env`，token 仍只在 `bots.csv`
- [x] `allow_username` 必填，沒有預設帳號
- [x] 圖床兩個變數缺一就不嵌入網址，改走 `sendPhoto`
- [x] systemd 與圖床檔由模板渲染；範例 CSV、README、測試資料不再帶某台機器的路徑
- [x] `node --test` 51 項通過。`node refresh.js` 換上新的 unit，已在跑的 instance 都重啟後回到 active，event stream 已連上。圖床檔與模板渲染結果相同，沒有重建 container。`/omb-img/` 仍是 404
- [x] 可分享的內容是目前這份樹。舊 commit 留在內部倉庫，不進新的遠端
- [ ] 操作者在 Telegram 上確認私訊與回覆仍正常
