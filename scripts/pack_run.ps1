# DSS scenario pack: one command for every step. Windows PowerShell 5.1 or newer, Docker Desktop, the repo. See testdata\dss-scenarios\RUNBOOK.md.
#
#   .\scripts\pack_run.ps1 restore [-Dump <file>]   make the throwaway database from the dump
#   .\scripts\pack_run.ps1 dryrun  [-SelfTest]      check everything, write nothing (-SelfTest also runs the rolled-back history self-test)
#   .\scripts\pack_run.ps1 load                     replay the pack into the throwaway database (about 10 minutes)
#   .\scripts\pack_run.ps1 check                    compare the loaded database with the CSVs
#   .\scripts\pack_run.ps1 serve   [-StartVite]     one-off API on 127.0.0.1:8001 (+ Odoo), and the Vite command for port 5174
#   .\scripts\pack_run.ps1 images  [-ImagesArchive <file>]   put the 19 product pictures' files into the throwaway database's filestore (restore does it too)
#   .\scripts\pack_run.ps1 export-images            (owner only) pack those 19 files from the shop's filestore into backups\product-images-<date>.tgz for a classmate
#   .\scripts\pack_run.ps1 clean                    remove the throwaway database, its containers and its local files
#
# Safe by design: it only ever touches the database clothcraft_pack_20261026 (anything else is refused), never prints a password (the database
# password stays inside Docker's own .env handling), and can be rerun: a second load, or a restore over an existing database, is refused with a message.
param(
    [Parameter(Position = 0, Mandatory = $true)][ValidateSet('restore', 'dryrun', 'load', 'check', 'serve', 'images', 'export-images', 'clean')][string]$Command,
    [string]$Dump = '',
    [string]$ImagesArchive = '',
    [switch]$SelfTest,
    [switch]$StartVite,
    [string]$Database = 'clothcraft_pack_20261026'
)
$ErrorActionPreference = 'Continue'        # Windows PowerShell 5.1 turns any stderr line of a native command into an error under 'Stop'; every step checks $LASTEXITCODE itself
$env:COMPOSE_IGNORE_ORPHANS = 'True'       # silences docker compose's "orphan containers" warning (the dev stack has an api service this folder's base file lacks)
$DB = 'clothcraft_pack_20261026'
if ($Database -ne $DB) { Write-Host "STOP: this script only works on the database $DB (you asked for '$Database')." -ForegroundColor Red; exit 2 }

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Pack = Join-Path $Repo 'testdata\dss-scenarios'
$Local = Join-Path $Pack '_local'
$Loader = Join-Path $Repo 'scripts\pack_load.py'
$ApiUser = Join-Path $Repo 'scripts\create_api_user.py'
Set-Location $Repo

function Say($text) { Write-Host $text }
function Fail($text) { Write-Host "STOP: $text" -ForegroundColor Red; exit 1 }

function Test-Prerequisites {
    $null = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $?) { Fail 'Docker is not installed or not on the PATH. Install Docker Desktop and start it.' }
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { Fail 'Docker is installed but not running. Start Docker Desktop, wait until it says "running", and try again.' }
    $envFile = Join-Path $Repo '.env'
    if (-not (Test-Path $envFile)) { Fail 'There is no .env file in the repo folder. Copy .env.example to .env and put a password of your own after POSTGRES_PASSWORD= (keep the user name). Then try again.' }
    $text = Get-Content $envFile -Raw
    if ($text -notmatch '(?m)^POSTGRES_USER=\S+' -or $text -notmatch '(?m)^POSTGRES_PASSWORD=\S+') { Fail '.env must have a value after POSTGRES_USER= and after POSTGRES_PASSWORD= (it is never printed).' }
}

function Start-Db {
    docker compose up -d db 2>&1 | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
        docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -q' *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 2
    }
    Fail 'The database server did not become ready in 80 seconds. Run "docker compose logs db" and look at the last lines.'
}

