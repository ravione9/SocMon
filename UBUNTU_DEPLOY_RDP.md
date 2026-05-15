# Netpulse Web RDP — Ubuntu Deployment Runbook

This runbook covers two scenarios. Pick the one that matches what you need now:

- **Path A (5 minutes):** install only `guacd` on Ubuntu so your existing Windows Docker Desktop dev stack can finally do Web RDP. Use this if you just want to unblock dev testing today.
- **Path B (30 minutes):** deploy the full Netpulse stack on Ubuntu (the eventual prod target). Use this when you're ready to cut over.

Both paths assume Ubuntu 22.04 LTS or 24.04 LTS, with sudo access. Commands are copy-pasteable.

---

## Background — why we're not using Docker Desktop on Windows for guacd

Confirmed on 2026-05-10: Apache Guacamole's `libguac.so` SIGSEGVs on the Docker Desktop / WSL2 kernel during per-connection process init, before any RDP code runs. Reproducible NULL deref at a fixed offset across guacd 1.5.5 and 1.6.0. xfreerdp from inside the same container works fine — so it's not network, credentials, or FreeRDP, it's libguac × WSL2. On a real Linux kernel (bare metal, Hyper-V VM, EC2, etc.) it works.

---

## Pre-requisites for both paths

On the Ubuntu host:

```bash
sudo apt update
sudo apt -y install ca-certificates curl gnupg ufw
```

Confirm the host's IP — you'll need it later:

```bash
hostname -I | awk '{print $1}'
# Example output: 192.168.28.50
```

---

# Path A — guacd on Ubuntu, Netpulse stack stays on Windows

This is the fastest unblock. Netpulse's `server` container on your Windows laptop will reach out to `<UBUNTU_IP>:4822` instead of the local `guacd` container.

## A.1 — Install guacd on Ubuntu

```bash
sudo apt -y install guacd
```

That's it. The Ubuntu package is built against a stable FreeRDP and works out of the box.

## A.2 — Make guacd listen on all interfaces (not just localhost)

```bash
sudo sed -i 's/^bind_host = .*/bind_host = 0.0.0.0/' /etc/guacamole/guacd.conf
sudo systemctl restart guacd
sudo systemctl enable guacd
```

Verify it's listening:

```bash
ss -ltnp | grep 4822
# Expect: LISTEN  0.0.0.0:4822  ...  users:(("guacd",pid=...))
```

## A.3 — Open port 4822 to your dev laptop only

Don't expose 4822 to the internet — anyone who can reach it can drive RDP through your guacd. Restrict to your laptop's IP:

```bash
sudo ufw allow from <YOUR_LAPTOP_IP> to any port 4822 proto tcp
sudo ufw enable    # if not already enabled
sudo ufw status
```

## A.4 — Point Windows-side Netpulse at the Ubuntu guacd

On your **Windows laptop**, edit `netpulse/.env`:

```
GUACD_HOST=<UBUNTU_IP>
GUACD_PORT=4822
```

(Change `GUACD_HOST` from `guacd` to the Ubuntu IP. Leave `GUACD_PORT` as 4822.)

Comment out the entire `guacd:` service block in `docker-compose.yml` so Docker Desktop doesn't keep spawning the broken (WSL2) container. Or just leave it — it won't be reached because the server now talks to the Ubuntu IP.

Force-recreate so the new env is picked up:

```cmd
docker compose up -d --force-recreate --no-deps server
```

## A.5 — Verify

From your Windows laptop:

```cmd
docker exec netpulse-server node -e "var s=require('net').createConnection(4822,'<UBUNTU_IP>'); s.on('connect',function(){console.log('OK');process.exit(0)}); s.on('error',function(e){console.log('FAIL',e.code);process.exit(1)}); s.setTimeout(3000,function(){console.log('TIMEOUT');process.exit(2)})"
```

Expect `OK`. If `TIMEOUT` or `FAIL ECONNREFUSED` — go back and check ufw / bind_host.

Then click Connect on the Windows Server in Netpulse. In the Ubuntu guacd log:

```bash
sudo journalctl -u guacd -f
```

You should see `Loading keymap "base"`, `Loading keymap "en-us-qwerty"`, then display data flowing. Browser shows the Windows desktop.

If still failing — paste the journalctl output, it'll have the actual error this time (no more `libguac.so` NULL deref).

---

# Path B — Full Netpulse stack on Ubuntu

This is the prod deployment. Netpulse runs entirely on Ubuntu via `docker-compose.prod.yml`.

## B.1 — Install Docker

```bash
# Docker official APT repo
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Run docker without sudo
sudo usermod -aG docker $USER
newgrp docker
docker version
```

## B.2 — Get the Netpulse code

