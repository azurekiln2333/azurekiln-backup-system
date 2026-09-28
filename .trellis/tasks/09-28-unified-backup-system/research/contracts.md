# Runtime/API Contract

## HTTP

JSON success bodies are direct; errors are {error:{code,message,details?}}. GET /api/auth/status => {initialized,authenticated,user,csrfToken,oidcEnabled,setupTokenRequired}. POST /api/auth/setup {username,password,setupToken?}; POST /api/auth/login {username,password}; POST /api/auth/logout. Authenticated writes require X-CSRF-Token. GET /api/auth/oidc/start and /api/auth/oidc/callback implement redirects.

GET /api/overview => {jobs,totalJobs,enabledJobs,lastSuccessAt,recentRuns,tools,storage}. GET /api/jobs => JobDTO[]. POST /api/jobs => JobDTO (201). GET/PATCH/DELETE /api/jobs/:id. POST /api/jobs/:id/run => RunDTO (202). GET /api/jobs/:id/archives => archive metadata array. GET /api/jobs/:id/archives/:runId/download?destinationId=... streams an archive.

GET /api/runs?jobId=&status=&limit=&offset= => {items:RunDTO[],total}, with matching filtered total. GET /api/runs/:id => RunDTO with logs. POST /api/runs/:id/cancel. GET/PATCH /api/settings => sanitized SettingsDTO; POST /api/settings/test-email {to?}.

GET /api/sources?path=&limit=&offset=&search= => {roots:string[],path:string|null,parent:string|null,total:number,entries:[{name,path,isDirectory,size?,modifiedAt?}]}. Authenticated, read-only. No path lists roots. Directory search is case-insensitive before pagination; optional limit 1–200, offset 0–1000000, search <=200 characters. Without limit, preserve the existing full source-picker listing. Directory size is null; file size is bytes; modifiedAt is ISO. Nearest configured root determines the parent boundary. Detailed contract: .trellis/spec/backend/backup-lifecycle.md.

GET /api/rclone/status => {available,configured,version,configPath,error?}; POST /api/rclone/import {sourceConfigPath?,configPassword?} validates candidate configuration before replacing private config and its sealed password; GET /api/rclone/remotes => [{name,type}]; GET /api/rclone/directories?remote=&path= => [{name,path}]; POST /api/rclone/directories {remote,path}; POST /api/rclone/test {remote,path}.

JobDTO follows shared/contracts.mjs plus id,createdAt,updatedAt,nextRunAt,lastRun and secret-configured flags. Reads omit actual secrets; blank secret updates retain values. RunDTO: id,jobId,jobName,type,status,phase,trigger,createdAt,startedAt,finishedAt,archiveName,archiveBytes,progress,error,warnings,targets,cleanupStatus,notificationStatus. Detail adds logs [{id,at,level,message}]. Unknown progress is null.

## Store (API agent)

createStore(config) returns synchronous methods listJobs({includeSecrets=false}={}), getJob(id,{includeSecrets=false}={}), saveJob(input,id?), deleteJob(id), updateJob(id,patch), getSettings({includeSecrets=false}={}), saveSettings(patch), createRun(job,trigger), getRun(id), updateRun(id,patch), appendLog(id,{level,message}), listRuns({jobId,limit=50,offset=0}={}) => {items,total}, listCompletedRuns(jobId), close(). Internal includeSecrets decrypts credentials for the runner. Do not persist decrypted run snapshots. API agent owns auth-specific store methods.

loadConfig() returns dataDir,sourceRoots,host,port,publicUrl,setupToken,rcloneBinary,sevenZipBinary,sqliteBinary,pgDumpBinary,mysqlDumpBinary,rcloneSourceConfigPath,rcloneConfigPath,tempDir,masterKeyPath. Defaults: DATA_DIR=.data, SOURCE_ROOTS=cwd/sources, BACKUP_HOST=127.0.0.1, BACKUP_PORT=3148. Resolve paths; create source root if absent; private staging remains outside sources.

## Executor (executor agent)

createRcloneService({config,getSettings,saveSettings}) returns async status(), importConfig(sourceConfigPath?,configPassword?), listRemotes(), listDirectories(remote,path), mkdir(remote,path), testConnection(remote,path), upload(localPath,remote,remotePath,{signal,onProgress}={}), stat(remote,path), remove(remote,path,{signal}={}), download(remote,path,localPath,{signal}={}), listArchives(job). getSettings returns internal decrypted settings; saveSettings seals generated/imported configuration passwords. Use owned job/run paths, not arbitrary remote deletion.

createBackupService({store,config,rclone}) returns enqueue(jobId,trigger='manual'), cancel(runId), shutdown(), getArchives(jobId), prepareDownload(jobId,runId,destinationId,{signal}={}) => {path,name,cleanup:async function}, health(), storage(). Enqueue immediately returns stored RunDTO while work continues in background. Read private task credentials with includeSecrets=true.

createScheduler({store,backupService}) returns start(),stop(),refresh(). Refresh after job changes; Croner schedules using persisted nextRunAt.

createApp({config?,store?,backupService?,rclone?,scheduler?}={}) returns {app,store,config,backupService,rclone,scheduler,close:async function}. app.mjs listens only when executed directly: node server/app.mjs.

## Evidence

Upstream: https://github.com/ttionya/vaultwarden-backup master d48c7d2ad9d022641dda1859294548d97d9c9a28. backup.sh uses SQLite .backup, pg_dump -Fc, mariadb-dump, optional config/RSA/attachments/Sends, 7-Zip, rclone copy, successful staging cleanup/retention. restore.sh recognizes db.*,config.*,rsakey.*,attachments.*,sends.*. Retain coverage/structure without copying eval-based credential commands or weak encryption defaults.

Main-site tokens: ../azurekiln-main-site/app/js/tailwind/tailwind.config.js. OIDC: ../azurekiln-oauth2/server.js:1297, README.md:78. Host Node v24.15.0; no rclone/7z/Docker initially discovered in PATH.