# Run a SQL text through psql inside the db container (stdin, so quoting never matters); returns the output lines.
function Invoke-Sql([string]$Sql, [string]$OnDb = 'postgres') {
    $out = $Sql | docker compose exec -T db sh -c "psql -U `"`$POSTGRES_USER`" -d $OnDb -At -v ON_ERROR_STOP=1" 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "The database command failed: $out" }
    return , @($out | Where-Object { $_ -ne '' })       # the comma keeps a one-line answer an array (PowerShell would otherwise hand back a bare string)
}

function Test-DbExists { return ((Invoke-Sql "select 1 from pg_database where datname = '$DB'") -contains '1') }

function Get-Marker {
    if (-not (Test-DbExists)) { return $null }
    $r = Invoke-Sql "select value from ir_config_parameter where key = 'clothcraft.scenario_pack'" $DB
    if ($r.Count -gt 0) { return $r[0] } else { return $null }
}

# Run scripts\pack_load.py (or another script) inside `odoo shell` for the throwaway database. cmd's "<" hands the file over byte for byte.
function Invoke-OdooShell([string]$ScriptPath, [string]$Mode, [string]$ExtraMount = '', [string]$ExtraEnv = '') {
    $mount = "-v `"${Pack}:/mnt/pack`""
    if ($ExtraMount) { $mount = "$mount -v `"$ExtraMount`"" }
    $cmd = "docker compose run --rm --no-deps -T -e PYTHONDONTWRITEBYTECODE=1 -e PACK_MODE=$Mode $ExtraEnv $mount odoo odoo shell -d $DB --db-filter=`"^$DB`$`" --no-http < `"$ScriptPath`" 2>&1"
    $seen = @()
    cmd /c $cmd | ForEach-Object {
        if ($_ -match '^PACK (.*)$') { Write-Host $Matches[1]; $seen += $Matches[1] }
        elseif ($_ -match 'Traceback|Error') { Write-Host $_ -ForegroundColor Yellow }
    }
    return $seen
}

function Show-Result($lines, [string]$okText) {
    if (($lines | Where-Object { $_ -like "*$okText*" }).Count -gt 0) { Write-Host "`nDONE: $okText" -ForegroundColor Green; return }
    Write-Host "`nNOT DONE: the line '$okText' did not appear. Read the lines above (FAIL / STOP / UNEXPECTED) and see RUNBOOK.md, 'If it fails'." -ForegroundColor Red
    exit 1
}

# ---- product pictures. A dump holds the database rows but not the filestore, so the 19 product pictures (ir_attachment rows on product.template.image_1920) point at files
# that are missing from a restored database's filestore and the storefront shows broken images. scripts\pack_images.sh (run inside the Odoo container) only COPIES those
# exact files, from a source it checks first: the shop's own filestore on this computer (the owner), or a product-images-*.tgz made by 'export-images' (a classmate).
# It never overwrites a file, never touches any other file, checks every copy (Odoo names a file by the SHA-1 of its content) and does not touch the database.
$ImagesSql = "select store_fname from ir_attachment where res_model = 'product.template' and res_field = 'image_1920' and store_fname is not null order by 1"
$ImagesScript = Join-Path $Repo 'scripts'