```bash
cd /opt
sudo git clone <YOUR_NETPULSE_GIT_URL> netpulse
sudo chown -R $USER:$USER netpulse
cd netpulse
```

## B.3 — Carry over the dev fixes from this debug session

Three files were modified during the May 2026 debug — make sure they're committed (or apply the diffs manually if you cloned an unmodified branch):

1. **`server/src/routes/rdp.js`** — three small fixes:
   - `rdpResizeMethod()` now returns `''` instead of invalid `'none'` (around line 209)
   - `disable-gfx` now env-gated: `process.env.RDP_DISABLE_GFX === 'true' ? 'true' : 'false'` instead of hardcoded `'true'` (around line 481)
   - `RDP_MINIMAL=1` env flag for emergency parameter bisection (around line 458)
   - The misleading log message `RDP session ready — streaming display` is now `guacamole handshake ready — FreeRDP backend starting` (around line 327)

2. **`nginx/nginx.prod.conf`** — added `location = /api/rdp/ws` block with WebSocket upgrade headers, buffering off, 86400s timeouts. Without this, RDP silently fails behind HTTPS nginx.

3. **`docker-compose.yml`** — guacd image pinned to `1.5.5` (was `1.6.0`). `docker-compose.prod.yml` separately should also use `1.5.5` for consistency — see below.

## B.4 — Configure `.env` for prod

Copy `server/.env.example` to `.env` at the repo root:

```bash
cp server/.env.example .env
nano .env
```

Critical changes from the dev defaults:

```bash
NODE_ENV=production

# Strong random secrets (generate fresh — never commit these)
JWT_SECRET=$(openssl rand -base64 48)             # paste the output
GUAC_CRYPT_KEY=$(openssl rand -base64 24)         # paste the output (NEW — required for prod)
MONGO_ROOT_PASSWORD=$(openssl rand -base64 24)    # paste the output
REDIS_PASSWORD=$(openssl rand -base64 24)         # paste the output

# These must match the ones above
MONGO_URI=mongodb://admin:<MONGO_ROOT_PASSWORD>@mongo:27017/netpulse?authSource=admin
REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379

# Browser-facing URL (the one users type into their browser)
CORS_ORIGIN=https://netpulse.lenskart.in       # adjust to your real hostname
                                                # comma-separated if multiple

# guacd is local in prod (runs as a sibling container on the same compose network)
GUACD_HOST=guacd
GUACD_PORT=4822

# Your existing API tokens — ROTATE these if Rescue@9897 / the SentinelOne JWT
# leaked into chat or terminal scrollback during dev
ZABBIX_API_TOKEN=...
SENTINELONE_API_TOKEN=...
ANTHROPIC_API_KEY=...
```

⚠️ **Rotate before this goes live:** the Windows admin password `Rescue@9897` and the SentinelOne JWT both appeared in plaintext during the dev debug session and are in shell histories / chat transcripts.

## B.5 — Pin guacd 1.5.5 in `docker-compose.prod.yml` too

```bash
sed -i 's|guacamole/guacd:1.6.0|guacamole/guacd:1.5.5|' docker-compose.prod.yml
```

Verify:
```bash
grep -n guacd docker-compose.prod.yml
```

## B.6 — TLS certificates for nginx

The HTTPS `nginx.prod.conf` expects certs at `/etc/nginx/certs/netpulse.crt` and `netpulse.key`. The compose file mounts `./certs/` into the nginx container. Put your real certs there:

```bash
mkdir -p certs
sudo cp /path/to/netpulse.crt certs/netpulse.crt
sudo cp /path/to/netpulse.key certs/netpulse.key
sudo chmod 644 certs/netpulse.crt
sudo chmod 600 certs/netpulse.key
```

For Let's Encrypt instead, install certbot first, get certs, and symlink:
```bash
sudo apt -y install certbot
sudo certbot certonly --standalone -d netpulse.lenskart.in
sudo ln -sf /etc/letsencrypt/live/netpulse.lenskart.in/fullchain.pem certs/netpulse.crt
sudo ln -sf /etc/letsencrypt/live/netpulse.lenskart.in/privkey.pem  certs/netpulse.key
```

You'll also need to update the prod compose nginx service to use this nginx.prod.conf instead of `docker/nginx/default.conf`. Edit the volumes section under the `nginx` service in `docker-compose.prod.yml`:

```yaml
volumes:
  - ./nginx/nginx.prod.conf:/etc/nginx/nginx.conf:ro    # not /etc/nginx/conf.d/default.conf
  - ./certs:/etc/nginx/certs:ro                          # add this line
  - ./client/dist:/usr/share/nginx/html:ro
```

And expose 443:
```yaml
ports:
  - "80:80"
  - "443:443"
```

## B.7 — Build the SPA

