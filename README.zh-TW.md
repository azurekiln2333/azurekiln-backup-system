# AzureKiln Backup

[简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md)

AzureKiln Backup 是供單一管理員使用的目錄、Vaultwarden 資料及系統設定備份管理系統。系統透過 rclone 管理遠端儲存，提供排程執行、加密封存、版本保留、電子郵件通知、執行紀錄及暫存空間管理。可選用 AzureKiln OAuth2/OIDC 登入。

## 功能範圍

| 模組 | 支援能力 |
| --- | --- |
| 備份來源 | 指定目錄；Vaultwarden SQLite、PostgreSQL、MySQL/MariaDB；new-api 全量資料；系統設定 |
| 封存與遠端 | tar.gz、AES-256 加密的 7z/ZIP；可獨立設定的 rclone 目的地 |
| 執行管理 | 手動與排程執行、遠端驗證、版本保留、下載及郵件通知 |
| 管理介面 | 唯讀掛載檔案瀏覽、執行日誌、暫存空間統計及本機封存清理 |

## 執行需求

本機執行需要 Node.js 24 或更新版本。目錄封存需要 tar；7z 與 ZIP 封存需要 7-Zip；遠端傳輸需要 rclone。Vaultwarden 的 SQLite 快照使用 Node.js 內建線上備份介面。PostgreSQL 與 MySQL/MariaDB 分別需要對應的資料庫用戶端。缺少工具時，管理介面會顯示實際狀態，不會以模擬備份替代。可透過 `RCLONE_BINARY`、`SEVEN_ZIP_BINARY`、`PG_DUMP_BINARY`、`MYSQL_DUMP_BINARY` 指定執行檔路徑。

## 本機部署

```powershell
npm install
npm run dev
```

開發介面通常位於 `http://127.0.0.1:5173`，API 使用連接埠 `16323`；若連接埠已被占用，開發指令會選擇可用連接埠。首次存取時建立管理員帳號。預設狀態目錄為 `.data/`，允許的來源目錄為 `sources/`。可在 `.env` 中設定 `SOURCE_ROOTS` 以授權其他路徑；Windows 使用分號分隔多個根目錄，Linux 使用冒號。其他本機設定請參閱 `.env.example`。

建置後可由 API 程序直接提供網頁介面：

```powershell
npm run check
npm test
npm run build
npm start
```

預設正式環境位址為 `http://127.0.0.1:16323`。

## Docker 部署

以 `.env.docker.example` 建立 `.env`，設定私密的 `SETUP_TOKEN` 或初始管理員憑證，將 `BACKUP_PUBLIC_URL` 設為部署來源網址，並依實際環境調整 `compose.yaml` 的唯讀來源掛載及 rclone 設定掛載。

```sh
docker compose up -d --build
```

範例 Compose 僅將服務發佈至主機的 `127.0.0.1:16323`；HTTPS 應由反向代理終止。容器以 root 執行，以讀取受限的來源及 rclone 設定檔。不需要 Docker socket。`/data` 是持久化的應用程式狀態，不得與 `/sources` 下掛載的來源路徑重疊。

使用 `RCLONE_CONFIG_DIR` 將既有 rclone 設定目錄唯讀掛載至 `/config`，再於「遠端儲存」頁面匯入 `/config/rclone.conf`。原始掛載保持唯讀；應用程式會在 `/data/rclone/` 儲存可寫入的私有副本，以保存更新後的 OAuth token，而不修改原始檔案。

## 掛載檔案瀏覽

「檔案管理」頁面只列出容器內已掛載且屬於 `SOURCE_ROOTS` 授權範圍的路徑。頁面支援階層導覽、上一層、目前目錄內不區分大小寫的名稱搜尋、每頁 100 項、重新整理，以及檔案大小與修改時間。瀏覽功能為唯讀；可選取目錄作為新備份任務的來源。不會顯示或追蹤符號連結。

例如，在 `compose.yaml` 中加入：

```yaml
- /www/wwwroot:/sources/websites:ro
- /srv/vaultwarden:/sources/vaultwarden:ro
```

設定 `SOURCE_ROOTS=/sources` 時，兩個目錄都會顯示。如只允許這兩個路徑，可使用 `SOURCE_ROOTS='["/sources/websites","/sources/vaultwarden"]'`。介面顯示的是容器內路徑。修改掛載或環境變數後，執行 `docker compose up -d` 重新建立服務。

## 備份行為

任務可以加上標籤（最多 10 個，例如 `mysql`、`正式環境`），任務清單可依標籤篩選，點選任務下的標籤也會篩選，搜尋同樣比對標籤。

新增目錄任務時勾選「批次新增」，來源目錄改為選擇父目錄，頁面列出其下的子目錄，勾選後一次建立多個任務，其餘設定全部相同。任務名稱依範本產生（`{folder}` 替換為子目錄名稱），每個遠端目標上傳至「儲存目錄/子目錄名稱」。例如父目錄 `/sources/mysql` 下有 `blog_azurekiln_cn`、`azurekiln_cn`，儲存目錄為 `backups/mysql`，便會建立兩個任務，分別上傳至 `backups/mysql/blog_azurekiln_cn` 與 `backups/mysql/azurekiln_cn`。已有任務的子目錄無法勾選；任一子目錄驗證失敗時整批都不建立。建立後各任務彼此獨立，修改需逐一編輯。批次新增也會自動把父目錄名稱填入標籤，讓這些任務在清單中聚成一組，儲存前可自行修改或刪除。