function Restore-Images([string]$Archive) {
    $names = Invoke-Sql $ImagesSql $DB
    if ($names.Count -eq 0) { Say 'No product pictures are recorded in this database: nothing to restore.'; return }
    if (-not $Archive) {
        $found = Get-ChildItem (Join-Path $Repo 'backups') -Filter 'product-images-*.tgz' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
        if ($found) { $Archive = $found.FullName }
    }
    $mounts = @('-v', "${ImagesScript}:/mnt/scripts:ro")
    $env_ = @('-e', 'PICTURES_MODE=restore', '-e', "DB=$DB")
    if ($Archive) {
        if (-not (Test-Path $Archive)) { Fail "The pictures archive $Archive does not exist." }
        $mounts += @('-v', "$(Split-Path $Archive -Parent):/mnt/images:ro")
        $env_ += @('-e', "ARCHIVE=$(Split-Path $Archive -Leaf)")
        Say "Source: the archive $(Split-Path $Archive -Leaf)"
    } else {
        Say "Source: the shop's own filestore on this computer (clothcraft_shop)"
    }
    $out = $names | docker compose run --rm --no-deps -T @mounts @env_ --entrypoint sh odoo /mnt/scripts/pack_images.sh 2>&1
    $out | Where-Object { $_ -match '^(IMAGES|MISSING|BAD)' } | ForEach-Object { Say $_ }
    $summary = ($out | Where-Object { $_ -match '^IMAGES' } | Select-Object -Last 1)
    if (-not $summary) { Fail 'The pictures step did not run. Read the lines above.' }
    if ($summary -notmatch 'missing=0') {
        Say 'WARNING: some picture files could not be found, so those pictures will show as broken on the storefront.'
        Say '         The owner can make a pictures archive with   .\scripts\pack_run.ps1 export-images   and send it with the dump; put it in the backups folder and run   .\scripts\pack_run.ps1 images'
    }
}

function Export-Images {
    if (-not ((Invoke-Sql "select 1 from pg_database where datname = 'clothcraft_shop'") -contains '1')) { Fail 'There is no clothcraft_shop database on this computer: only the owner can export the pictures.' }
    $names = Invoke-Sql $ImagesSql 'clothcraft_shop'
    $backups = Join-Path $Repo 'backups'
    New-Item -ItemType Directory -Force $backups | Out-Null
    $file = 'product-images-' + (Get-Date -Format 'yyyyMMdd') + '.tgz'
    $out = $names | docker compose run --rm --no-deps -T -v "${ImagesScript}:/mnt/scripts:ro" -v "${backups}:/mnt/backups" -e PICTURES_MODE=export -e "ARCHIVE=$file" --entrypoint sh odoo /mnt/scripts/pack_images.sh 2>&1
    $out | Where-Object { $_ -match '^(EXPORTED|MISSING)' } | ForEach-Object { Say $_ }
    if (-not ($out | Where-Object { $_ -match '^EXPORTED' })) { Fail 'The pictures were not exported. Read the lines above.' }
    Say "DONE: backups\$file. Send it with the dump."
}

Test-Prerequisites