The prod compose mounts `./client/dist/` into nginx; you must build it first or you'll get a 403 from nginx:

```bash
cd client
npm ci
npm run build
cd ..
ls client/dist/index.html    # must exist before continuing
```

## B.8 — Open the firewall

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp        # don't lock yourself out of SSH
sudo ufw enable
sudo ufw status
```

Do NOT expose 5000, 4822, 27017, 6379 — they're internal to the compose network.

## B.9 — Start the stack

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

All five services should be `running`: nginx, server, guacd, mongo, redis.

## B.10 — Verify

```bash
# Health check (locally on the box)
curl -k https://localhost/health
# Expect: {"status":"ok","version":"1.0.0","ai":"claude"}

# guacd reachability from server container
docker compose -f docker-compose.prod.yml exec server \
  node -e "var s=require('net').createConnection(4822,'guacd'); s.on('connect',function(){console.log('OK');process.exit(0)}); s.on('error',function(e){console.log('FAIL',e.code);process.exit(1)}); s.setTimeout(3000,function(){console.log('TIMEOUT');process.exit(2)})"
# Expect: OK
```

Then from a browser, hit `https://netpulse.lenskart.in/` (or whatever you set as `CORS_ORIGIN`). Log in, navigate to a Windows device, click RDP. It should work.

## B.11 — Logs to watch

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f --tail=50

# Just the proxy + guacd interaction (the two we cared about during debug)
docker compose -f docker-compose.prod.yml logs -f server | grep '\[rdp-proxy'
docker compose -f docker-compose.prod.yml logs -f guacd
```

When RDP works, the guacd log will show:
```
INFO: Loading keymap "base"
INFO: Loading keymap "en-us-qwerty"
... display data flowing
```

When it doesn't, the actual reason will be in the guacd output (NLA failure, cert issue, etc.) — much more informative than the silent crash we got on WSL2.

---

# Rollback

## Path A rollback
On Windows, revert `.env`:
```
GUACD_HOST=guacd
```
And restart server: `docker compose up -d --force-recreate --no-deps server`. (Web RDP will go back to broken on Docker Desktop, but everything else works.)

## Path B rollback
```bash
cd /opt/netpulse
docker compose -f docker-compose.prod.yml down
# Stack down, data preserved in named volumes (mongo-data-prod, redis-data-prod)
```

To wipe data too: `docker compose -f docker-compose.prod.yml down -v` (irreversible).

---

# Common gotchas

**guacd starts but Netpulse can't reach it.** Path A: check ufw allowed your laptop's IP. Path B: check `GUACD_HOST=guacd` in `.env` (must match the service name in compose, not an IP).

**Browser shows 403 from nginx.** SPA wasn't built. Run `cd client && npm ci && npm run build` and restart nginx: `docker compose -f docker-compose.prod.yml restart nginx`.

**WebSocket fails with code 1006 / "tunnel closed".** nginx config doesn't have the `/api/rdp/ws` location with Upgrade headers. Path B uses `nginx/nginx.prod.conf` which now has it; if you customized, port the block.

**`CORS_ORIGIN` mismatch — REST call to `/api/rdp/session/...` fails before WS even opens.** Set `CORS_ORIGIN` to the exact scheme + host + port that users type into the browser. Add multiple values comma-separated if needed.

**RDP works but display is corrupted / black.** Try a different preset in the modal Settings (Med 16-bit vs Full 32-bit). If that doesn't fix it, set `RDP_DISABLE_GFX=true` in `.env` and restart the server container — disables the GFX channel as a fallback.

---

# What we are NOT doing on Ubuntu (and why)

- ❌ Not running guacd in WSL2 — that's the bug we're fixing.
- ❌ Not building guacd from source — Ubuntu's `apt install guacd` already gives us a working build.
- ❌ Not exposing port 4822 publicly — only your dev laptop (Path A) or the local compose network (Path B).
- ❌ Not using guacd 1.6.0 — confirmed crash same way as 1.5.5 on WSL2; on Linux either works, but 1.5.5 is the more battle-tested release.

---

# Reference: end state

After completing Path B, you have:
- Ubuntu host with Netpulse stack on docker-compose.prod.yml
- nginx fronting on 443 with TLS, redirecting 80→443
- `/api/rdp/ws` correctly upgraded to a WebSocket → server → guacd
- guacd 1.5.5 running as a sibling container, talked to over the internal network
- Mongo and Redis isolated, only accessible inside the compose network
- Per-user RDP credentials stored encrypted in Mongo (DeviceUserCredential collection)
- Sessions minted with AES-256-CBC tokens (15 min TTL) using your unique `GUAC_CRYPT_KEY`

Web RDP works. mstsc-equivalent functionality from the browser, no extra software on the user's machine.