任務清單可依「標籤」「類型」或「來源父目錄」分組，也可不分組。分組標題顯示名稱、任務數量與失敗數量，點選標題即可摺疊或展開，工具列的「全部摺疊」「全部展開」一次處理所有分組。摺疊狀態與分組方式會被記住，重新整理後保持原樣；搜尋時所有分組自動展開，避免命中的任務藏在已摺疊的分組裡。分組與搜尋、啟用狀態篩選、標籤篩選同時生效，各分組數量依篩選後的結果顯示。

目錄任務可在「排程與通知」啟用檔案變動監聽。此功能預設關閉，會遞迴監聽所選目錄；檔案變動經過可設定的 1–300 秒合併時間（預設 5 秒）後，建立一次完整備份版本。備份執行期間的新變動會在目前執行結束後再觸發一次。排除規則同樣適用於監聽事件。暫停、刪除任務或關閉監聽後，便不再監聽該目錄；Vaultwarden 與系統設定任務不支援此選項。任務詳細資料會顯示監聽狀態及錯誤。

檔案監聽依賴作業系統事件。網路檔案系統、部分容器掛載及來源目錄暫時中斷時，可能漏掉變動；服務會定期嘗試重新連線，但無法補回所有中斷期間的變動。重要資料建議同時設定排程。經常變動的大型目錄宜延長合併時間。任務清單的「檔案監聽」開關可直接開關監聽，並保留監聽方式與合併時間。

監聽方式有兩種。「整個目錄」每次變動都完整封存並上傳。「僅新增和修改的檔案」在啟用時將現有檔案記錄為基準（依路徑、大小與修改時間），之後的監聽執行只打包新增或修改的檔案，產生 `任務名.incremental.7z` 之類的增量版本；封存內的 `incremental.*.tar` 包含這些檔案，`changes.*.json` 列出新增、修改與刪除的路徑。沒有新增或修改時，執行直接成功，不上傳也不寄送郵件；僅有刪除時，刪除會記錄於下一個增量版本。手動與排程執行一律為完整備份，並將基準重設為目前目錄。服務重新啟動後會對照基準補備份停機期間的變動。還原時先解壓最近的完整版本，再依時間順序解壓其後的增量版本，並依 `changes.*.json` 刪除檔案。保留策略的版本數與天數只計算完整版本；增量版本早於最早保留的完整版本時才會被清理，因此建議搭配排程完整備份。只比較大小與修改時間，內容改變但兩者皆未變的檔案不會被偵測。

目錄任務會先建立 tar 內容，以保留檔案系統中繼資料。未加密備份可使用 tar.gz；加密備份使用 AES-256 的 7z 或 ZIP，7z 也會加密檔名。7z 編輯器支援 LZMA2 或 LZMA、1 至 8 個執行緒，以及 8–256 MiB 字典。壓縮等級 7–9 的自動設定會使用 1 個執行緒及 32 MiB 字典，以降低記憶體壓力；較低等級使用 7-Zip 預設值。這些選項不適用於 ZIP 或 tar.gz。

版本資料夾與封存檔名支援 `{datetime}`（UTC）及 `{task}`。資料夾範本必須包含 `{datetime}`。典型遠端配置為 `destination/2026-09-28_11-24-18-123Z/task.7z`；同一資料夾中的 `complete.json` 記錄任務 ID、執行 ID、大小及 SHA-256。請勿手動移動或重新命名既有版本。排除規則支援一般路徑、`*` 及 `?`，不接受擴充 glob 語法。

Vaultwarden 任務支援 SQLite、PostgreSQL、MySQL/MariaDB。任務會建立一致的資料庫快照或匯出，並納入存在的 `config.json`、`rsa_key*`、`attachments`、`sends`。不存在的選用項目會記錄為略過；資料庫失敗則使任務失敗。封存內保留 `db.*`、`config.*`、`rsakey.*`、`attachments.*`、`sends.*` 等慣用名稱。

new-api 任務用於將 new-api 的整套持久化資料搬到另一台機器還原（不包含程式原始碼與 Docker 映像）。任務會匯出主資料库（SQLite 線上快照、MySQL `--single-transaction`、PostgreSQL `pg_dump`）及可選的獨立日誌庫（`LOG_SQL_DSN`；ClickHouse 只寫入手動匯出命令並記錄警報），收集必要的 `.env` 以及可選的 `docker-compose.yml`、systemd unit、反向代理設定與外掛腳本目錄，並打包資料目錄（自動排除 `new-api-body-cache`、`*.db-wal`、`*.db-shm`）。封存內的 `manifest.json` 記錄主庫/日誌庫引擎與庫名、逐表列數與內容雜湊、檔案雜湊、new-api 版本與警報；`RESTORE.md` 提供逐步還原與逐表驗証命令。關閉「包含 logs 表」時消耗與 tokens 歷史將缺失並在封存中標註。此類型強制使用 AES-256 加密的 7z 封存，因為 `.env` 內的 `CRYPTO_SECRET` 是解密頻道金鑰的唯一鑰匙，還原時必須原樣保留。