switch ($Command) {
    'restore' {
        Start-Db
        Say 'Building the Odoo image if it is not built yet (the first time takes a few minutes)...'
        docker compose build odoo 2>&1 | Select-Object -Last 2
        if (Test-DbExists) { Fail "The database $DB already exists. Nothing was changed. To start over: .\scripts\pack_run.ps1 clean   and then   .\scripts\pack_run.ps1 restore" }
        if (-not $Dump) {
            $found = Get-ChildItem (Join-Path $Repo 'backups') -Filter 'clothcraft_shop-postapply-s4e-*.dump' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
            if ($found) { $Dump = $found.FullName }
        }
        if (-not $Dump -or -not (Test-Path $Dump)) { Fail 'I need the dump file clothcraft_shop-postapply-s4e-20261026-150721.dump (about 6 MB). It is not in git on purpose. Ask the owner for it, put it in the backups folder of the repo, and run again (or pass -Dump <path>).' }
        Say "Restoring from $(Split-Path $Dump -Leaf) ..."
        $container = (docker compose ps -q db)
        docker cp $Dump "${container}:/tmp/pack.dump" | Out-Null
        docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" -E UTF8 -T template0 clothcraft_pack_20261026 && pg_restore -U "$POSTGRES_USER" -d clothcraft_pack_20261026 --no-owner --exit-on-error /tmp/pack.dump'
        if ($LASTEXITCODE -ne 0) { docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists clothcraft_pack_20261026'; Fail 'The restore failed and the half-made database was removed. Check that the file is the right dump and not damaged.' }
        docker compose exec -T db rm -f /tmp/pack.dump
        $sql = "select count(*) from pg_tables where schemaname='public'"
        $tables = (Invoke-Sql $sql $DB)[0]
        $rowsSql = Invoke-Sql "select string_agg(format('select count(*) from only public.%I', tablename), ' union all ') from pg_tables where schemaname='public'" $DB
        $counts = Invoke-Sql $rowsSql[0] $DB
        $rows = ($counts | ForEach-Object { [int]$_ } | Measure-Object -Sum).Sum
        Say "Restored: $tables tables, $rows rows (the expected dump has 573 tables and 59283 rows)."
        if ($tables -ne '573' -or $rows -ne 59283) { Say 'WARNING: different from the expected dump. The dry run will say whether it can be used.' }
        Say 'Restoring the product pictures (their files are not inside a dump)...'
        Restore-Images $ImagesArchive
        Say 'DONE: next step is   .\scripts\pack_run.ps1 dryrun'
    }
    'images' {
        Start-Db
        if (-not (Test-DbExists)) { Fail "The database $DB does not exist yet. Run   .\scripts\pack_run.ps1 restore   first." }
        Restore-Images $ImagesArchive
        Say 'DONE: images. Start the API with   .\scripts\pack_run.ps1 serve   and the pictures load.'
    }
    'export-images' {
        Start-Db
        Export-Images
    }
    'dryrun' {
        Start-Db
        if (-not (Test-DbExists)) { Fail "The database $DB does not exist yet. Run   .\scripts\pack_run.ps1 restore   first." }
        $marker = Get-Marker
        if ($marker) { Say "Nothing to rehearse: the pack is already in this database (marker: $marker). Use   .\scripts\pack_run.ps1 check   to compare it with the CSVs."; exit 0 }
        $lines = Invoke-OdooShell $Loader 'dryrun'
        Show-Result $lines 'DRY RUN PASSED'
        if ($SelfTest) { $lines = Invoke-OdooShell $Loader 'selftest'; Show-Result $lines 'SELFTEST PASSED' }
    }
    'load' {
        Start-Db
        if (-not (Test-DbExists)) { Fail "The database $DB does not exist yet. Run   .\scripts\pack_run.ps1 restore   first." }
        $marker = Get-Marker
        if ($marker) { Fail "The pack is already loaded here (marker: $marker). A second load is refused. To start over: .\scripts\pack_run.ps1 clean   then   restore   then   load" }
        Say 'Loading. This takes about 10 minutes; a progress line appears every 100 events. Do not close the window.'
        $lines = Invoke-OdooShell $Loader 'load'
        Show-Result $lines 'LOAD COMPLETE'
        Say "The two sign-in accounts are in testdata\dss-scenarios\_local\accounts.csv (a file only on this computer; open it yourself, nothing prints a password)."
    }
    'check' {
        Start-Db
        if (-not (Test-DbExists)) { Fail "The database $DB does not exist yet." }
        $lines = Invoke-OdooShell $Loader 'check'
        Show-Result $lines 'CHECK PASSED'
    }
    'serve' {
        Start-Db
        $marker = Get-Marker
        if (-not $marker -or -not $marker.StartsWith('loaded:')) { Fail 'The pack is not loaded yet (run load first).' }
        New-Item -ItemType Directory -Force $Local | Out-Null
        $apiEnv = Join-Path $Local 'api.env'
        if (-not (Test-Path $apiEnv)) {
            Say 'Making an API key for the throwaway database (written to _local\api.env, never printed)...'
            $null = Invoke-OdooShell $ApiUser 'selftest' "${Local}:/out" '-e API_KEY_OUT=/out/api.env'      # create_api_user.py ignores PACK_MODE
            if (-not (Test-Path $apiEnv)) { Fail 'The API key file was not made.' }
            Add-Content -Path $apiEnv -Value @('ODOO_URL=http://cc-pack-odoo:8069', "ODOO_DB=$DB", 'ALLOWED_ORIGINS=http://localhost:5174,http://127.0.0.1:5174', 'COOKIE_SECURE=false')
        }
        $net = (docker inspect (docker compose ps -q db) -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
        if (-not (docker ps -q -f name=^cc-pack-odoo$)) {
            docker rm -f cc-pack-odoo 2>&1 | Out-Null
            Say 'Starting Odoo for the throwaway database (container cc-pack-odoo)...'
            docker compose run -d --name cc-pack-odoo --no-deps -e PYTHONDONTWRITEBYTECODE=1 odoo odoo -d $DB --db-filter="^$DB`$" | Out-Null
        }
        Say 'Building the API image (first time only)...'
        docker build -q -t cc-pack-api:1 (Join-Path $Repo 'backend') | Out-Null
        if (-not (docker ps -q -f name=^cc-pack-api$)) {
            docker rm -f cc-pack-api 2>&1 | Out-Null
            docker run -d --name cc-pack-api --network $net --env-file $apiEnv -p 127.0.0.1:8001:8000 cc-pack-api:1 | Out-Null
        }
        $up = $false
        for ($i = 0; $i -lt 45 -and -not $up; $i++) {
            try { $up = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8001/api/catalogue/products' -TimeoutSec 5).StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 }
        }
        if (-not $up) { Fail 'The API did not answer in 90 seconds. Run "docker logs cc-pack-api" and "docker logs cc-pack-odoo" and read the last lines.' }
        Say 'The API answers on http://127.0.0.1:8001 (reads the throwaway database only).'
        # the pictures, asked through the real endpoint the storefront uses
        try {
            $items = (Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:8001/api/catalogue/products' -TimeoutSec 30).data.products
            $good = 0
            foreach ($p in $items) {
                try { if ((Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:8001' + $p.image) -TimeoutSec 30).StatusCode -eq 200) { $good++ } } catch { }
            }
            Say "Product pictures through the API: $good of $($items.Count) answer 200."
            if ($good -lt $items.Count) { Say 'Some pictures are missing: run   .\scripts\pack_run.ps1 images   (see RUNBOOK.md, "Product pictures").' }
        } catch { Say 'Could not check the product pictures through the API.' }
        $vite = "cd frontend; `$env:VITE_API='odoo'; `$env:VITE_PROXY_TARGET='http://127.0.0.1:8001'; npx vite --port 5174"
        if ($StartVite) {
            if (-not (Test-Path (Join-Path $Repo 'frontend\node_modules'))) { Fail 'Run "npm install" once inside the frontend folder first, then serve again.' }
            Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$Repo'; $vite"
            Say 'A second window started the Vite dev server. Open http://localhost:5174/admin in your browser.'
        } else {
            Say "In a SECOND PowerShell window, from the repo folder, run:`n    $vite`nthen open http://localhost:5174/admin"
        }
        Say 'Sign in with the accounts in testdata\dss-scenarios\_local\accounts.csv (Administrator at /admin, Inventory Staff at /staff).'
    }
    'clean' {
        Start-Db
        Say 'Removing the throwaway containers (by exact name)...'
        docker rm -f cc-pack-api cc-pack-odoo 2>&1 | Out-Null
        if (Test-DbExists) {
            Invoke-Sql "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB' and pid <> pg_backend_pid()" | Out-Null
            Invoke-Sql "drop database `"$DB`"" | Out-Null
            Say "Dropped the database $DB."
        } else { Say "The database $DB does not exist: nothing to drop." }
        $null = cmd /c "docker compose run --rm --no-deps -T --entrypoint sh odoo -c `"rm -rf /var/lib/odoo/.local/share/Odoo/filestore/$DB`" 2>&1"      # only this database's own folder
        if (Test-Path $Local) { Remove-Item -Recurse -Force $Local; Say 'Removed testdata\dss-scenarios\_local (the sign-in passwords, API key file and load log).' }
        Say 'DONE: clean. (The image cc-pack-api:1 stays; remove it with "docker rmi cc-pack-api:1" if you want the space.)'
    }
}