每次執行都會建立獨立的遠端版本並驗證上傳。明文暫存資料在封存驗證後清除。「系統設定 → 暫存檔案」的策略決定成功上傳後如何處理本機封存：預設為「立即清理」；選擇「手動清理」時，封存會保留到管理員於該頁逐份或全部清理。郵件傳送失敗不會改變成功的備份狀態，也不會阻止所選清理策略。失敗任務的暫存資料僅保留每項任務最新的一次，並受保留時間及暫存空間上限約束。遠端版本保留僅刪除系統記錄為該任務所有的完成版本。

設定頁會顯示暫存檔案總佔用、成功封存佔用、其他暫存檔案佔用及各份保留封存。手動保留的成功封存計入暫存空間上限，但不會由失敗檔案清掃程序自動刪除。容量不足時，新備份會失敗，必須先釋放空間或提高上限。切換回「立即清理」只影響之後的執行。匯出與壓縮每 250 毫秒檢查一次容量；兩次檢查之間仍可能短暫超出上限。服務重新啟動時會清除中斷任務留下的明文與資料庫憑證。

若手動保留未加密的 tar.gz 封存，本機副本也未加密。應限制對應用程式持久化目錄的存取，並在不再需要本機副本時清理。

## 登入與通知

使用 AzureKiln OAuth2 時，註冊機密用戶端，回呼網址為 `BACKUP_PUBLIC_URL/api/auth/oidc/callback`。設定 issuer、Client ID、Client Secret，以及管理員身分的精確 `sub`。授權碼流程使用 PKCE、state、nonce 與 ID Token 驗證，並將核准身分對應至既有管理員。

SMTP 設定支援 STARTTLS、隱含式 TLS 或未加密傳輸，並提供寄件者、多位收件者及測試郵件。每項任務可分別啟用開始、成功與失敗通知。通知狀態與備份狀態分開記錄。

MySQL/MariaDB 的「要求 TLS」也會驗證伺服器憑證。請提供可信任的憑證鏈或 CA 憑證；連線失敗時不會降級為明文。

## 還原與密鑰保管

從任務的版本清單下載封存，使用建立該版本時的密碼解密。目錄封存包含內層 tar。還原 Vaultwarden 時，依資料庫類型還原資料庫匯出及所含設定、RSA 金鑰、附件與 Sends。覆蓋正式資料前應先停止 Vaultwarden，並在獨立環境驗證封存。`pg_dump` 用戶端的主版本不得早於 PostgreSQL 伺服器。

資料庫快照本身是一致的，但執行期間變動的附件不保證與資料庫處於同一時間點。若需整體一致性，請安排維護時段。若 Vaultwarden 的部署檔案位於資料目錄之外，應另建目錄備份任務。

儲存的憑證會使用獨立密鑰加密。請備份持久化資料與 `.data/secret.key`（Docker 中為 `/data/secret.key`）；遺失原密鑰後無法復原已儲存的憑證。密碼變更只影響新封存，歷史版本仍需要原密碼。匯入的 rclone 憑證會在私有設定中加密，匯入失敗不會取代目前設定。僅應在完成實際還原驗證後，移除既有 `vaultwarden-backup` 容器。

## 系統設定備份與匯入

內建的「系統設定」任務預設停用。設定 rclone 目的地及 7z 密碼後，可手動執行或啟用排程。任務會建立 `state.sqlite` 線上快照，並納入 `secret.key`、目前使用的 `rclone.conf`，以及可讀取的部署 `.env` 和 `compose.yaml`。此封存一律使用 AES-256 加密的 7z；密碼應另外保管。

Compose 會將 `.env` 與 `compose.yaml` 唯讀掛載至 `/system-config/`。其他部署方式可設定 `SYSTEM_ENV_FILE` 與 `SYSTEM_COMPOSE_FILE`。來源資料及反向代理設定不會自動納入。

匯入時，以目前的管理員登入並上傳「系統設定」封存及其密碼。上傳檔案上限為 256 MiB，解壓後的設定上限為 2 GiB。系統驗證封存、摘要、SQLite 完整性與加密密鑰後，暫存於 `/data/system-restore-pending`。執行 `docker compose restart backup` 後才會套用。原狀態保存在 `/data/system-restore-previous-*` 以供復原。部署檔案會寫入 `/data/restored-deployment.env` 及 `/data/restored-compose.yaml` 供人工檢查；唯讀的主機掛載不會被覆寫。若使用外部 `BACKUP_MASTER_KEY`，重新啟動前必須將其設定為匯入封存對應的密鑰。

## 驗證

```powershell
npm run check
npm test
npm run build
npm run check:browser
```

瀏覽器驗證需要 Chromium，以及可用的 rclone 與封存工具。正式環境仍須分別驗證遠端儲存、郵件服務、資料庫連線及實際還原程序。
